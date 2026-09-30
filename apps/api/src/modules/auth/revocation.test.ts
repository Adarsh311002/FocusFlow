import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { describe, expect, it } from 'vitest';

import type { Db } from '../../db/client.js';
import { AppError } from '../../platform/http/errors.js';
import type { AuthSessionRow } from './queries.js';
import { decideRevocation, isSessionRevoked, markSessionRevoked } from './revocation.js';

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

const TRUST_WINDOW_MS = 900_000;
const NOW_MS = 1_790_000_000_000;
const EPOCH_ID = '01a0ed0d-0000-7000-8000-00000000e0c0';
/** Created more than one access-token lifetime ago: the cache is trustworthy. */
const SETTLED_EPOCH = `${EPOCH_ID}.${String(NOW_MS - TRUST_WINDOW_MS - 1)}`;
/** Created a second ago (Redis just lost its data): the cache is not trustworthy yet. */
const FRESH_EPOCH = `${EPOCH_ID}.${String(NOW_MS - 1_000)}`;

const timeReply = (ms: number): [string, string] => [
  String(Math.floor(ms / 1_000)),
  String((ms % 1_000) * 1_000),
];

type PipelineReplies = [Error | null, unknown][];

/** A structural fake of the one pipeline isSessionRevoked issues: GET, GET, TIME. */
const pipelineRedis = (exec: () => Promise<PipelineReplies | null>): Redis => {
  const pipeline = {
    get: () => pipeline,
    time: () => pipeline,
    exec,
  };
  return { pipeline: () => pipeline } as unknown as Redis;
};

const cacheRedis = (state: { marker: string | null; epoch: string | null }): Redis =>
  pipelineRedis(() =>
    Promise.resolve([
      [null, state.marker],
      [null, state.epoch],
      [null, timeReply(NOW_MS)],
    ]),
  );

const failingCacheRedis = (error: Error): Redis => pipelineRedis(() => Promise.reject(error));

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

const mustNotQuery = (): Db => dbThatThrows(new Error('PostgreSQL must not be queried'));

const check = (redis: Redis, db: Db, logger: Logger): Promise<boolean> =>
  isSessionRevoked(redis, db, SID, logger, TRUST_WINDOW_MS);

describe('decideRevocation', () => {
  const at = (epoch: string | null, marker: string | null = null) =>
    decideRevocation({ revokedMarker: marker, epoch, redisNowMs: NOW_MS }, TRUST_WINDOW_MS);

  it('trusts a present marker regardless of the epoch', () => {
    expect(at(SETTLED_EPOCH, '1')).toBe('revoked');
    expect(at(FRESH_EPOCH, '1')).toBe('revoked');
    expect(at(null, '1')).toBe('revoked');
  });

  it('answers not-revoked from Redis alone once the epoch is older than the window', () => {
    expect(at(SETTLED_EPOCH)).toBe('not_revoked');
  });

  it('consults PostgreSQL inside the window after the epoch was (re)created', () => {
    expect(at(FRESH_EPOCH)).toBe('consult_postgres');
  });

  it('consults PostgreSQL when the epoch is missing (data lost, recovery not yet run)', () => {
    expect(at(null)).toBe('consult_postgres');
  });

  it('consults PostgreSQL when the epoch is unreadable', () => {
    expect(at('garbage')).toBe('consult_postgres');
    expect(at(`${EPOCH_ID}.not-a-number`)).toBe('consult_postgres');
  });

  it('trusts the cache from exactly one window after the epoch was created', () => {
    const createdAtMs = NOW_MS - TRUST_WINDOW_MS;
    expect(at(`${EPOCH_ID}.${String(createdAtMs)}`)).toBe('not_revoked');
    expect(at(`${EPOCH_ID}.${String(createdAtMs + 1)}`)).toBe('consult_postgres');
  });
});

