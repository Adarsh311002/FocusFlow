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

// The Socket.IO side of the revocation check (review findings R-1 and R-2): the handshake
// runs the same check as REST — a Redis marker refuses at once, otherwise PostgreSQL
// decides — and refuses with INTERNAL (retry later) when PostgreSQL is needed but
// unavailable, instead of connecting a possibly revoked session.

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
  it('marker present: SESSION_REVOKED without querying PostgreSQL', async () => {
    const { logger } = recordingLogger();
    const { db, queries } = dbFake('down');

    const { code, socket } = await handshake(depsWith(redisFake('marker'), db, logger));

    expect(code).toBe('SESSION_REVOKED');
    expect(socket.data).toBeUndefined();
    expect(queries()).toBe(0);
  });

  it('marker absent: PostgreSQL decides, both ways', async () => {
    const { logger } = recordingLogger();
    const { db, queries } = dbFake('healthy');

    const { code, socket } = await handshake(depsWith(redisFake('no-marker'), db, logger));
    expect(code).toBeUndefined();
    expect(socket.data).toMatchObject({ userId: USER_ID, sid: SID });
    // The revocation lookup, then the user lookup.
    expect(queries()).toBe(2);

    expect(
      (await handshake(depsWith(redisFake('no-marker'), dbFake('revoked').db, logger))).code,
    ).toBe('SESSION_REVOKED');
  });

  it('Redis unavailable: PostgreSQL decides, both ways', async () => {
    const { logger } = recordingLogger();

    expect((await handshake(depsWith(redisFake('down'), dbFake('healthy').db, logger))).code).toBe(
      undefined,
    );
    expect((await handshake(depsWith(redisFake('down'), dbFake('revoked').db, logger))).code).toBe(
      'SESSION_REVOKED',
    );
  });

  it.each([
    ['marker absent', 'no-marker'],
    ['Redis unavailable', 'down'],
  ] as const)(
    '%s, PostgreSQL unavailable: refuses with INTERNAL from the revocation check itself',
    async (_label, redisMode) => {
      const { logger, warned } = recordingLogger();
      const { db, queries } = dbFake('down');

      const { code, socket } = await handshake(depsWith(redisFake(redisMode), db, logger));

      expect(code).toBe('INTERNAL');
      expect(socket.data).toBeUndefined();
      // The refusal comes from the fail-closed revocation check (a 503 AppError), not from
      // the later user lookup: PostgreSQL was asked exactly once, for the revocation.
      expect(queries()).toBe(1);
      expect(warned.at(-1)).toBeInstanceOf(AppError);
      expect(warned.at(-1)).toMatchObject({ code: 'INTERNAL', status: 503 });
    },
  );
});
