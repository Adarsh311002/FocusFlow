import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  startInstance,
  startTestHarness,
  stopTestHarness,
  type TestHarness,
  type TestInstance,
} from '../../../test/harness.js';
import { closeAllSockets, connectSocket, waitForDisconnect } from '../../../test/sockets.js';
import { signUpTestUser } from '../../../test/users.js';
import { redisKeys } from '../../platform/redis-keys.js';

// Per-user presence against real Redis and two API instances (approved Phase 3
// decisions 1 and 6, with short intervals).

const TIMINGS = { INSTANCE_HEARTBEAT_MS: '200', INSTANCE_TTL_MS: '1000' };

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (condition: () => Promise<boolean>, timeoutMs = 8_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await condition()) {
        return;
      }
    } catch {
      // A probe that throws (Redis reconnecting) counts as "not yet".
    }
    if (Date.now() > deadline) {
      throw new Error('condition not met in time');
    }
    await sleep(50);
  }
};

const isOnline = (userId: string) => requireHarness().runtime.presence.isUserOnline(userId);
const userEntries = (userId: string) =>
  requireHarness().redis.smembers(redisKeys.userSockets(userId));
const instanceEntries = (instanceId: string) =>
  requireHarness().redis.smembers(redisKeys.instanceSockets(instanceId));

beforeAll(async () => {
  harness = await startTestHarness(TIMINGS);
  second = await startInstance(harness, TIMINGS);
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

describe('per-user presence', () => {
  it('records one entry per socket, tagged by instance, in both sets', async () => {
    const h = requireHarness();
    const user = await signUpTestUser(h);
    const socket = await connectSocket(h.baseUrl, user.accessToken);

    await waitFor(async () => (await userEntries(user.userId)).length === 1);

    expect(await userEntries(user.userId)).toEqual([
      `${h.runtime.instanceId}:${String(socket.id)}`,
    ]);
    expect(await instanceEntries(h.runtime.instanceId)).toContain(
      `${user.userId}:${String(socket.id)}`,
    );
    expect(await isOnline(user.userId)).toBe(true);
  });

  it('keeps a user online until the last tab closes, across instances', async () => {
    const h = requireHarness();
    const user = await signUpTestUser(h);
    const tabOnFirst = await connectSocket(h.baseUrl, user.accessToken);
    const tabOnSecond = await connectSocket(requireSecond().baseUrl, user.accessToken);
    await waitFor(async () => (await userEntries(user.userId)).length === 2);

    tabOnFirst.disconnect();
    await waitFor(async () => (await userEntries(user.userId)).length === 1);
    expect(await isOnline(user.userId)).toBe(true);

    tabOnSecond.disconnect();
    await waitFor(async () => (await userEntries(user.userId)).length === 0);
    expect(await isOnline(user.userId)).toBe(false);
  });

  it('reports the offline transition only when the last socket goes', async () => {
    const h = requireHarness();
    const user = await signUpTestUser(h);
    const offline: string[] = [];
    h.runtime.presence.onUserOffline((userId) => {
      if (userId === user.userId) {
        offline.push(userId);
      }
    });
    const first = await connectSocket(h.baseUrl, user.accessToken);
    const secondTab = await connectSocket(h.baseUrl, user.accessToken);
    await waitFor(async () => (await userEntries(user.userId)).length === 2);

    first.disconnect();
    await waitFor(async () => (await userEntries(user.userId)).length === 1);
    await sleep(100);
    expect(offline).toEqual([]);

    secondTab.disconnect();
    await waitFor(() => Promise.resolve(offline.length === 1));
  });

  it('keeps users isolated', async () => {
    const h = requireHarness();
    const alice = await signUpTestUser(h, 'alice');
    const bob = await signUpTestUser(h, 'bob');
    await connectSocket(h.baseUrl, alice.accessToken);
    await waitFor(() => isOnline(alice.userId));

    expect(await isOnline(bob.userId)).toBe(false);
    expect(await userEntries(bob.userId)).toEqual([]);
  });
});

describe('Redis data loss', () => {
  it('re-adds every local socket after FLUSHALL (local recovery)', async () => {
    const h = requireHarness();
    const user = await signUpTestUser(h);
    const onFirst = await connectSocket(h.baseUrl, user.accessToken);
    const onSecond = await connectSocket(requireSecond().baseUrl, user.accessToken);
    await waitFor(async () => (await userEntries(user.userId)).length === 2);

    await h.redis.flushall();

    await waitFor(async () => (await userEntries(user.userId)).length === 2);
    expect(await userEntries(user.userId)).toEqual(
      expect.arrayContaining([
        `${h.runtime.instanceId}:${String(onFirst.id)}`,
        `${requireSecond().runtime.instanceId}:${String(onSecond.id)}`,
      ]),
    );
    await waitFor(() => isOnline(user.userId));
  });
});

describe('instance death', () => {
  it('stops counting a dead instance’s sockets at once, and cleanup removes them', async () => {
    const h = requireHarness();
    const doomed = await startInstance(h, TIMINGS);
    const survivor = await signUpTestUser(h, 'survivor');
    const stranded = await signUpTestUser(h, 'stranded');
    await connectSocket(doomed.baseUrl, survivor.accessToken);
    await connectSocket(h.baseUrl, survivor.accessToken);
    await connectSocket(doomed.baseUrl, stranded.accessToken);
    await waitFor(async () => (await userEntries(survivor.userId)).length === 2);
    await waitFor(async () => (await userEntries(stranded.userId)).length === 1);
    const offline: string[] = [];
    h.runtime.presence.onUserOffline((userId, reason) => {
      offline.push(`${userId}:${reason}`);
    });

    // Simulated crash: the instance loses Redis without running any cleanup, so its
    // heartbeat stops and its sockets' entries stay behind.
    doomed.runtime.redis.disconnect();

    // Once its heartbeat is older than the TTL, its entries no longer count.
    await waitFor(async () => !(await isOnline(stranded.userId)), 5_000);
    expect(await userEntries(stranded.userId)).toHaveLength(1);
    expect(await isOnline(survivor.userId)).toBe(true);

    // The cleanup the reconciler runs removes exactly that instance's entries.
    await h.runtime.presence.removeInstance(doomed.runtime.instanceId, 'instance_dead');

    expect(await userEntries(stranded.userId)).toEqual([]);
    expect(await userEntries(survivor.userId)).toHaveLength(1);
    expect(await instanceEntries(doomed.runtime.instanceId)).toEqual([]);
    expect(offline).toContain(`${stranded.userId}:instance_dead`);
    expect(offline).not.toContain(`${survivor.userId}:instance_dead`);
  });

  it('removes its own presence on a clean shutdown', async () => {
    const h = requireHarness();
    const leaving = await startInstance(h, TIMINGS);
    const user = await signUpTestUser(h);
    const socket = await connectSocket(leaving.baseUrl, user.accessToken);
    await waitFor(() => isOnline(user.userId));
    const disconnected = waitForDisconnect(socket);

    await leaving.runtime.stop();
    h.extraInstances.splice(h.extraInstances.indexOf(leaving), 1);

    await disconnected;
    expect(await userEntries(user.userId)).toEqual([]);
    expect(await instanceEntries(leaving.runtime.instanceId)).toEqual([]);
    expect(await h.redis.zscore(redisKeys.instances, leaving.runtime.instanceId)).toBeNull();
    expect(await isOnline(user.userId)).toBe(false);
  });
});
