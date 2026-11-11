import type { Redis } from 'ioredis';

import { redisKeys } from '../../platform/redis-keys.js';

// Fixed-window rate limits (M7, M8, F6) with a counter per action and user:
// `ff:ratelimit:{action}:{userId}`. One transaction runs `SET key 0 PX window NX` (creates
// the counter with its expiry only when it is absent) and `INCR key`, so a crash between
// the two can never leave a counter that lives forever. Unlike `PEXPIRE … NX` this form
// also works on Redis 6.

export type RateRule = {
  readonly action: string;
  readonly limit: number;
  readonly windowMs: number;
};

/** Room chat: 10 messages per 10 seconds per user (M8). */
export const CHAT_RATE: RateRule = { action: 'chat', limit: 10, windowMs: 10_000 };
/** Knocks: 5 per minute per user (M7). */
export const KNOCK_RATE: RateRule = { action: 'knock', limit: 5, windowMs: 60_000 };
/** Joining a room: 30 per 10 seconds per user (F6); a reconnect storm stays well inside. */
export const JOIN_RATE: RateRule = { action: 'join', limit: 30, windowMs: 10_000 };
/** Cancelling a knock: 10 per minute per user (F6). */
export const KNOCK_CANCEL_RATE: RateRule = { action: 'knock-cancel', limit: 10, windowMs: 60_000 };

/** Timer commands: 20 per 10 seconds per user (RT5). */
/** Opt-in and opt-out over REST (Phase 8): each toggle fans out to the whole room. */
export const ROOM_FOCUS_RATE: RateRule = { action: 'room-focus', limit: 10, windowMs: 10_000 };

export const TIMER_RATE: RateRule = { action: 'timer', limit: 20, windowMs: 10_000 };

export type RateLimiter = {
  /** Counts one attempt; `true` while the user is within the limit. */
  readonly consume: (rule: RateRule, userId: string) => Promise<boolean>;
};

export const createRateLimiter = (redis: Redis): RateLimiter => ({
  consume: async (rule, userId) => {
    const key = redisKeys.rateLimit(rule.action, userId);
    const replies = await redis.multi().set(key, '0', 'PX', rule.windowMs, 'NX').incr(key).exec();
    const count = replies?.[1]?.[1];
    const failure = replies?.[0]?.[0] ?? replies?.[1]?.[0];
    if (
      replies === null ||
      (failure !== null && failure !== undefined) ||
      typeof count !== 'number'
    ) {
      throw new Error('the rate limit transaction failed');
    }
    return count <= rule.limit;
  },
});
