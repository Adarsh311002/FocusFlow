import { timeSyncAckSchema } from '@focus-flow/contracts';
import { eq } from 'drizzle-orm';
import type { Server } from 'socket.io';
import type { Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  startInstance,
  startTestHarness,
  stopTestHarness,
  type TestHarness,
  type TestInstance,
} from '../../../test/harness.js';
import {
  closeAllSockets,
  connectSocket,
  openSocket,
  waitForConnect,
  waitForDisconnect,
} from '../../../test/sockets.js';
import {
  logInTestUser,
  logOutTestUser,
  signUpTestUser,
  type TestUser,
} from '../../../test/users.js';
import { authSessions, users } from '../../db/schema.js';
import { formatEpoch, parseEpoch } from '../../platform/epoch.js';
import { redisTimeMs } from '../../platform/redis.js';
import { redisKeys } from '../../platform/redis-keys.js';
import { issueAccessToken } from '../auth/jwt.js';
import { sessionRoom, userRoom } from './types.js';

let harness: TestHarness | undefined;
let second: TestInstance | undefined;

const requireHarness = (): TestHarness => {
  if (harness === undefined) {
    throw new Error('the API harness failed to start');
  }
  return harness;
};

const requireSecond = (): TestInstance => {
  if (second === undefined) {
    throw new Error('the second API instance failed to start');
  }
  return second;
};

const sidOf = async (user: TestUser): Promise<string> => {
  const rows = await requireHarness()
    .db.select({ id: authSessions.id })
    .from(authSessions)
    .where(eq(authSessions.userId, user.userId));
  const [session] = rows;
  if (session === undefined || rows.length !== 1) {
    throw new Error('expected exactly one auth session');
  }
  return session.id;
};

/** Sends `time:sync` and resolves with the raw acknowledgement. */
const timeSync = (socket: Socket, payload: unknown): Promise<unknown> =>
  new Promise((resolve) => {
    socket.emit('time:sync', payload, (response: unknown) => {
      resolve(response);
    });
  });

/** Resolves with every payload of `event` received within `ms`. */
const collect = (socket: Socket, event: string, ms: number): Promise<unknown[]> =>
  new Promise((resolve) => {
    const received: unknown[] = [];
    socket.on(event, (payload: unknown) => received.push(payload));
    setTimeout(() => {
      resolve(received);
    }, ms);
  });

beforeAll(async () => {
  harness = await startTestHarness();
  second = await startInstance(harness);
}, 180_000);

afterEach(() => {
  closeAllSockets();
});

afterAll(async () => {
  closeAllSockets();
  if (harness !== undefined) {
    await stopTestHarness(harness);
  }
}, 60_000);

describe('handshake authentication', () => {
  it('accepts a valid access token and derives identity only from it', async () => {
    const h = requireHarness();
    const user = await signUpTestUser(h);
    const socket = await connectSocket(h.baseUrl, user.accessToken);

    const [serverSocket] = (await h.runtime.io.local.fetchSockets()).filter(
      (candidate) => candidate.id === socket.id,
    );

    expect(serverSocket?.data.userId).toBe(user.userId);
    expect(serverSocket?.data.sid).toBe(await sidOf(user));
    expect(serverSocket?.data.displayName).toBe('Test User');
    expect(serverSocket?.data.tokenExpiresAtMs).toBeGreaterThan(Date.now());
    expect(serverSocket?.rooms.has(userRoom(user.userId))).toBe(true);
    expect(serverSocket?.rooms.has(sessionRoom(await sidOf(user)))).toBe(true);
  });

  it('connects over the default transports (polling, then WebSocket upgrade)', async () => {
    const h = requireHarness();
    const user = await signUpTestUser(h);
    const socket = openSocket(
      h.baseUrl,
      { token: user.accessToken },
      {
        transports: ['polling', 'websocket'],
      },
    );

    expect(await waitForConnect(socket)).toEqual({ connected: true });
  });

  it.each([
    ['no auth object', undefined],
    ['an empty token', { token: '' }],
    ['a forged token', { token: 'a.b.c' }],
    ['identity riding along with the token', { token: 'x', userId: 'someone' }],
  ])('refuses %s with UNAUTHENTICATED', async (_label, auth) => {
    const socket = openSocket(requireHarness().baseUrl, auth);

    expect(await waitForConnect(socket)).toMatchObject({
      connected: false,
      code: 'UNAUTHENTICATED',
    });
  });

  it('refuses an expired token with UNAUTHENTICATED', async () => {
    const h = requireHarness();
    const user = await signUpTestUser(h);
    const { token } = await issueAccessToken(
      { userId: user.userId, sid: await sidOf(user) },
      { keys: h.authDeps.jwtKeys, issuer: h.authDeps.jwtIssuer, audience: h.authDeps.jwtAudience },
      -1,
    );

    expect(await waitForConnect(openSocket(h.baseUrl, { token }))).toMatchObject({
      connected: false,
      code: 'UNAUTHENTICATED',
    });
  });

  it('refuses a revoked session with SESSION_REVOKED', async () => {
    const h = requireHarness();
    const user = await signUpTestUser(h);
    await logOutTestUser(h, user);

    expect(await waitForConnect(openSocket(h.baseUrl, { token: user.accessToken }))).toMatchObject({
      connected: false,
      code: 'SESSION_REVOKED',
    });
  });

  it('refuses a token whose user no longer exists', async () => {
    const h = requireHarness();
    const user = await signUpTestUser(h);
    await h.db.delete(users).where(eq(users.id, user.userId));

    expect(await waitForConnect(openSocket(h.baseUrl, { token: user.accessToken }))).toMatchObject({
      connected: false,
      code: 'UNAUTHENTICATED',
    });
  });
});

