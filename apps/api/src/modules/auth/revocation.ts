import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import type { Db } from '../../db/client.js';
import { parseEpoch } from '../../platform/epoch.js';
import { AppError } from '../../platform/http/errors.js';
import { redisTimeReplyToMs } from '../../platform/redis.js';
import { redisKeys } from '../../platform/redis-keys.js';
import { findAuthSessionById } from './queries.js';

// docs/architecture/auth.md: a revoked session's id is marked in Redis for one
// access-token lifetime, so REST requests reject it immediately instead of waiting
// for the token to expire naturally. `redis`'s configured key prefix (P3) already
// applies to this key.
const revokedSessionKey = (sid: string): string => `auth:revoked:${sid}`;

/**
 * Does not throw if Redis cannot be reached: the write is best-effort. PostgreSQL's
 * `revoked_at` is already committed by the caller before this runs and stays the source
 * of truth. While Redis is unreachable, `isSessionRevoked` below asks PostgreSQL. A
 * marker that never lands while Redis later answers with a trusted epoch is a known gap
 * (review finding R-2), handled separately.
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
 * What the Redis fast path can conclude on its own (docs/architecture/auth.md,
 * "Logout and revocation"; approved Phase 3 security fix):
 *
 * - A revocation marker is present → `revoked`. A positive hit is always trustworthy.
 * - No marker, and the cache is trustworthy → `not_revoked` (the normal case, no
 *   PostgreSQL query).
 * - No marker, but the cache may have lost revocations → `consult_postgres`.
 *
 * The cache is trustworthy only once it has existed for at least one access-token
 * lifetime. Redis losing its keys also drops every revocation marker, which would make
 * a revoked session's still-valid access token look "not revoked". After a loss the
 * epoch is recreated (platform/epoch.ts) with its creation time; every access token
 * issued before the loss expires no later than that time plus one token lifetime, and
 * every revocation made after the loss is in the new cache. Until then — and while the
 * epoch is missing because recovery has not run yet — PostgreSQL decides.
 */
export type RevocationDecision = 'revoked' | 'not_revoked' | 'consult_postgres';

export type RevocationCacheState = {
  readonly revokedMarker: string | null;
  readonly epoch: string | null;
  readonly redisNowMs: number;
};

export const decideRevocation = (
  { revokedMarker, epoch, redisNowMs }: RevocationCacheState,
  trustWindowMs: number,
): RevocationDecision => {
  if (revokedMarker !== null) {
    return 'revoked';
  }
  const parsed = parseEpoch(epoch);
  if (parsed === undefined) {
    return 'consult_postgres';
  }
  if (redisNowMs < parsed.createdAtMs + trustWindowMs) {
    return 'consult_postgres';
  }
  return 'not_revoked';
};

const asNullableString = (value: unknown): string | null => {
  if (value === null || typeof value === 'string') {
    return value;
  }
  throw new Error('unexpected Redis reply type');
};

/** One pipelined round trip: the marker, the epoch and Redis TIME. */
const readRevocationCache = async (redis: Redis, sid: string): Promise<RevocationCacheState> => {
  const replies = await redis
    .pipeline()
    .get(revokedSessionKey(sid))
    .get(redisKeys.epoch)
    .time()
    .exec();
  if (replies === null || replies.length !== 3) {
    throw new Error('the Redis revocation pipeline returned no replies');
  }
  const [marker, epoch, time] = replies;
  for (const reply of replies) {
    if (reply[0] !== null) {
      throw reply[0];
    }
  }
  return {
    revokedMarker: asNullableString(marker?.[1]),
    epoch: asNullableString(epoch?.[1]),
    redisNowMs: redisTimeReplyToMs(time?.[1]),
  };
};

const revokedInPostgres = async (db: Db, sid: string): Promise<boolean> => {
  const session = await findAuthSessionById(db, sid);
  return session !== undefined && session.revokedAt !== null;
};

/**
 * Whether an access token's session has been revoked.
 *
 * - Redis answers on its own whenever it can (`decideRevocation`), so normal requests
 *   stay on the fast path.
 * - Inside the trust-loss window, or when Redis itself fails, PostgreSQL decides.
 * - Whenever PostgreSQL is needed and cannot be reached, the check **fails closed** with
 *   a temporary 503: a revoked session must never become trusted because Redis lost its
 *   keys or is unavailable, and a database blip must not sign a legitimate user out
 *   either (a 503 is retried, not treated as the end of the session). REST requests and
 *   the Socket.IO handshake both go through here.
 */
export const isSessionRevoked = async (
  redis: Redis,
  db: Db,
  sid: string,
  logger: Logger,
  trustWindowMs: number,
): Promise<boolean> => {
  let decision: RevocationDecision;
  try {
    decision = decideRevocation(await readRevocationCache(redis, sid), trustWindowMs);
  } catch (error) {
    logger.warn({ err: error, sid }, 'Redis revocation check failed; falling back to PostgreSQL');
    decision = 'consult_postgres';
  }

  if (decision !== 'consult_postgres') {
    return decision === 'revoked';
  }

  try {
    return await revokedInPostgres(db, sid);
  } catch (error) {
    logger.error(
      { err: error, sid },
      'Revocation cache untrusted or unavailable and PostgreSQL unavailable; refusing the request',
    );
    throw new AppError('INTERNAL', 503, 'The session check is temporarily unavailable.');
  }
};
