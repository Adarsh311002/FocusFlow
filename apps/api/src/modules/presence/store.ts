import type { ChainableCommander, Redis } from 'ioredis';

import { redisTimeReplyToMs } from '../../platform/redis.js';
import { redisKeys } from '../../platform/redis-keys.js';

// Per-user presence (docs/architecture/focus-timing-protocol.md, "Presence"; approved
// Phase 3 decision 1). One entry per authenticated socket, tagged with the instance that
// serves it, in two sets kept in step:
//
//   user:{userId}:sockets          {instanceId}:{socketId}   "where is this user connected"
//   instance:{instanceId}:sockets  {userId}:{socketId}       "what does this instance serve"
//
// The reverse index lets dead-instance cleanup find exactly that instance's entries
// without scanning every user. "Online" means at least one entry on a live instance: a
// crashed instance's entries stay in Redis until the reconciler removes them, but they
// stop counting the moment its heartbeat is older than the TTL.
//
// Every write that can change whether a user is online runs in one MULTI together with
// Redis TIME and the heartbeats it is judged against, so "this removal took the user
// offline" and its timestamp are decided atomically (Phase 4A, H2).

export type SocketRef = { readonly userId: string; readonly socketId: string };

const userEntry = (instanceId: string, socketId: string): string => `${instanceId}:${socketId}`;
const instanceEntry = (userId: string, socketId: string): string => `${userId}:${socketId}`;

/** Splits `{a}:{b}` on the first colon (ids are UUIDs, socket ids never contain `:`). */
export const splitEntry = (entry: string): readonly [string, string] | undefined => {
  const index = entry.indexOf(':');
  if (index <= 0 || index === entry.length - 1) {
    return undefined;
  }
  return [entry.slice(0, index), entry.slice(index + 1)];
};

/**
 * Whether any of a user's entries belongs to an instance whose last heartbeat is within
 * the TTL at `nowMs` (Redis TIME). Entries of unknown or stale instances do not count.
 */
export const isOnlineAt = (
  entries: readonly string[],
  heartbeats: ReadonlyMap<string, number>,
  nowMs: number,
  ttlMs: number,
): boolean =>
  entries.some((entry) => {
    const instanceId = splitEntry(entry)?.[0];
    const heartbeat = instanceId === undefined ? undefined : heartbeats.get(instanceId);
    return heartbeat !== undefined && heartbeat >= nowMs - ttlMs;
  });

export type SyncPlan = {
  /** Live sockets missing from the reverse index. */
  readonly missing: readonly SocketRef[];
  /** Reverse-index members (`{userId}:{socketId}`) with no live socket behind them. */
  readonly stale: readonly string[];
};

/** Compares this instance's live sockets with its reverse index. */
export const planSync = (indexed: Iterable<string>, local: readonly SocketRef[]): SyncPlan => {
  const indexedEntries = new Set(indexed);
  const localEntries = new Set(
    local.map(({ userId, socketId }) => instanceEntry(userId, socketId)),
  );
  return {
    missing: local.filter(
      ({ userId, socketId }) => !indexedEntries.has(instanceEntry(userId, socketId)),
    ),
    stale: [...indexedEntries].filter((entry) => !localEntries.has(entry)),
  };
};

/** A user's presence from one atomic read, stamped with the Redis TIME it was read at. */
export type PresenceCheck = { readonly online: boolean; readonly checkedAtMs: number };

export type RemoveResult = {
  /** This call removed the entry (false when a sync or cleanup had already done so). */
  readonly removed: boolean;
  /** Redis TIME of the removal. */
  readonly removedAtMs: number;
  /** The user has no live socket left, judged in the same transaction as the removal. */
  readonly userOffline: boolean;
};

export type SyncResult = {
  readonly added: number;
  readonly removed: number;
  /** Users for whom this sync created an entry that did not exist. */
  readonly cameOnline: readonly string[];
  /** Users for whom this sync removed a stale entry and who are now offline. */
  readonly wentOffline: readonly string[];
  /** Redis TIME of the sync's write; `undefined` when there was nothing to write. */
  readonly syncedAtMs: number | undefined;
};

