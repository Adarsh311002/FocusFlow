import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { ExtendedError } from 'socket.io';
import { describe, expect, it } from 'vitest';

import type { Db } from '../../db/client.js';
import { AppError } from '../../platform/http/errors.js';
import { issueAccessToken } from '../auth/jwt.js';
import type { AuthDeps } from '../auth/service.js';
import { createHandshakeMiddleware } from './handshake.js';
import type { AppSocket } from './types.js';

// The Socket.IO side of review finding R-1: the handshake runs the same revocation check
// as REST and must refuse with INTERNAL (retry later) when neither Redis nor PostgreSQL
// can answer, instead of connecting a possibly revoked session.

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

/**
 * The `select().from().where().limit()` chain both `findAuthSessionById` and
 * `findUserById` use. One row serves both lookups: the session's `revokedAt` and the
 * user's `id`, `displayName` and `avatarUrl`.
 */
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
              Promise.resolve([
                {
                  id: USER_ID,
                  displayName: 'Ada',
                  avatarUrl: null,
                  revokedAt: mode === 'revoked' ? new Date() : null,
                },
              ]),
          }),
        }),
      };
    },
  } as unknown as Db;
  return { db, queries: () => queries };
};

const recordingLogger = (): { logger: Logger; warned: unknown[] } => {
  const warned: unknown[] = [];
  const logger = {
    warn: (details: { err?: unknown }) => warned.push(details.err),
    error: () => undefined,
  } as unknown as Logger;
  return { logger, warned };
};

const depsWith = (redis: Redis, db: Db, logger: Logger): AuthDeps => ({
  db,
  redis,
  logger,
  jwtKeys: JWT.keys,
  jwtIssuer: JWT.issuer,
  jwtAudience: JWT.audience,
  accessTokenTtlSeconds: TTL_SECONDS,
  refreshTokenTtlSeconds: 86_400,
  refreshOverlapSeconds: 30,
  disconnectSession: () => undefined,
});

/** Runs the handshake middleware once; resolves with the refusal code, or `undefined`. */
const handshake = async (deps: AuthDeps): Promise<{ code: unknown; socket: AppSocket }> => {
  const { token } = await issueAccessToken({ userId: USER_ID, sid: SID }, JWT, TTL_SECONDS);
  const socket = { handshake: { auth: { token } } } as unknown as AppSocket;
  const error = await new Promise<ExtendedError | undefined>((resolve) => {
    createHandshakeMiddleware(deps)(socket, resolve);
  });
  return {
    code: error?.data === undefined ? undefined : (error.data as { code: unknown }).code,
    socket,
  };
};

describe('socket handshake revocation check', () => {
  it('Redis and PostgreSQL healthy: connects, with the revocation answered by Redis', async () => {
    const { logger } = recordingLogger();
    const { db, queries } = dbFake('healthy');

    const { code, socket } = await handshake(depsWith(redisFake('healthy'), db, logger));

    expect(code).toBeUndefined();
    expect(socket.data).toMatchObject({ userId: USER_ID, sid: SID });
    // Only the user lookup touched PostgreSQL.
    expect(queries()).toBe(1);
  });

  it('Redis unavailable, PostgreSQL healthy: PostgreSQL decides', async () => {
    const { logger } = recordingLogger();

    expect((await handshake(depsWith(redisFake('down'), dbFake('healthy').db, logger))).code).toBe(
      undefined,
    );
    expect((await handshake(depsWith(redisFake('down'), dbFake('revoked').db, logger))).code).toBe(
      'SESSION_REVOKED',
    );
  });

  it('Redis and PostgreSQL unavailable: refuses with INTERNAL from the revocation check itself', async () => {
    const { logger, warned } = recordingLogger();
    const { db, queries } = dbFake('down');

    const { code, socket } = await handshake(depsWith(redisFake('down'), db, logger));

    expect(code).toBe('INTERNAL');
    expect(socket.data).toBeUndefined();
    // The refusal comes from the fail-closed revocation check (a 503 AppError), not from
    // the later user lookup: PostgreSQL was asked exactly once, for the revocation.
    expect(queries()).toBe(1);
    expect(warned.at(-1)).toBeInstanceOf(AppError);
    expect(warned.at(-1)).toMatchObject({ code: 'INTERNAL', status: 503 });
  });
});
