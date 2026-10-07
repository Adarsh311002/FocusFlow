import { randomUUID } from 'node:crypto';

import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  startInstance,
  startTestHarness,
  stopTestHarness,
  type TestHarness,
  type TestInstance,
} from '../../../test/harness.js';
import { closeAllSockets, connectSocket, waitForDisconnect } from '../../../test/sockets.js';
import { startTcpProxy } from '../../../test/tcp-proxy.js';
import { signUpTestUser } from '../../../test/users.js';
import { redisTimeMs } from '../../platform/redis.js';
import { redisKeys } from '../../platform/redis-keys.js';
import type { UserOfflineEvent } from './presence.js';
import { createPresenceStore, type SocketRef } from './store.js';

// Per-user presence against real Redis and two API instances (approved Phase 3
// decisions 1 and 6, with short intervals), and its Phase 4A hardening: two-way sync,
// disconnect timestamps, and the races the sync must survive.

// The TTL leaves room for a short Redis outage of one instance (the P-1 case) without
// that instance being judged dead.
const TIMINGS = { INSTANCE_HEARTBEAT_MS: '200', INSTANCE_TTL_MS: '2000' };

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
    h.runtime.presence.onUserOffline(({ userId }) => {
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
    h.runtime.presence.onUserOffline(({ userId, reason }) => {
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

// ── Phase 4A: presence hardening ──────────────────────────────────────────────────────

const redisNow = () => redisTimeMs(requireHarness().redis);

/**
 * A presence store for a made-up live instance on the shared Redis, so a test controls
 * exactly which sockets that instance "serves".
 */
const scratchInstance = async () => {
  const h = requireHarness();
  const instanceId = randomUUID();
  await h.redis.zadd(redisKeys.instances, await redisNow(), instanceId);
  const store = createPresenceStore({ redis: h.redis, instanceId, instanceTtlMs: 60_000 });
  const entry = (socket: SocketRef) => `${instanceId}:${socket.socketId}`;
  return { instanceId, store, entry };
};

const ref = (socketId: string, userId: string = randomUUID()): SocketRef => ({ userId, socketId });

describe('sync (two-way, against the live sockets)', () => {
  it('writes nothing when Redis already matches the live sockets', async () => {
    const { store } = await scratchInstance();
    const a = ref('a');
    await store.add(a);

    const result = await store.sync(() => [a]);

    expect(result).toEqual({
      added: 0,
      removed: 0,
      cameOnline: [],
      wentOffline: [],
      syncedAtMs: undefined,
    });
  });

  it('adds live sockets missing from Redis to both sets and reports them online', async () => {
    const { instanceId, store, entry } = await scratchInstance();
    const a = ref('a');

    const result = await store.sync(() => [a]);

    expect(result).toMatchObject({ added: 1, removed: 0, cameOnline: [a.userId] });
    expect(await userEntries(a.userId)).toEqual([entry(a)]);
    expect(await instanceEntries(instanceId)).toEqual([`${a.userId}:a`]);
  });

  it('removes stale entries from both sets and reports users left without a socket', async () => {
    const { instanceId, store } = await scratchInstance();
    const gone = ref('gone');
    const kept = ref('kept');
    const keptUsersStaleTab = ref('stale-tab', kept.userId);
    await store.add(gone);
    await store.add(kept);
    await store.add(keptUsersStaleTab);
    const before = await redisNow();

    const result = await store.sync(() => [kept]);

    expect(result).toMatchObject({ added: 0, removed: 2, wentOffline: [gone.userId] });
    expect(result.syncedAtMs).toBeGreaterThanOrEqual(before);
    expect(await userEntries(gone.userId)).toEqual([]);
    expect(await userEntries(kept.userId)).toHaveLength(1);
    expect(await instanceEntries(instanceId)).toEqual([`${kept.userId}:kept`]);
  });

  it('adds and removes in the same sync', async () => {
    const { instanceId, store } = await scratchInstance();
    const stale = ref('stale');
    const fresh = ref('fresh');
    await store.add(stale);

    const result = await store.sync(() => [fresh]);

    expect(result).toMatchObject({
      added: 1,
      removed: 1,
      cameOnline: [fresh.userId],
      wentOffline: [stale.userId],
    });
    expect(await instanceEntries(instanceId)).toEqual([`${fresh.userId}:fresh`]);
  });
});

describe('a disconnect racing a sync (P-2)', () => {
  it('never re-adds a socket that disconnects right after the sync read the live sockets', async () => {
    const { instanceId, store } = await scratchInstance();
    const racer = ref('racer');
    let live = [racer];
    let removal: ReturnType<typeof store.remove> | undefined;

    // The socket is missing from Redis (say, after data loss), so the sync must add it.
    // It disconnects immediately after the sync took its snapshot: the removal is queued
    // after the sync's write on the same connection, so it wins.
    const synced = await store.sync(() => {
      const snapshot = [...live];
      queueMicrotask(() => {
        live = [];
        removal = store.remove(racer);
      });
      return snapshot;
    });

    expect(synced.added).toBe(1);
    expect(await removal).toMatchObject({ removed: true, userOffline: true });
    expect(await userEntries(racer.userId)).toEqual([]);
    expect(await instanceEntries(instanceId)).toEqual([]);
  });

  it('removes and reports once a socket that disconnects while the sync reads Redis', async () => {
    const { instanceId, store } = await scratchInstance();
    const racer = ref('racer');
    await store.add(racer);
    let live = [racer];

    // The sync has already asked for the index (which still lists the socket); the
    // disconnect removes it before the sync looks at the live sockets.
    const syncing = store.sync(() => live);
    live = [];
    const removal = await store.remove(racer);
    const synced = await syncing;

    // Exactly one path reports the user offline: the one that removed the entry.
    expect(removal).toMatchObject({ removed: true, userOffline: true });
    expect(synced).toMatchObject({ removed: 0, wentOffline: [] });
    expect(await userEntries(racer.userId)).toEqual([]);
    expect(await instanceEntries(instanceId)).toEqual([]);
  });

  it('converges with no ghost entries when many sockets disconnect during re-assertion', async () => {
    const h = requireHarness();
    const user = await signUpTestUser(h, 'many-tabs');
    const tabs = await Promise.all(
      Array.from({ length: 12 }, () => connectSocket(h.baseUrl, user.accessToken)),
    );
    await waitFor(async () => (await userEntries(user.userId)).length === 12);

    // This user's presence is lost from both sets (as after data loss); re-assertion
    // races half the tabs closing.
    const indexed = tabs.map((tab) => `${user.userId}:${String(tab.id)}`);
    await h.redis
      .multi()
      .del(redisKeys.userSockets(user.userId))
      .srem(redisKeys.instanceSockets(h.runtime.instanceId), ...indexed)
      .exec();
    const syncs = Promise.all([h.runtime.presence.syncLocal(), h.runtime.presence.syncLocal()]);
    for (const tab of tabs.slice(0, 6)) {
      tab.disconnect();
    }
    await syncs;

    const remaining = tabs.slice(6).map((tab) => `${h.runtime.instanceId}:${String(tab.id)}`);
    await waitFor(async () => (await userEntries(user.userId)).length === 6);
    await h.runtime.presence.syncLocal();
    expect((await userEntries(user.userId)).sort()).toEqual(remaining.sort());
  });
});

describe('disconnectedAtMs', () => {
  it('is the Redis TIME of the removal for a normal disconnect', async () => {
    const h = requireHarness();
    const user = await signUpTestUser(h);
    const events: UserOfflineEvent[] = [];
    h.runtime.presence.onUserOffline((event) => {
      if (event.userId === user.userId) {
        events.push(event);
      }
    });
    const socket = await connectSocket(h.baseUrl, user.accessToken);
    await waitFor(() => isOnline(user.userId));

    const before = await redisNow();
    socket.disconnect();
    await waitFor(() => Promise.resolve(events.length === 1));
    const after = await redisNow();

    expect(events[0]?.reason).toBe('disconnect');
    expect(events[0]?.disconnectedAtMs).toBeGreaterThanOrEqual(before);
    expect(events[0]?.disconnectedAtMs).toBeLessThanOrEqual(after);
  });
});

describe('a missed disconnect (P-1) on one of two instances', () => {
  it('is detected by the next sync once Redis is back, and reported as missed', async () => {
    const h = requireHarness();
    const container = h.redisContainer;
    const proxy = await startTcpProxy(container.getHost(), container.getPort());
    try {
      const flaky = await startInstance(h, {
        ...TIMINGS,
        ROLE: 'api',
        REDIS_URL: `redis://127.0.0.1:${String(proxy.port)}`,
      });
      const user = await signUpTestUser(h, 'missed');
      const events: UserOfflineEvent[] = [];
      flaky.runtime.presence.onUserOffline((event) => {
        if (event.userId === user.userId) {
          events.push(event);
        }
      });
      const socket = await connectSocket(flaky.baseUrl, user.accessToken);
      await waitFor(async () => (await userEntries(user.userId)).length === 1);

      // Redis becomes unreachable for this instance only, and the user leaves
      // meanwhile: the disconnect handler cannot remove the entry.
      await proxy.cut();
      await waitFor(() => Promise.resolve(flaky.runtime.redis.status !== 'ready'));
      socket.disconnect();
      await waitFor(() => Promise.resolve(flaky.runtime.io.of('/').sockets.size === 0));
      expect(await userEntries(user.userId)).toHaveLength(1);
      expect(events).toEqual([]);

      const restoredAt = await redisNow();
      await proxy.restore();

      await waitFor(async () => (await userEntries(user.userId)).length === 0);
      await waitFor(() => Promise.resolve(events.length === 1));
      expect(events[0]?.reason).toBe('missed_disconnect');
      expect(events[0]?.disconnectedAtMs).toBeGreaterThanOrEqual(restoredAt);
      expect(await instanceEntries(flaky.runtime.instanceId)).toEqual([]);
      expect(await isOnline(user.userId)).toBe(false);
    } finally {
      await proxy.restore();
    }
  });
});

describe('Redis reconnect (regression)', () => {
  it('repairs both missing and stale entries after the connection comes back', async () => {
    const h = requireHarness();
    const user = await signUpTestUser(h);
    const socket = await connectSocket(h.baseUrl, user.accessToken);
    const real = `${h.runtime.instanceId}:${String(socket.id)}`;
    await waitFor(async () => (await userEntries(user.userId)).length === 1);

    // A lost write and a ghost left behind, then a Redis restart (connections dropped).
    await h.redis
      .multi()
      .srem(redisKeys.userSockets(user.userId), real)
      .srem(redisKeys.instanceSockets(h.runtime.instanceId), `${user.userId}:${String(socket.id)}`)
      .sadd(redisKeys.userSockets(user.userId), `${h.runtime.instanceId}:ghost`)
      .sadd(redisKeys.instanceSockets(h.runtime.instanceId), `${user.userId}:ghost`)
      .exec();
    const killer = new Redis(h.redisContainer.getConnectionUrl());
    try {
      await killer.call('CLIENT', 'KILL', 'TYPE', 'normal');
    } finally {
      killer.disconnect();
    }

    await waitFor(async () => {
      const entries = await userEntries(user.userId);
      return entries.length === 1 && entries[0] === real;
    });
    expect(await instanceEntries(h.runtime.instanceId)).not.toContain(`${user.userId}:ghost`);
  });
});
