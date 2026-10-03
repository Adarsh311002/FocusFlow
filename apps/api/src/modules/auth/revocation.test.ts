import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { describe, expect, it } from 'vitest';

import type { Db } from '../../db/client.js';
import { AppError } from '../../platform/http/errors.js';
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

/** A structural fake of the one Redis call the check makes: GET of the marker. */
const markerRedis = (marker: string | null): Redis =>
  ({ get: () => Promise.resolve(marker) }) as unknown as Redis;

const unavailableRedis = (error: Error): Redis =>
  ({ get: () => Promise.reject(error) }) as unknown as Redis;

/** Counts PostgreSQL lookups, so tests can prove when PostgreSQL was (not) asked. */
const countingDb = (db: Db): { db: Db; queries: () => number } => {
  let queries = 0;
  return {
    db: {
      select: (...args: unknown[]) => {
        queries += 1;
        return (db.select as (...a: unknown[]) => unknown)(...args);
      },
    } as unknown as Db,
    queries: () => queries,
  };
};

const createFullLogger = () => {
  const warnings: LoggedWarning[] = [];
  const errors: LoggedWarning[] = [];
  const logger = {
    warn(details: unknown, message: string) {
      warnings.push({ details, message });
    },
    error(details: unknown, message: string) {
      errors.push({ details, message });
    },
  } as unknown as Logger;
  return { logger, warnings, errors };
};

const revokedSession = (): Db => dbReturning([{ ...baseSession, revokedAt: new Date() }]);
const liveSession = (): Db => dbReturning([{ ...baseSession, revokedAt: null }]);

const check = (redis: Redis, db: Db, logger: Logger): Promise<boolean> =>
  isSessionRevoked(redis, db, SID, logger);

describe('isSessionRevoked', () => {
  describe('Redis healthy', () => {
    it('marker present: revoked, without querying PostgreSQL', async () => {
      const { logger, warnings } = createFullLogger();
      const { db, queries } = countingDb(dbThatThrows(new Error('must not be queried')));

      await expect(check(markerRedis('1'), db, logger)).resolves.toBe(true);
      expect(queries()).toBe(0);
      expect(warnings).toHaveLength(0);
    });

    it('marker absent, PostgreSQL says revoked: revoked (a missing marker proves nothing)', async () => {
      const { logger } = createFullLogger();
      const { db, queries } = countingDb(revokedSession());

      await expect(check(markerRedis(null), db, logger)).resolves.toBe(true);
      expect(queries()).toBe(1);
    });

    it('marker absent, PostgreSQL says not revoked: not revoked', async () => {
      const { logger, warnings } = createFullLogger();
      const { db, queries } = countingDb(liveSession());

      await expect(check(markerRedis(null), db, logger)).resolves.toBe(false);
      expect(queries()).toBe(1);
      expect(warnings).toHaveLength(0);
    });

    it('marker absent, no such session in PostgreSQL: not revoked', async () => {
      const { logger } = createFullLogger();

      await expect(check(markerRedis(null), dbReturning([]), logger)).resolves.toBe(false);
    });

    it('marker absent, PostgreSQL unavailable: fails closed with a 503', async () => {
      const pgError = new Error('pool exhausted');
      const { logger, errors } = createFullLogger();

      const failure = check(markerRedis(null), dbThatThrows(pgError), logger);

      await expect(failure).rejects.toBeInstanceOf(AppError);
      await expect(failure).rejects.toMatchObject({ code: 'INTERNAL', status: 503 });
      expect(errors).toHaveLength(1);
      expect((errors[0]?.details as { err?: unknown }).err).toBe(pgError);
    });
  });

  describe('Redis unavailable', () => {
    it('PostgreSQL says revoked: revoked', async () => {
      const redisError = new Error('connection lost');
      const { logger, warnings } = createFullLogger();

      await expect(check(unavailableRedis(redisError), revokedSession(), logger)).resolves.toBe(
        true,
      );

      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message).toContain(
        'Redis revocation check failed; falling back to PostgreSQL',
      );
      const details = warnings[0]?.details as { sid?: string; err?: unknown };
      expect(details.sid).toBe(SID);
      expect(details.err).toBe(redisError);
    });

    it('PostgreSQL says not revoked: not revoked', async () => {
      const { logger } = createFullLogger();

      await expect(
        check(unavailableRedis(new Error('connection lost')), liveSession(), logger),
      ).resolves.toBe(false);
    });

    it('PostgreSQL unavailable too: fails closed with a 503, never "not revoked"', async () => {
      const { logger, warnings, errors } = createFullLogger();

      const failure = check(
        unavailableRedis(new Error('connection lost')),
        dbThatThrows(new Error('connection refused')),
        logger,
      );

      await expect(failure).rejects.toBeInstanceOf(AppError);
      await expect(failure).rejects.toMatchObject({ code: 'INTERNAL', status: 503 });
      expect(warnings).toHaveLength(1);
      expect(errors).toHaveLength(1);
    });
  });
});
