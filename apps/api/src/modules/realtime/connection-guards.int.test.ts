import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { startTestHarness, stopTestHarness, type TestHarness } from '../../../test/harness.js';
import { closeAllSockets, openSocket, waitForConnect } from '../../../test/sockets.js';
import { signUpTestUser } from '../../../test/users.js';
import { SOCKET_CONNECT_RATE } from '../room-realtime/limiter.js';

// Socket abuse protection (Phase 9, S1 and S2) against the real Socket.IO server and Redis.

let harness: TestHarness | undefined;

const requireHarness = (): TestHarness => {
  if (harness === undefined) {
    throw new Error('the API harness failed to start');
  }
  return harness;
};

const MAX_PER_USER = 3;

beforeAll(async () => {
  harness = await startTestHarness({
    HTTP_RATE_LIMIT: 'on',
    SOCKET_MAX_PER_USER: String(MAX_PER_USER),
    INSTANCE_HEARTBEAT_MS: '200',
    INSTANCE_TTL_MS: '2000',
  });
}, 180_000);

afterEach(async () => {
  closeAllSockets();
  // Every test starts with fresh counters.
  const h = requireHarness();
  // KEYS returns full names, while DEL adds the client's key prefix again: strip it.
  const prefix = h.redis.options.keyPrefix ?? '';
  const keys = await h.redis.keys(`${prefix}ratelimit:socket-connect:*`);
  if (keys.length > 0) {
    await h.redis.del(...keys.map((key) => key.slice(prefix.length)));
  }
});

afterAll(async () => {
  closeAllSockets();
  if (harness !== undefined) {
    await stopTestHarness(harness);
  }
}, 60_000);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('S2: live sockets per user', () => {
  it('refuses a socket beyond the cap with TOO_MANY_CONNECTIONS, and allows one after a close', async () => {
    const h = requireHarness();
    const user = await signUpTestUser(h, 'many-tabs');
    const sockets = [];
    for (let index = 0; index < MAX_PER_USER; index += 1) {
      const socket = openSocket(h.baseUrl, { token: user.accessToken });
      expect(await waitForConnect(socket)).toEqual({ connected: true });
      sockets.push(socket);
    }
    // Presence records each socket shortly after it connects.
    await sleep(300);

    const extra = openSocket(h.baseUrl, { token: user.accessToken });
    expect(await waitForConnect(extra)).toMatchObject({
      connected: false,
      code: 'TOO_MANY_CONNECTIONS',
    });

    // Another user is not affected.
    const other = await signUpTestUser(h, 'one-tab');
    expect(await waitForConnect(openSocket(h.baseUrl, { token: other.accessToken }))).toEqual({
      connected: true,
    });

    sockets[0]?.disconnect();
    await sleep(500);
    const again = openSocket(h.baseUrl, { token: user.accessToken });
    expect(await waitForConnect(again)).toEqual({ connected: true });
  });
});

describe('S1: connection attempts per client address', () => {
  it('refuses attempts beyond the limit with RATE_LIMITED, before any token is checked', async () => {
    const h = requireHarness();
    const outcomes = [];
    // Without a token every attempt is refused anyway, but each one is still counted first.
    for (let index = 0; index < SOCKET_CONNECT_RATE.limit; index += 1) {
      outcomes.push(await waitForConnect(openSocket(h.baseUrl, undefined)));
    }
    expect(outcomes.map((outcome) => (outcome.connected ? 'connected' : outcome.code))).toEqual(
      Array.from({ length: SOCKET_CONNECT_RATE.limit }, () => 'UNAUTHENTICATED'),
    );

    const user = await signUpTestUser(h, 'flooded');
    expect(await waitForConnect(openSocket(h.baseUrl, { token: user.accessToken }))).toMatchObject({
      connected: false,
      code: 'RATE_LIMITED',
    });
  });
});
