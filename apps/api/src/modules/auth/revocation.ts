import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import type { Db } from '../../db/client.js';
import { AppError } from '../../platform/http/errors.js';
import { findSessionRevokedAt } from './queries.js';

// docs/architecture/auth.md, "Logout and revocation". A revoked session's id is marked in
// Redis for one access-token lifetime. The marker is only a positive shortcut: its presence
// proves the session was revoked, but its absence proves nothing — the write may have
// failed, or Redis may have lost it (a crash, a failover, a flush) while everything else
// survived. PostgreSQL's `auth_sessions.revoked_at` is the source of truth and makes every
// "not revoked" decision. `redis`'s configured key prefix (P3) already applies to this key.
const revokedSessionKey = (sid: string): string => `auth:revoked:${sid}`;

/**
 * Does not throw if Redis cannot be reached: the write is best-effort. PostgreSQL's
 * `revoked_at` is already committed by the caller before this runs, and a missing marker
 * only costs the PostgreSQL lookup in `isSessionRevoked` below — it never lets a revoked
 * session through.
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

/** `true` only for a present marker; `false` means "no marker", never "not revoked". */
const hasRevocationMarker = async (redis: Redis, sid: string): Promise<boolean> =>
  (await redis.get(revokedSessionKey(sid))) !== null;

/**
 * Whether an access token's session has been revoked. REST (`requireAuth`) and the
 * Socket.IO handshake both go through here.
 *
 * - A Redis marker → revoked, without a PostgreSQL query.
 * - No marker, or Redis unavailable → PostgreSQL decides (one primary-key lookup).
 * - PostgreSQL unavailable when it is needed → the check **fails closed** with a temporary
 *   503 / `INTERNAL`. A revoked session must never become trusted because Redis lost,
 *   failed to persist or temporarily lacks its marker, and a database blip must not sign
 *   a legitimate user out either (a 503 is retried, not treated as the end of the session).
 */
export const isSessionRevoked = async (
  redis: Redis,
  db: Db,
  sid: string,
  logger: Logger,
): Promise<boolean> => {
  try {
    if (await hasRevocationMarker(redis, sid)) {
      return true;
    }
  } catch (error) {
    logger.warn({ err: error, sid }, 'Redis revocation check failed; falling back to PostgreSQL');
  }

  try {
    const session = await findSessionRevokedAt(db, sid);
    return session !== undefined && session.revokedAt !== null;
  } catch (error) {
    logger.error(
      { err: error, sid },
      'PostgreSQL unavailable for the revocation check; refusing the request',
    );
    throw new AppError('INTERNAL', 503, 'The session check is temporarily unavailable.');
  }
};
