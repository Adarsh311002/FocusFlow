import { API_BASE_PATH, errorBodySchema, mePaths } from '@focus-flow/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  startInstance,
  startTestHarness,
  stopTestHarness,
  type TestHarness,
  type TestInstance,
} from '../../../test/harness.js';
import { closeAllSockets, openSocket, waitForConnect } from '../../../test/sockets.js';
import { startTcpProxy, type TcpProxy } from '../../../test/tcp-proxy.js';
import { logOutTestUser, signUpTestUser, type TestUser } from '../../../test/users.js';

// Review finding R-1 against real stores: one API instance reaches Redis and PostgreSQL
// through TCP proxies, so each store can become unreachable for that instance alone.
// Whenever its revocation check cannot get an answer from either store, REST and the
// Socket.IO handshake must refuse (503 / INTERNAL), never treat the session as valid.

let harness: TestHarness | undefined;
let proxied: TestInstance | undefined;
let redisProxy: TcpProxy | undefined;
let postgresProxy: TcpProxy | undefined;

const requireAll = () => {
  if (
    harness === undefined ||
    proxied === undefined ||
    redisProxy === undefined ||
    postgresProxy === undefined
  ) {
    throw new Error('the outage harness failed to start');
  }
  return { h: harness, proxied, redisProxy, postgresProxy };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (condition: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met in time');
    }
    await sleep(25);
  }
};

/** `GET /me` on the proxied instance. */
const getMe = async (user: TestUser): Promise<{ status: number; code?: string }> => {
  const response = await fetch(`${requireAll().proxied.baseUrl}${API_BASE_PATH}${mePaths.self}`, {
    headers: { Authorization: `Bearer ${user.accessToken}` },
  });
  const parsed = errorBodySchema.safeParse(await response.json());
  return parsed.success
    ? { status: response.status, code: parsed.data.error.code }
    : { status: response.status };
};

/** A handshake on the proxied instance. */
const handshake = (user: TestUser) =>
  waitForConnect(openSocket(requireAll().proxied.baseUrl, { token: user.accessToken }));

beforeAll(async () => {
  harness = await startTestHarness();
  const pg = harness.postgresContainer;
  const redis = harness.redisContainer;
  redisProxy = await startTcpProxy(redis.getHost(), redis.getPort());
  postgresProxy = await startTcpProxy(pg.getHost(), pg.getPort());
  proxied = await startInstance(harness, {
    ROLE: 'api',
    REDIS_URL: `redis://127.0.0.1:${String(redisProxy.port)}`,
    DATABASE_URL: `postgres://${pg.getUsername()}:${pg.getPassword()}@127.0.0.1:${String(postgresProxy.port)}/${pg.getDatabase()}`,
  });
}, 180_000);

afterEach(async () => {
  closeAllSockets();
  // Every test starts with both stores reachable again.
  await redisProxy?.restore();
  await postgresProxy?.restore();
});

afterAll(async () => {
  closeAllSockets();
  await redisProxy?.restore();
  await postgresProxy?.restore();
  if (harness !== undefined) {
    await stopTestHarness(harness);
  }
  await redisProxy?.close();
  await postgresProxy?.close();
}, 60_000);

describe('revocation check during store outages', () => {
  it('Redis and PostgreSQL healthy: normal behaviour', async () => {
    const { h, proxied: instance } = requireAll();
    const active = await signUpTestUser(h, 'active');
    const revoked = await signUpTestUser(h, 'revoked');
    await logOutTestUser(h, revoked);
    await waitFor(() => instance.runtime.redis.status === 'ready');

    expect((await getMe(active)).status).toBe(200);
    expect(await getMe(revoked)).toEqual({ status: 401, code: 'SESSION_REVOKED' });
    expect(await handshake(active)).toEqual({ connected: true });
    expect(await handshake(revoked)).toMatchObject({ connected: false, code: 'SESSION_REVOKED' });
  });

  it('Redis unavailable, PostgreSQL healthy: PostgreSQL decides', async () => {
    const { h, proxied: instance, redisProxy: redisLink } = requireAll();
    const active = await signUpTestUser(h, 'active');
    const revoked = await signUpTestUser(h, 'revoked');
    await logOutTestUser(h, revoked);

    await redisLink.cut();
    await waitFor(() => instance.runtime.redis.status !== 'ready');

    // The marker is unreachable, so only PostgreSQL can still know the session is revoked.
    expect((await getMe(active)).status).toBe(200);
    expect(await getMe(revoked)).toEqual({ status: 401, code: 'SESSION_REVOKED' });
    expect(await handshake(active)).toEqual({ connected: true });
    expect(await handshake(revoked)).toMatchObject({ connected: false, code: 'SESSION_REVOKED' });
  });

  it('Redis and PostgreSQL unavailable: REST and the handshake fail closed', async () => {
    const {
      h,
      proxied: instance,
      redisProxy: redisLink,
      postgresProxy: postgresLink,
    } = requireAll();
    const active = await signUpTestUser(h, 'active');
    const revoked = await signUpTestUser(h, 'revoked');
    await logOutTestUser(h, revoked);

    await redisLink.cut();
    await postgresLink.cut();
    await waitFor(() => instance.runtime.redis.status !== 'ready');

    // 503, not the 500 a failing route handler would give: the request is refused by the
    // revocation check itself, before any route runs.
    expect(await getMe(active)).toEqual({ status: 503, code: 'INTERNAL' });
    expect(await getMe(revoked)).toEqual({ status: 503, code: 'INTERNAL' });
    expect(await handshake(active)).toMatchObject({ connected: false, code: 'INTERNAL' });
    expect(await handshake(revoked)).toMatchObject({ connected: false, code: 'INTERNAL' });
  });

  it('recovers once the stores are reachable again', async () => {
    const { h, proxied: instance } = requireAll();
    const active = await signUpTestUser(h, 'active');
    await waitFor(() => instance.runtime.redis.status === 'ready', 15_000);

    expect((await getMe(active)).status).toBe(200);
    expect(await handshake(active)).toEqual({ connected: true });
  }, 20_000);
});
