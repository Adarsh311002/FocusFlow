import type { Request, Response } from 'express';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { describe, expect, it } from 'vitest';

import type { Db } from '../../db/client.js';
import { AppError } from '../../platform/http/errors.js';
import { issueAccessToken } from './jwt.js';
import { requireAuth } from './middleware.js';
import type { AuthDeps } from './service.js';

// The REST side of the revocation check (review findings R-1 and R-2): a Redis marker
// refuses at once; otherwise PostgreSQL decides; and when PostgreSQL is needed but
// unavailable, `requireAuth` surfaces the fail-closed 503 and never reaches the route.

const JWT = {
  keys: [{ kid: 'k1', secret: 'a'.repeat(32) }],
  issuer: 'focus-flow-test',
  audience: 'focus-flow-test',
};
const TTL_SECONDS = 900;
const USER_ID = '018f8f3e-0f1a-7c2b-9f4a-2f1b6c9d0e11';
const SID = '018f8f3e-0000-7000-8000-000000000001';
/** The one Redis call the check makes: GET of the revocation marker. */
const redisFake = (mode: 'marker' | 'no-marker' | 'down'): Redis =>
  ({
    get: () =>
      mode === 'down'
        ? Promise.reject(
            new Error("Stream isn't writeable and enableOfflineQueue options is false"),
          )
        : Promise.resolve(mode === 'marker' ? '1' : null),
  }) as unknown as Redis;

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
  it('marker present: SESSION_REVOKED without querying PostgreSQL', async () => {
    const { db, queries } = dbFake('down');

    const { error, req } = await authenticate(depsWith(redisFake('marker'), db));

    expect(error).toMatchObject({ code: 'SESSION_REVOKED', status: 401 });
    expect(req.authUser).toBeUndefined();
    expect(queries()).toBe(0);
  });

  it('marker absent: PostgreSQL decides, both ways', async () => {
    const live = dbFake('healthy');
    const revoked = dbFake('revoked');

    const allowed = await authenticate(depsWith(redisFake('no-marker'), live.db));
    expect(allowed.error).toBeUndefined();
    expect(allowed.req.authUser).toEqual({ userId: USER_ID, sid: SID });
    expect(live.queries()).toBe(1);

    const refused = await authenticate(depsWith(redisFake('no-marker'), revoked.db));
    expect(refused.error).toMatchObject({ code: 'SESSION_REVOKED', status: 401 });
  });

  it('marker absent, PostgreSQL unavailable: fails closed with a 503', async () => {
    const { error, req } = await authenticate(depsWith(redisFake('no-marker'), dbFake('down').db));

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'INTERNAL', status: 503 });
    expect(req.authUser).toBeUndefined();
  });

  it('Redis unavailable: PostgreSQL decides, both ways', async () => {
    const live = dbFake('healthy');

    expect((await authenticate(depsWith(redisFake('down'), live.db))).error).toBeUndefined();
    expect(live.queries()).toBe(1);

    const { error } = await authenticate(depsWith(redisFake('down'), dbFake('revoked').db));
    expect(error).toMatchObject({ code: 'SESSION_REVOKED', status: 401 });
  });

  it('Redis and PostgreSQL unavailable: fails closed with a 503, never reaches the route', async () => {
    const { error, req } = await authenticate(depsWith(redisFake('down'), dbFake('down').db));

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'INTERNAL', status: 503 });
    expect(req.authUser).toBeUndefined();
  });
});