describe('revocation when the Redis marker is missing (R-2)', () => {
  it('refuses a session revoked in PostgreSQL whose marker was never written', async () => {
    const h = requireHarness();
    const user = await signUpTestUser(h, 'unmarked');
    // The revocation commits in PostgreSQL but no marker reaches Redis (a failed write),
    // while Redis keeps its data and an epoch older than one access-token lifetime (what
    // R3 used to trust): PostgreSQL still decides at the handshake.
    const epoch = parseEpoch(await h.redis.get(redisKeys.epoch));
    if (epoch === undefined) {
      throw new Error('expected an epoch');
    }
    await h.redis.set(
      redisKeys.epoch,
      formatEpoch({
        id: epoch.id,
        createdAtMs: epoch.createdAtMs - h.config.ACCESS_TOKEN_TTL_SECONDS * 1_000 - 1_000,
      }),
    );
    await h.db
      .update(authSessions)
      .set({ revokedAt: new Date() })
      .where(eq(authSessions.id, await sidOf(user)));

    expect(await waitForConnect(openSocket(h.baseUrl, { token: user.accessToken }))).toMatchObject({
      connected: false,
      code: 'SESSION_REVOKED',
    });
  });
});

describe('revocation after Redis data loss', () => {
  it('still refuses a revoked session at the handshake after FLUSHALL, before and after recovery', async () => {
    const h = requireHarness();
    const user = await signUpTestUser(h, 'revoked-then-flushed');
    await logOutTestUser(h, user);

    // Stop every heartbeat so nothing recreates the epoch behind the test's back.
    for (const runtime of [h.runtime, requireSecond().runtime]) {
      await runtime.heartbeat.stop();
    }
    await h.redis.flushall();

    try {
      // Marker and epoch are both gone: PostgreSQL decides.
      expect(
        await waitForConnect(openSocket(h.baseUrl, { token: user.accessToken })),
      ).toMatchObject({ connected: false, code: 'SESSION_REVOKED' });

      // After recovery the marker is still gone: PostgreSQL still decides.
      await h.runtime.epoch.check('tick');
      expect(
        await waitForConnect(openSocket(h.baseUrl, { token: user.accessToken })),
      ).toMatchObject({ connected: false, code: 'SESSION_REVOKED' });

      // A session that was never revoked connects normally throughout.
      const active = await signUpTestUser(h, 'active');
      expect(await waitForConnect(openSocket(h.baseUrl, { token: active.accessToken }))).toEqual({
        connected: true,
      });
    } finally {
      for (const runtime of [h.runtime, requireSecond().runtime]) {
        await runtime.heartbeat.start();
      }
    }
  });
});

describe('token expiry', () => {
  it('disconnects the socket when its access token expires', async () => {
    const h = requireHarness();
    const user = await signUpTestUser(h);
    const { token } = await issueAccessToken(
      { userId: user.userId, sid: await sidOf(user) },
      { keys: h.authDeps.jwtKeys, issuer: h.authDeps.jwtIssuer, audience: h.authDeps.jwtAudience },
      2,
    );
    const socket = await connectSocket(h.baseUrl, token);

    expect(await waitForDisconnect(socket, 6_000)).toBe('io server disconnect');
  });
});

