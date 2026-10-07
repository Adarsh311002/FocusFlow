import type { Logger } from 'pino';

import type { AppServer, AppSocket } from '../realtime/types.js';
import type { PresenceCheck, PresenceStore, SocketRef } from './store.js';

/**
 * Why a user stopped being online: their last socket closed (or their instance shut down
 * cleanly), a sync found a socket whose disconnect was never recorded, or the instance
 * serving it died.
 */
export type OfflineReason = 'disconnect' | 'missed_disconnect' | 'instance_dead';

/** Why an instance's entries are removed: its own clean shutdown, or the reconciler. */
export type InstanceRemovalReason = 'disconnect' | 'instance_dead';

/**
 * A hint, never a decision (Phase 4A, H2): it can be missed (a crash or failed handler),
 * repeated (dead-instance cleanup reports again after a crash, always with the same
 * `disconnectedAtMs`), or stale (the user may already be back on another instance).
 * Consumers re-check `checkUser` before acting, and collapse repeats by
 * `(userId, disconnectedAtMs)`.
 */
export type UserOfflineEvent = {
  readonly userId: string;
  readonly reason: OfflineReason;
  /**
   * Redis TIME (ms): of the removal (`disconnect`); of the sync that detected it
   * (`missed_disconnect`, the real moment is unknown and earlier); the instance's last
   * heartbeat (`instance_dead`).
   */
  readonly disconnectedAtMs: number;
};

export type UserOfflineHandler = (event: UserOfflineEvent) => Promise<void> | void;
/** Also a hint: the user has a newly recorded socket. */
export type UserOnlineHandler = (userId: string) => Promise<void> | void;

export type SyncSummary = { readonly added: number; readonly removed: number };

export type Presence = {
  /** Registers an authenticated socket and removes it again on disconnect. */
  readonly track: (socket: AppSocket) => void;
  readonly isUserOnline: (userId: string) => Promise<boolean>;
  /** The authoritative check: whether the user is online now, with the Redis TIME read. */
  readonly checkUser: (userId: string) => Promise<PresenceCheck>;
  /** Runs when a user's last live socket goes away (a hint; see `UserOfflineEvent`). */
  readonly onUserOffline: (handler: UserOfflineHandler) => void;
  /** Runs when a socket of a user is newly recorded (connect, or a sync re-adding it). */
  readonly onUserOnline: (handler: UserOnlineHandler) => void;
  /**
   * Makes this instance's presence match its live sockets, in both directions. Runs on
   * every heartbeat and after a reconnect, an epoch change or a rejoin. Single-flight: a
   * request during a running sync is served by one more sync after it.
   */
  readonly syncLocal: () => Promise<SyncSummary>;
  /** Removes an instance's entries: this one on clean shutdown, a dead one via the reconciler. */
  readonly removeInstance: (instanceId: string, reason: InstanceRemovalReason) => Promise<void>;
};

type PresenceDeps = {
  readonly store: PresenceStore;
  /** This instance's connected sockets, read synchronously (see `PresenceStore.sync`). */
  readonly listLocalSockets: () => readonly SocketRef[];
  readonly logger: Logger;
};

/**
 * The sockets in the default namespace's live map. Socket.IO adds a socket before its
 * `connection` event and removes it in the same synchronous step that emits
 * `disconnect`, so the map and the queued presence writes never disagree.
 */
export const localSocketRefs = (io: AppServer): SocketRef[] =>
  Array.from(io.of('/').sockets.values(), (socket) => ({
    userId: socket.data.userId,
    socketId: socket.id,
  }));

export const createPresence = ({ store, listLocalSockets, logger }: PresenceDeps): Presence => {
  const offlineHandlers: UserOfflineHandler[] = [];
  const onlineHandlers: UserOnlineHandler[] = [];

  const userWentOffline = async (event: UserOfflineEvent): Promise<void> => {
    logger.debug(event, 'User went offline');
    for (const handler of offlineHandlers) {
      try {
        await handler(event);
      } catch (error) {
        logger.error({ err: error, userId: event.userId }, 'User-offline handler failed');
      }
    }
  };

  const userCameOnline = async (userId: string): Promise<void> => {
    for (const handler of onlineHandlers) {
      try {
        await handler(userId);
      } catch (error) {
        logger.error({ err: error, userId }, 'User-online handler failed');
      }
    }
  };

  // Presence writes are best effort: a Redis failure here is logged, never surfaced to
  // the socket, and repaired by the next sync (at the latest one heartbeat later).
  const track = (socket: AppSocket): void => {
    const ref = { userId: socket.data.userId, socketId: socket.id };
    store.add(ref).then(
      () => userCameOnline(ref.userId),
      (error: unknown) => {
        logger.warn({ err: error, userId: ref.userId }, 'Could not record socket presence');
      },
    );
    socket.on('disconnect', () => {
      store.remove(ref).then(
        // Only the path that actually removed the entry reports it; when a sync got
        // there first, it reported (as `missed_disconnect`).
        ({ removed, removedAtMs, userOffline }) =>
          removed && userOffline
            ? userWentOffline({
                userId: ref.userId,
                reason: 'disconnect',
                disconnectedAtMs: removedAtMs,
              })
            : undefined,
        (error: unknown) => {
          logger.warn({ err: error, userId: ref.userId }, 'Could not remove socket presence');
        },
      );
    });
  };

  const runSync = async (): Promise<SyncSummary> => {
    const result = await store.sync(listLocalSockets);
    for (const userId of result.cameOnline) {
      await userCameOnline(userId);
    }
    const syncedAtMs = result.syncedAtMs;
    if (syncedAtMs !== undefined) {
      for (const userId of result.wentOffline) {
        await userWentOffline({
          userId,
          reason: 'missed_disconnect',
          disconnectedAtMs: syncedAtMs,
        });
      }
    }
    if (result.added > 0 || result.removed > 0) {
      logger.info(
        { added: result.added, removed: result.removed },
        'Synchronised local socket presence',
      );
    }
    return { added: result.added, removed: result.removed };
  };

  let syncing: Promise<SyncSummary> | undefined;
  let queued: Promise<SyncSummary> | undefined;
  const syncLocal = (): Promise<SyncSummary> => {
    if (syncing === undefined) {
      syncing = runSync().finally(() => {
        syncing = undefined;
      });
      return syncing;
    }
    // The running sync may have read the sockets before this request's cause (a
    // reconnect, a rejoin): run once more after it, shared by every request meanwhile.
    queued ??= syncing
      .catch(() => undefined)
      .then(() => {
        queued = undefined;
        return syncLocal();
      });
    return queued;
  };

  return {
    track,
    isUserOnline: async (userId) => (await store.checkUser(userId)).online,
    checkUser: store.checkUser,
    onUserOffline: (handler) => {
      offlineHandlers.push(handler);
    },
    onUserOnline: (handler) => {
      onlineHandlers.push(handler);
    },
    syncLocal,
    removeInstance: async (instanceId, reason) => {
      const snapshot = await store.readInstance(instanceId);
      const disconnectedAtMs =
        reason === 'instance_dead'
          ? (snapshot.lastHeartbeatMs ?? snapshot.readAtMs)
          : snapshot.readAtMs;
      // Reported before the entries are removed: if this run dies in between, the next
      // run finds them again and reports again, with the same last-heartbeat time.
      for (const userId of snapshot.offlineUsers) {
        await userWentOffline({ userId, reason, disconnectedAtMs });
      }
      await store.dropInstance(instanceId, snapshot.members);
    },
  };
};
