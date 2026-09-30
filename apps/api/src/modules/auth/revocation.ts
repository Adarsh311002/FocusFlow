import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import type { Db } from '../../db/client.js';
import { findAuthSessionById } from './queries.js';

// docs/architecture/auth.md: a revoked session's id is marked in Redis for one
// access-token lifetime, so REST requests reject it immediately instead of waiting
// for the token to expire naturally. `redis`'s configured key prefix (P3) already
// applies to this key.
const revokedSessionKey = (sid: string): string => `auth:revoked:${sid}`;

/**
 * Fails open (does not throw) if Redis cannot be reached: the write is best-effort.
 * PostgreSQL's `revoked_at` is already committed by the caller before this runs, so
 * it remains the source of truth even if this mark never lands; `isSessionRevoked`
 * below falls back to it when Redis is unavailable, so the fast path being briefly
 * unwritable never fully disables revocation.
 */
export const markSessionRevoked = async (
  redis: Redis,
  sid: string,
  ttlSeconds: number,
  logger: Logger,
): Promise<void> => {
  try {
    await redis.set(revokedSessionKey(sid), '1', 'EX', ttlSeconds);
  } catch (error) {
    logger.warn({ err: error, sid }, 'Failed to write the Redis revocation marker');
  }
};

/**
 * Redis is the fast path (checked on every protected request without touching
 * PostgreSQL); when it is unreachable, falling straight back to "not revoked" would
 * make an entire Redis outage a window where every revoked session keeps working for
 * up to one access-token lifetime. Falling back to a single indexed PostgreSQL lookup
 * keeps the actual security property intact — sessions are still recognised as
 * revoked, just slower — while Redis stays purely a disposable fast path (F2).
 */
export const isSessionRevoked = async (
  redis: Redis,
  db: Db,
  sid: string,
  logger: Logger,
): Promise<boolean> => {
  try {
    return (await redis.get(revokedSessionKey(sid))) !== null;
  } catch (error) {
    logger.warn({ err: error, sid }, 'Redis revocation check failed; falling back to PostgreSQL');
  }

  try {
    const session = await findAuthSessionById(db, sid);
    return session !== undefined && session.revokedAt !== null;
  } catch (error) {
    logger.warn(
      { err: error, sid },
      'PostgreSQL revocation fallback also failed; treating the session as not revoked',
    );
    return false;
  }
};
