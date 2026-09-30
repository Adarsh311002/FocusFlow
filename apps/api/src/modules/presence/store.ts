import type { Redis } from 'ioredis';

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

export type PresenceStore = {
  readonly add: (ref: SocketRef) => Promise<void>;
  /** Removes one socket; reports whether the user now has no live socket anywhere. */
  readonly remove: (ref: SocketRef) => Promise<{ readonly userOffline: boolean }>;
  readonly isUserOnline: (userId: string) => Promise<boolean>;
  /**
   * Removes every entry of one instance (its clean shutdown, or the reconciler after it
   * died) and reports each affected user and whether they are now offline.
   */
  readonly removeInstance: (
    instanceId: string,
  ) => Promise<readonly { readonly userId: string; readonly userOffline: boolean }[]>;
};

type StoreDeps = {
  readonly redis: Redis;
  readonly instanceId: string;
  readonly instanceTtlMs: number;
};

export const createPresenceStore = ({
  redis,
  instanceId,
  instanceTtlMs,
}: StoreDeps): PresenceStore => {
  const isUserOnline = async (userId: string): Promise<boolean> => {
    const entries = await redis.smembers(redisKeys.userSockets(userId));
    const instanceIds = [
      ...new Set(entries.map((entry) => splitEntry(entry)?.[0]).filter((id) => id !== undefined)),
    ];
    if (instanceIds.length === 0) {
      return false;
    }
    const replies = await redis
      .pipeline()
      .time()
      .zmscore(redisKeys.instances, ...instanceIds)
      .exec();
    const [time, scores] = replies ?? [];
    if (time === undefined || scores === undefined || time[0] !== null || scores[0] !== null) {
      throw new Error('the presence liveness check failed');
    }
    const cutoffMs = redisTimeReplyToMs(time[1]) - instanceTtlMs;
    const heartbeats: unknown = scores[1];
    return (
      Array.isArray(heartbeats) &&
      heartbeats.some((score: unknown) => score !== null && Number(score) >= cutoffMs)
    );
  };

  return {
    add: async ({ userId, socketId }) => {
      await redis
        .multi()
        .sadd(redisKeys.userSockets(userId), userEntry(instanceId, socketId))
        .sadd(redisKeys.instanceSockets(instanceId), instanceEntry(userId, socketId))
        .exec();
    },

    remove: async ({ userId, socketId }) => {
      await redis
        .multi()
        .srem(redisKeys.userSockets(userId), userEntry(instanceId, socketId))
        .srem(redisKeys.instanceSockets(instanceId), instanceEntry(userId, socketId))
        .exec();
      return { userOffline: !(await isUserOnline(userId)) };
    },

    isUserOnline,

    removeInstance: async (deadInstanceId) => {
      const indexKey = redisKeys.instanceSockets(deadInstanceId);
      const members = await redis.smembers(indexKey);
      const refs = members.map(splitEntry).filter((ref) => ref !== undefined);

      const transaction = redis.multi();
      for (const [userId, socketId] of refs) {
        transaction.srem(redisKeys.userSockets(userId), userEntry(deadInstanceId, socketId));
      }
      transaction.del(indexKey);
      await transaction.exec();

      const affected = [...new Set(refs.map(([userId]) => userId))];
      const results = [];
      for (const userId of affected) {
        results.push({ userId, userOffline: !(await isUserOnline(userId)) });
      }
      return results;
    },
  };
};
