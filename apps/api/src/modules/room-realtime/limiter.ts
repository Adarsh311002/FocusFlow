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

/** Every HTTP request of one client address, outside the health checks (Phase 9). */
export const HTTP_GLOBAL_RATE: RateRule = { action: 'http', limit: 600, windowMs: 60_000 };
/** Login attempts per client address: 10 per minute (credential guessing). */
export const LOGIN_RATE: RateRule = { action: 'auth-login', limit: 10, windowMs: 60_000 };
/** Sign-ups per client address: 10 per hour (account farming). */
export const SIGNUP_RATE: RateRule = { action: 'auth-signup', limit: 10, windowMs: 3_600_000 };
/** Refreshes per client address: 60 per minute (a few tabs and reloads stay far inside). */
export const REFRESH_RATE: RateRule = { action: 'auth-refresh', limit: 60, windowMs: 60_000 };
/** Room creation per user: 10 per hour. */
export const ROOM_CREATE_RATE: RateRule = {
  action: 'room-create',
  limit: 10,
  windowMs: 3_600_000,
};
/** Room-code lookups per user: 30 per minute (the code space can be brute-forced). */
export const ROOM_LOOKUP_RATE: RateRule = { action: 'room-lookup', limit: 30, windowMs: 60_000 };
/** Joining public rooms over REST per user: 30 per minute. */
export const ROOM_JOIN_HTTP_RATE: RateRule = {
  action: 'room-join-http',
  limit: 30,
  windowMs: 60_000,
};

export type RateDecision = {
  readonly allowed: boolean;
  /** Whole seconds until the window ends (at least 1); meaningful when not allowed. */
  readonly retryAfterSeconds: number;
};

export type RateLimiter = {
  /** Counts one attempt; `true` while the subject is within the limit. */
  readonly consume: (rule: RateRule, subject: string) => Promise<boolean>;
  /** Like `consume`, and also says how long a refused caller should wait. */
  readonly hit: (rule: RateRule, subject: string) => Promise<RateDecision>;
};

export const createRateLimiter = (redis: Redis): RateLimiter => {
  const hit = async (rule: RateRule, subject: string): Promise<RateDecision> => {
    const key = redisKeys.rateLimit(rule.action, subject);
    const replies = await redis
      .multi()
      .set(key, '0', 'PX', rule.windowMs, 'NX')
      .incr(key)
      .pttl(key)
      .exec();
    const count = replies?.[1]?.[1];
    const ttl = replies?.[2]?.[1];
    const failed = replies?.some(([error]) => error !== null) ?? true;
    if (replies === null || failed || typeof count !== 'number') {
      throw new Error('the rate limit transaction failed');
    }
    const remainingMs = typeof ttl === 'number' && ttl > 0 ? ttl : rule.windowMs;
    return {
      allowed: count <= rule.limit,
      retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)),
    };
  };
  return { hit, consume: async (rule, subject) => (await hit(rule, subject)).allowed };
};