export type InstanceSnapshot = {
  /** The raw reverse-index members read, removed again by `dropInstance`. */
  readonly members: readonly string[];
  /** Users with an entry on the instance and no live socket on any live instance. */
  readonly offlineUsers: readonly string[];
  /** The instance's last heartbeat (Redis TIME), if it is still in the live set. */
  readonly lastHeartbeatMs: number | undefined;
  /** Redis TIME of the read. */
  readonly readAtMs: number;
};

export type PresenceStore = {
  readonly add: (ref: SocketRef) => Promise<void>;
  /** Removes one socket of this instance. */
  readonly remove: (ref: SocketRef) => Promise<RemoveResult>;
  readonly checkUser: (userId: string) => Promise<PresenceCheck>;
  /**
   * Makes this instance's entries match its live sockets: adds the missing ones and
   * removes the stale ones, in both sets. `readLocal` is called after the reverse index
   * has been read and the transaction is queued in the same synchronous step, so a
   * socket that disconnects concurrently is never re-added (its removal is either
   * already applied and the socket absent from `readLocal`, or queued after this write
   * on the same connection).
   */
  readonly sync: (readLocal: () => readonly SocketRef[]) => Promise<SyncResult>;
  /** Reads an instance's entries and judges its users, without changing anything. */
  readonly readInstance: (instanceId: string) => Promise<InstanceSnapshot>;
  /** Removes the given reverse-index members of an instance from both sets. */
  readonly dropInstance: (instanceId: string, members: readonly string[]) => Promise<void>;
};

type StoreDeps = {
  readonly redis: Redis;
  readonly instanceId: string;
  readonly instanceTtlMs: number;
};

/** Runs a MULTI and returns its replies, failing if the transaction or any command did. */
const execAll = async (transaction: ChainableCommander): Promise<unknown[]> => {
  const replies = await transaction.exec();
  if (replies === null) {
    throw new Error('the presence transaction was aborted');
  }
  return replies.map(([error, value]) => {
    if (error !== null) {
      throw error;
    }
    return value;
  });
};

const stringsReply = (reply: unknown): string[] => {
  if (
    !Array.isArray(reply) ||
    !reply.every((value: unknown): value is string => typeof value === 'string')
  ) {
    throw new Error('unexpected Redis reply: expected a list of strings');
  }
  return reply;
};

/** `ZRANGE … WITHSCORES` → instanceId → last heartbeat. */
const heartbeatsReply = (reply: unknown): Map<string, number> => {
  const heartbeats = new Map<string, number>();
  let member: string | undefined;
  for (const value of stringsReply(reply)) {
    if (member === undefined) {
      member = value;
    } else {
      heartbeats.set(member, Number(value));
      member = undefined;
    }
  }
  return heartbeats;
};

const distinct = (values: Iterable<string>): string[] => [...new Set(values)];

