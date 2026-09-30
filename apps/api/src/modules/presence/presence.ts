import type { Logger } from 'pino';

import type { AppServer, AppSocket } from '../realtime/types.js';
import type { PresenceStore } from './store.js';

/** Why a user stopped being online: their last socket closed, or its instance died. */
export type OfflineReason = 'disconnect' | 'instance_dead';

export type UserOfflineHandler = (userId: string, reason: OfflineReason) => Promise<void> | void;

export type Presence = {
  /** Registers an authenticated socket and removes it again on disconnect. */
  readonly track: (socket: AppSocket) => void;
  readonly isUserOnline: (userId: string) => Promise<boolean>;
  /**
   * Seam for Phase 4: runs when a user's last live socket goes away. Phase 3 only logs
   * the transition; solo-session grace attaches here later.
   */
  readonly onUserOffline: (handler: UserOfflineHandler) => void;
  /** Re-adds every socket this instance serves (after Redis lost data or reconnected). */
  readonly reassertLocal: () => Promise<void>;
  /** Removes an instance's entries: this one on clean shutdown, a dead one via the reconciler. */
  readonly removeInstance: (instanceId: string, reason: OfflineReason) => Promise<void>;
};

type PresenceDeps = {
  readonly store: PresenceStore;
  readonly io: AppServer;
  readonly logger: Logger;
};

export const createPresence = ({ store, io, logger }: PresenceDeps): Presence => {
  const offlineHandlers: UserOfflineHandler[] = [];

  const userWentOffline = async (userId: string, reason: OfflineReason): Promise<void> => {
    logger.debug({ userId, reason }, 'User went offline');
    for (const handler of offlineHandlers) {
      try {
        await handler(userId, reason);
      } catch (error) {
        logger.error({ err: error, userId }, 'User-offline handler failed');
      }
    }
  };

  // Presence is best effort: a Redis failure here is logged, never surfaced to the
  // socket, and repaired by the next re-assertion (reconnect or epoch recovery).
  const track = (socket: AppSocket): void => {
    const ref = { userId: socket.data.userId, socketId: socket.id };
    store.add(ref).catch((error: unknown) => {
      logger.warn({ err: error, userId: ref.userId }, 'Could not record socket presence');
    });
    socket.on('disconnect', () => {
      store.remove(ref).then(
        ({ userOffline }) => (userOffline ? userWentOffline(ref.userId, 'disconnect') : undefined),
        (error: unknown) => {
          logger.warn({ err: error, userId: ref.userId }, 'Could not remove socket presence');
        },
      );
    });
  };

  return {
    track,
    isUserOnline: store.isUserOnline,
    onUserOffline: (handler) => {
      offlineHandlers.push(handler);
    },
    reassertLocal: async () => {
      const sockets = await io.local.fetchSockets();
      for (const socket of sockets) {
        await store.add({ userId: socket.data.userId, socketId: socket.id });
      }
      logger.info({ sockets: sockets.length }, 'Re-asserted local socket presence');
    },
    removeInstance: async (instanceId, reason) => {
      const affected = await store.removeInstance(instanceId);
      for (const { userId, userOffline } of affected) {
        if (userOffline) {
          await userWentOffline(userId, reason);
        }
      }
    },
  };
};