describe('time:sync', () => {
  it('answers with Redis TIME', async () => {
    const h = requireHarness();
    const socket = await connectSocket(h.baseUrl, (await signUpTestUser(h)).accessToken);

    const before = await redisTimeMs(h.redis);
    const ack = timeSyncAckSchema.parse(await timeSync(socket, { clientSentAtMs: Date.now() }));
    const after = await redisTimeMs(h.redis);

    expect(ack.ok).toBe(true);
    if (ack.ok) {
      expect(ack.serverNowMs).toBeGreaterThanOrEqual(before);
      expect(ack.serverNowMs).toBeLessThanOrEqual(after);
    }
  });

  it.each([
    ['a missing field', {}],
    ['a negative time', { clientSentAtMs: -5 }],
    ['identity in the payload', { clientSentAtMs: 1, userId: 'x' }],
  ])('rejects %s with VALIDATION_FAILED', async (_label, payload) => {
    const h = requireHarness();
    const socket = await connectSocket(h.baseUrl, (await signUpTestUser(h)).accessToken);

    const ack = timeSyncAckSchema.parse(await timeSync(socket, payload));

    expect(ack).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
  });
});

describe('session revocation', () => {
  it('disconnects every socket of the session on every instance, and only that session', async () => {
    const h = requireHarness();
    const user = await signUpTestUser(h, 'revoked');
    const otherDevice = await logInTestUser(h, user);
    const bystander = await signUpTestUser(h, 'bystander');

    const onFirst = await connectSocket(h.baseUrl, user.accessToken);
    const onSecond = await connectSocket(requireSecond().baseUrl, user.accessToken);
    const otherDeviceSocket = await connectSocket(requireSecond().baseUrl, otherDevice.accessToken);
    const bystanderSocket = await connectSocket(h.baseUrl, bystander.accessToken);

    // Listen first: the disconnect can arrive before the logout request even returns.
    const firstDisconnect = waitForDisconnect(onFirst);
    const secondDisconnect = waitForDisconnect(onSecond);
    await logOutTestUser(h, user);

    expect(await firstDisconnect).toBe('io server disconnect');
    expect(await secondDisconnect).toBe('io server disconnect');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(otherDeviceSocket.connected).toBe(true);
    expect(bystanderSocket.connected).toBe(true);

    // Reconnecting with the same access token is refused at the handshake.
    expect(await waitForConnect(openSocket(h.baseUrl, { token: user.accessToken }))).toMatchObject({
      connected: false,
      code: 'SESSION_REVOKED',
    });
  });
});

describe('cross-instance delivery and isolation', () => {
  // Phase 3 has no product events, so these use an untyped view of the server to prove
  // the plumbing: the adapter and the emitter reach sockets on any instance, and a user
  // room reaches only that user's sockets.
  const untyped = (server: unknown): Server => server as Server;

  it('delivers a user-room broadcast from instance A to the user’s socket on instance B only', async () => {
    const h = requireHarness();
    const alice = await signUpTestUser(h, 'alice');
    const bob = await signUpTestUser(h, 'bob');
    const aliceOnSecond = await connectSocket(requireSecond().baseUrl, alice.accessToken);
    const bobOnSecond = await connectSocket(requireSecond().baseUrl, bob.accessToken);

    const aliceReceived = collect(aliceOnSecond, 'test:ping', 500);
    const bobReceived = collect(bobOnSecond, 'test:ping', 500);
    untyped(h.runtime.io).to(userRoom(alice.userId)).emit('test:ping', { n: 1 });

    expect(await aliceReceived).toEqual([{ n: 1 }]);
    expect(await bobReceived).toEqual([]);
  });

  it('delivers an emitter broadcast (no Socket.IO server involved) to every tab of the user', async () => {
    const h = requireHarness();
    const alice = await signUpTestUser(h, 'alice');
    const tabOne = await connectSocket(h.baseUrl, alice.accessToken);
    const tabTwo = await connectSocket(requireSecond().baseUrl, alice.accessToken);

    const first = collect(tabOne, 'test:ping', 500);
    const secondTab = collect(tabTwo, 'test:ping', 500);
    const emitter = h.runtime.socketEmitter as unknown as {
      to: (room: string) => { emit: (event: string, payload: unknown) => void };
    };
    emitter.to(userRoom(alice.userId)).emit('test:ping', { n: 2 });

    expect(await first).toEqual([{ n: 2 }]);
    expect(await secondTab).toEqual([{ n: 2 }]);
  });

  it('sees a user’s sockets on both instances through the adapter', async () => {
    const h = requireHarness();
    const alice = await signUpTestUser(h, 'alice');
    await connectSocket(h.baseUrl, alice.accessToken);
    await connectSocket(requireSecond().baseUrl, alice.accessToken);

    const sockets = await h.runtime.io.in(userRoom(alice.userId)).fetchSockets();

    expect(sockets).toHaveLength(2);
  });
});
