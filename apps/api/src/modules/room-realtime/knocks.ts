import type { Redis } from 'ioredis';

import { redisTimeReplyToMs } from '../../platform/redis.js';
import { redisKeys } from '../../platform/redis-keys.js';

// Pending knocks (M7): a sorted set per room, the requester's userId scored by the moment
// the knock expires (Redis TIME + KNOCK_TTL_MS). A knock is pending only while its score
// is in the future, so an expired entry never counts even before it is pruned; entries
// are pruned whenever the set is read.

export type PendingKnock = { readonly userId: string; readonly expiresAtMs: number };

export type KnockStore = {
  /** Adds the knock, or refreshes it (a repeated knock restarts its expiry). */
  readonly add: (roomId: string, userId: string) => Promise<number>;
  /** Removes the knock; whether an entry (even an expired one) existed. */
  readonly remove: (roomId: string, userId: string) => Promise<boolean>;
  readonly isPending: (roomId: string, userId: string) => Promise<boolean>;
  /** Unexpired knocks, oldest expiry first; expired ones are pruned. */
  readonly list: (roomId: string) => Promise<PendingKnock[]>;
};

const execAll = async (transaction: ReturnType<Redis['multi']>): Promise<unknown[]> => {
  const replies = await transaction.exec();
  if (replies === null) {
    throw new Error('the knock transaction was aborted');
  }
  return replies.map(([error, value]) => {
    if (error !== null) {
      throw error;
    }
    return value;
  });
};

export const createKnockStore = (redis: Redis, ttlMs: number): KnockStore => ({
  add: async (roomId, userId) => {
    const expiresAtMs = redisTimeReplyToMs(await redis.time()) + ttlMs;
    const key = redisKeys.roomKnocks(roomId);
    // The set's own expiry follows the newest knock, which outlives every older one.
    await execAll(redis.multi().zadd(key, expiresAtMs, userId).pexpire(key, ttlMs));
    return expiresAtMs;
  },

  remove: async (roomId, userId) => (await redis.zrem(redisKeys.roomKnocks(roomId), userId)) === 1,

  isPending: async (roomId, userId) => {
    const [time, score] = await execAll(
      redis.multi().time().zscore(redisKeys.roomKnocks(roomId), userId),
    );
    return typeof score === 'string' && Number(score) > redisTimeReplyToMs(time);
  },

  list: async (roomId) => {
    const key = redisKeys.roomKnocks(roomId);
    const nowMs = redisTimeReplyToMs(await redis.time());
    const [, entries] = await execAll(
      redis.multi().zremrangebyscore(key, '-inf', nowMs).zrange(key, '0', '-1', 'WITHSCORES'),
    );
    if (!Array.isArray(entries)) {
      throw new Error('unexpected Redis reply: expected a list');
    }
    const knocks: PendingKnock[] = [];
    for (let index = 0; index + 1 < entries.length; index += 2) {
      knocks.push({ userId: String(entries[index]), expiresAtMs: Number(entries[index + 1]) });
    }
    return knocks;
  },
});