describe('isSessionRevoked', () => {
  it('reports revoked when the Redis marker is present, without touching PostgreSQL', async () => {
    const { logger, warnings } = createFullLogger();

    await expect(
      check(cacheRedis({ marker: '1', epoch: SETTLED_EPOCH }), mustNotQuery(), logger),
    ).resolves.toBe(true);
    expect(warnings).toHaveLength(0);
  });

  it('stays on the fast path outside the trust window: not revoked, no PostgreSQL query', async () => {
    const { logger, warnings, errors } = createFullLogger();

    await expect(
      check(cacheRedis({ marker: null, epoch: SETTLED_EPOCH }), mustNotQuery(), logger),
    ).resolves.toBe(false);
    expect(warnings).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  describe('inside the trust-loss window', () => {
    it.each([
      ['a freshly created epoch', FRESH_EPOCH],
      ['a missing epoch', null],
    ])('asks PostgreSQL with %s and keeps a revoked session revoked', async (_label, epoch) => {
      const { logger } = createFullLogger();
      const db = dbReturning([{ ...baseSession, revokedAt: new Date() }]);

      await expect(check(cacheRedis({ marker: null, epoch }), db, logger)).resolves.toBe(true);
    });

    it('asks PostgreSQL and lets a session that was never revoked through', async () => {
      const { logger } = createFullLogger();
      const db = dbReturning([{ ...baseSession, revokedAt: null }]);

      await expect(
        check(cacheRedis({ marker: null, epoch: FRESH_EPOCH }), db, logger),
      ).resolves.toBe(false);
    });

    it('fails closed with a 503 when PostgreSQL is unavailable, rather than trusting the cache', async () => {
      const { logger, errors } = createFullLogger();
      const db = dbThatThrows(new Error('pool exhausted'));

      const failure = check(cacheRedis({ marker: null, epoch: FRESH_EPOCH }), db, logger);

      await expect(failure).rejects.toBeInstanceOf(AppError);
      await expect(failure).rejects.toMatchObject({ code: 'INTERNAL', status: 503 });
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toContain('Revocation cache untrusted');
    });
  });

  describe('when Redis itself fails (Phase 1 behaviour, unchanged)', () => {
    it('falls back to PostgreSQL and reports revoked when the session is revoked there', async () => {
      const redisError = new Error('connection lost');
      const { logger, warnings } = createFullLogger();

      await expect(
        check(
          failingCacheRedis(redisError),
          dbReturning([{ ...baseSession, revokedAt: new Date() }]),
          logger,
        ),
      ).resolves.toBe(true);

      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message).toContain(
        'Redis revocation check failed; falling back to PostgreSQL',
      );
      const details = warnings[0]?.details as { sid?: string; err?: unknown };
      expect(details.sid).toBe(SID);
      expect(details.err).toBe(redisError);
    });

    it('treats a failed command inside the pipeline like a Redis failure', async () => {
      const { logger, warnings } = createFullLogger();
      const redis = pipelineRedis(() =>
        Promise.resolve([
          [new Error('WRONGTYPE'), null],
          [null, SETTLED_EPOCH],
          [null, timeReply(NOW_MS)],
        ]),
      );

      await expect(
        check(redis, dbReturning([{ ...baseSession, revokedAt: new Date() }]), logger),
      ).resolves.toBe(true);
      expect(warnings).toHaveLength(1);
    });

    it('reports not-revoked when PostgreSQL says not revoked or has no such session', async () => {
      const { logger } = createFullLogger();

      await expect(
        check(
          failingCacheRedis(new Error('x')),
          dbReturning([{ ...baseSession, revokedAt: null }]),
          logger,
        ),
      ).resolves.toBe(false);
      await expect(check(failingCacheRedis(new Error('x')), dbReturning([]), logger)).resolves.toBe(
        false,
      );
    });

    it('treats the session as not revoked when both Redis and the PostgreSQL fallback fail', async () => {
      const pgError = new Error('pool exhausted');
      const { logger, warnings } = createFullLogger();

      // The documented worst case: both stores are down, so the request is let through
      // rather than the API going fully unavailable. It never throws up to the caller.
      await expect(
        check(failingCacheRedis(new Error('connection lost')), dbThatThrows(pgError), logger),
      ).resolves.toBe(false);

      expect(warnings).toHaveLength(2);
      expect(warnings[1]?.message).toContain('PostgreSQL revocation fallback also failed');
      const secondDetails = warnings[1]?.details as { sid?: string; err?: unknown };
      expect(secondDetails.err).toBe(pgError);
    });
  });
});
