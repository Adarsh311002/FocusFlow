import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { describe, expect, it } from 'vitest';

import type { Db } from '../../db/client.js';
import type { AuthSessionRow } from './queries.js';
import { isSessionRevoked, markSessionRevoked } from './revocation.js';

const SID = '018f8f3e-0f1a-7c2b-9f4a-2f1b6c9d0e11';

type LoggedWarning = { details: unknown; message: string };

/**
 * A narrow structural fake for exactly the one method each function under test calls
 * on `pino.Logger` — same pattern as `ErrorHandlerLogger` in platform/http/errors.test.ts
 * and `ShutdownRedis` in platform/shutdown.test.ts, rather than a full mock of the
 * library type.
 */
const createLogger = (): { logger: Logger; warnings: LoggedWarning[] } => {
  const warnings: LoggedWarning[] = [];
  const logger = {
    warn(details: unknown, message: string) {
      warnings.push({ details, message });
    },
  } as unknown as Logger;
  return { logger, warnings };
};

const failingRedis = (method: 'set' | 'get', error: Error): Redis =>
  ({
    set: method === 'set' ? () => Promise.reject(error) : () => Promise.resolve('OK'),
    get: method === 'get' ? () => Promise.reject(error) : () => Promise.resolve(null),
  }) as unknown as Redis;

const workingRedis = (getResult: string | null): Redis =>
  ({
    set: () => Promise.resolve('OK'),
    get: () => Promise.resolve(getResult),
  }) as unknown as Redis;

const baseSession: AuthSessionRow = {
  id: SID,
  userId: '018f8f3e-0000-7000-8000-000000000001',
  currentTokenHash: 'a'.repeat(64),
  previousTokenHash: null,
  previousValidUntil: null,
  rotatedAt: null,
  expiresAt: new Date(Date.now() + 1_000_000),
  revokedAt: null,
  createdAt: new Date(),
  lastUsedAt: new Date(),
};

/**
 * A structural fake of the exact Drizzle chain `findAuthSessionById` calls
 * (`db.select().from(...).where(...).limit(1)`), not a mock of Drizzle itself —
 * `isSessionRevoked`'s own fallback logic is what these tests target, not the SQL.
 */
const dbReturning = (rows: AuthSessionRow[]): Db =>
  ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(rows),
        }),
      }),
    }),
  }) as unknown as Db;

const dbThatThrows = (error: Error): Db =>
  ({
    select: () => {
      throw error;
    },
  }) as unknown as Db;

describe('markSessionRevoked', () => {
  it('writes the revocation marker with the given TTL', async () => {
    let recordedArgs: unknown[] | undefined;
    const redis = {
      set: (...args: unknown[]) => {
        recordedArgs = args;
        return Promise.resolve('OK');
      },
    } as unknown as Redis;
    const { logger, warnings } = createLogger();

    await markSessionRevoked(redis, SID, 900, logger);

    expect(recordedArgs).toEqual([`auth:revoked:${SID}`, '1', 'EX', 900]);
    expect(warnings).toHaveLength(0);
  });

  it('fails open and logs a warning when the Redis SET fails, without throwing', async () => {
    const redisError = new Error('ECONNREFUSED');
    const redis = failingRedis('set', redisError);
    const { logger, warnings } = createLogger();

    await expect(markSessionRevoked(redis, SID, 900, logger)).resolves.toBeUndefined();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain('Failed to write the Redis revocation marker');
    // The logged payload carries the session id for correlation and the raw error for
    // diagnosis — nothing that would let a log reader impersonate the session (no token,
    // no hash, no secret).
    const details = warnings[0]?.details as { sid?: string; err?: unknown };
    expect(details.sid).toBe(SID);
    expect(details.err).toBe(redisError);
    expect(JSON.stringify(details)).not.toMatch(/hash|token|secret/i);
  });
});

describe('isSessionRevoked', () => {
  it('reports revoked when the Redis marker is present, without touching PostgreSQL', async () => {
    const redis = workingRedis('1');
    const db = dbThatThrows(new Error('must not be called'));
    const { logger, warnings } = createLogger();

    await expect(isSessionRevoked(redis, db, SID, logger)).resolves.toBe(true);
    expect(warnings).toHaveLength(0);
  });

  it('reports not-revoked when the Redis marker is absent', async () => {
    const redis = workingRedis(null);
    const db = dbThatThrows(new Error('must not be called'));
    const { logger, warnings } = createLogger();

    await expect(isSessionRevoked(redis, db, SID, logger)).resolves.toBe(false);
    expect(warnings).toHaveLength(0);
  });

  it('falls back to PostgreSQL and reports revoked when Redis GET fails but the session is revoked there', async () => {
    const redisError = new Error('connection lost');
    const redis = failingRedis('get', redisError);
    const db = dbReturning([{ ...baseSession, revokedAt: new Date() }]);
    const { logger, warnings } = createLogger();

    await expect(isSessionRevoked(redis, db, SID, logger)).resolves.toBe(true);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain(
      'Redis revocation check failed; falling back to PostgreSQL',
    );
    const details = warnings[0]?.details as { sid?: string; err?: unknown };
    expect(details.sid).toBe(SID);
    expect(details.err).toBe(redisError);
  });

  it('falls back to PostgreSQL and reports not-revoked when Redis GET fails and the session is not revoked there', async () => {
    const redis = failingRedis('get', new Error('connection lost'));
    const db = dbReturning([{ ...baseSession, revokedAt: null }]);
    const { logger, warnings } = createLogger();

    await expect(isSessionRevoked(redis, db, SID, logger)).resolves.toBe(false);
    expect(warnings).toHaveLength(1);
  });

  it('falls back to PostgreSQL and reports not-revoked when Redis GET fails and no such session exists', async () => {
    const redis = failingRedis('get', new Error('connection lost'));
    const db = dbReturning([]);
    const { logger, warnings } = createLogger();

    await expect(isSessionRevoked(redis, db, SID, logger)).resolves.toBe(false);
    expect(warnings).toHaveLength(1);
  });

  it('treats the session as not revoked when both Redis and the PostgreSQL fallback fail', async () => {
    const redisError = new Error('connection lost');
    const pgError = new Error('pool exhausted');
    const redis = failingRedis('get', redisError);
    const db = dbThatThrows(pgError);
    const { logger, warnings } = createLogger();

    // This is the documented worst case (revocation.ts): both the fast path and its
    // fallback are down, so the request is let through rather than the API going
    // fully unavailable. It never throws up to the caller.
    await expect(isSessionRevoked(redis, db, SID, logger)).resolves.toBe(false);

    expect(warnings).toHaveLength(2);
    expect(warnings[0]?.message).toContain(
      'Redis revocation check failed; falling back to PostgreSQL',
    );
    expect(warnings[1]?.message).toContain('PostgreSQL revocation fallback also failed');
    const secondDetails = warnings[1]?.details as { sid?: string; err?: unknown };
    expect(secondDetails.sid).toBe(SID);
    expect(secondDetails.err).toBe(pgError);
  });
});