export const createPresenceStore = ({
  redis,
  instanceId,
  instanceTtlMs,
}: StoreDeps): PresenceStore => {
  const indexKey = redisKeys.instanceSockets(instanceId);

  /** Appends TIME and the heartbeats (2 replies) for judging users in this transaction. */
  const withClock = (transaction: ChainableCommander): ChainableCommander =>
    transaction.time().zrange(redisKeys.instances, '0', '-1', 'WITHSCORES');

  const judge = (
    [time, heartbeats]: readonly unknown[],
    userEntries: readonly unknown[],
  ): { nowMs: number; online: boolean[] } => {
    const nowMs = redisTimeReplyToMs(time);
    const beats = heartbeatsReply(heartbeats);
    return {
      nowMs,
      online: userEntries.map((entries) =>
        isOnlineAt(stringsReply(entries), beats, nowMs, instanceTtlMs),
      ),
    };
  };

  return {
    add: async ({ userId, socketId }) => {
      await execAll(
        redis
          .multi()
          .sadd(redisKeys.userSockets(userId), userEntry(instanceId, socketId))
          .sadd(indexKey, instanceEntry(userId, socketId)),
      );
    },

    remove: async ({ userId, socketId }) => {
      const replies = await execAll(
        withClock(
          redis
            .multi()
            .srem(redisKeys.userSockets(userId), userEntry(instanceId, socketId))
            .srem(indexKey, instanceEntry(userId, socketId)),
        ).smembers(redisKeys.userSockets(userId)),
      );
      const { nowMs, online } = judge(replies.slice(2, 4), replies.slice(4));
      return { removed: replies[0] === 1, removedAtMs: nowMs, userOffline: online[0] === false };
    },

    checkUser: async (userId) => {
      const replies = await execAll(
        withClock(redis.multi()).smembers(redisKeys.userSockets(userId)),
      );
      const { nowMs, online } = judge(replies.slice(0, 2), replies.slice(2));
      return { online: online[0] === true, checkedAtMs: nowMs };
    },

    sync: async (readLocal) => {
      const indexed = await redis.smembers(indexKey);
      // From here until `execAll` queues the transaction nothing may await: see `sync`.
      const { missing, stale } = planSync(indexed, readLocal());
      if (missing.length === 0 && stale.length === 0) {
        return { added: 0, removed: 0, cameOnline: [], wentOffline: [], syncedAtMs: undefined };
      }

      const transaction = redis.multi();
      let slot = 0;
      // Reply positions of the user-set writes: SADD/SREM answer 1 only when they changed it.
      const additions: { userId: string; slot: number }[] = [];
      for (const { userId, socketId } of missing) {
        transaction
          .sadd(redisKeys.userSockets(userId), userEntry(instanceId, socketId))
          .sadd(indexKey, instanceEntry(userId, socketId));
        additions.push({ userId, slot });
        slot += 2;
      }
      const removals: { userId: string; slot: number }[] = [];
      for (const entry of stale) {
        const ref = splitEntry(entry);
        if (ref !== undefined) {
          transaction.srem(redisKeys.userSockets(ref[0]), userEntry(instanceId, ref[1]));
          removals.push({ userId: ref[0], slot });
          slot += 1;
        }
      }
      if (stale.length > 0) {
        // Malformed members are dropped from the index too.
        transaction.srem(indexKey, ...stale);
        slot += 1;
      }
      const clockSlot = slot;
      const staleUsers = distinct(removals.map(({ userId }) => userId));
      withClock(transaction);
      for (const userId of staleUsers) {
        transaction.smembers(redisKeys.userSockets(userId));
      }

      const replies = await execAll(transaction);
      const { nowMs, online } = judge(
        replies.slice(clockSlot, clockSlot + 2),
        replies.slice(clockSlot + 2),
      );
      const added = additions.filter(({ slot: at }) => replies[at] === 1);
      const removed = removals.filter(({ slot: at }) => replies[at] === 1);
      const removedUsers = new Set(removed.map(({ userId }) => userId));
      return {
        added: added.length,
        removed: removed.length,
        cameOnline: distinct(added.map(({ userId }) => userId)),
        wentOffline: staleUsers.filter(
          (userId, index) => removedUsers.has(userId) && online[index] === false,
        ),
        syncedAtMs: nowMs,
      };
    },

    readInstance: async (targetId) => {
      const [members, score] = await execAll(
        redis
          .multi()
          .smembers(redisKeys.instanceSockets(targetId))
          .zscore(redisKeys.instances, targetId),
      );
      const raw = stringsReply(members);
      const users = distinct(
        raw.map((entry) => splitEntry(entry)?.[0]).filter((userId) => userId !== undefined),
      );
      const transaction = withClock(redis.multi());
      for (const userId of users) {
        transaction.smembers(redisKeys.userSockets(userId));
      }
      const replies = await execAll(transaction);
      const { nowMs, online } = judge(replies.slice(0, 2), replies.slice(2));
      return {
        members: raw,
        offlineUsers: users.filter((_userId, index) => online[index] === false),
        lastHeartbeatMs: typeof score === 'string' ? Number(score) : undefined,
        readAtMs: nowMs,
      };
    },

    dropInstance: async (targetId, members) => {
      if (members.length === 0) {
        return;
      }
      const transaction = redis.multi();
      for (const entry of members) {
        const ref = splitEntry(entry);
        if (ref !== undefined) {
          transaction.srem(redisKeys.userSockets(ref[0]), userEntry(targetId, ref[1]));
        }
      }
      // Only the members that were read: an entry added since (an instance wrongly
      // declared dead keeps serving) stays, and the set disappears once empty.
      transaction.srem(redisKeys.instanceSockets(targetId), ...members);
      await execAll(transaction);
    },
  };
};
