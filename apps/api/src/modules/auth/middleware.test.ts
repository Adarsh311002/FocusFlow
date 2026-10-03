import type { Request, Response } from 'express';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { describe, expect, it } from 'vitest';

import type { Db } from '../../db/client.js';
import { AppError } from '../../platform/http/errors.js';
import { issueAccessToken } from './jwt.js';
import { requireAuth } from './middleware.js';
import type { AuthDeps } from './service.js';

// The REST side of review finding R-1: `requireAuth` must surface the revocation check's
// fail-closed 503 and never reach the route when neither Redis nor PostgreSQL can answer.

const JWT = {
  keys: [{ kid: 'k1', secret: 'a'.repeat(32) }],
  issuer: 'focus-flow-test',
  audience: 'focus-flow-test',
};
const TTL_SECONDS = 900;
const USER_ID = '018f8f3e-0f1a-7c2b-9f4a-2f1b6c9d0e11';
const SID = '018f8f3e-0000-7000-8000-000000000001';
const NOW_MS = Date.now();
const SETTLED_EPOCH = `01a0ed0d-0000-7000-8000-00000000e0c0.${String(NOW_MS - TTL_SECONDS * 1_000 - 60_000)}`;

const redisFake = (mode: 'healthy' | 'down'): Redis => {
  const pipeline = {
    get: () => pipeline,
    time: () => pipeline,
    exec: () =>
      mode === 'down'
        ? Promise.reject(
            new Error("Stream isn't writeable and enableOfflineQueue options is false"),
          )
        : Promise.resolve([
            [null, null],
            [null, SETTLED_EPOCH],
            [null, [String(Math.floor(NOW_MS / 1_000)), '0']],
          ]),
  };
  return { pipeline: () => pipeline } as unknown as Redis;
};

/** The `select().from().where().limit()` chain `findAuthSessionById` uses. */
const dbFake = (mode: 'healthy' | 'revoked' | 'down'): { db: Db; queries: () => number } => {
  let queries = 0;
  const db = {
    select: () => {
      queries += 1;
      if (mode === 'down') {
        throw new Error('connect ECONNREFUSED');
      }
      return {
        from: () => ({
          where: () => ({
            limit: () =>
              Promise.resolve([{ id: SID, revokedAt: mode === 'revoked' ? new Date() : null }]),
          }),
        }),
      };
    },
  } as unknown as Db;
  return { db, queries: () => queries };
};

const silentLogger = {
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

const depsWith = (redis: Redis, db: Db): AuthDeps => ({
  db,
  redis,
  logger: silentLogger,
  jwtKeys: JWT.keys,
  jwtIssuer: JWT.issuer,
  jwtAudience: JWT.audience,
  accessTokenTtlSeconds: TTL_SECONDS,
  refreshTokenTtlSeconds: 86_400,
  refreshOverlapSeconds: 30,
  disconnectSession: () => undefined,
});

/** Runs `requireAuth` once and resolves with what it passed to `next`. */
const authenticate = async (deps: AuthDeps): Promise<{ error: unknown; req: Request }> => {
  const { token } = await issueAccessToken({ userId: USER_ID, sid: SID }, JWT, TTL_SECONDS);
  const req = { headers: { authorization: `Bearer ${token}` } } as unknown as Request;
  const error = await new Promise<unknown>((resolve) => {
    requireAuth(deps)(req, {} as Response, resolve);
  });
  return { error, req };
};

describe('requireAuth revocation check', () => {
  it('Redis and PostgreSQL healthy: answers from Redis and lets the request through', async () => {
    const { db, queries } = dbFake('healthy');

    const { error, req } = await authenticate(depsWith(redisFake('healthy'), db));

    expect(error).toBeUndefined();
    expect(req.authUser).toEqual({ userId: USER_ID, sid: SID });
    expect(queries()).toBe(0);
  });

  it('Redis unavailable, PostgreSQL healthy: PostgreSQL decides', async () => {
    const live = dbFake('healthy');
    const revoked = dbFake('revoked');

    expect((await authenticate(depsWith(redisFake('down'), live.db))).error).toBeUndefined();
    expect(live.queries()).toBe(1);

    const { error } = await authenticate(depsWith(redisFake('down'), revoked.db));
    expect(error).toMatchObject({ code: 'SESSION_REVOKED', status: 401 });
  });

  it('Redis and PostgreSQL unavailable: fails closed with a 503, never reaches the route', async () => {
    const { db } = dbFake('down');

    const { error, req } = await authenticate(depsWith(redisFake('down'), db));

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'INTERNAL', status: 503 });
    expect(req.authUser).toBeUndefined();
  });
});
