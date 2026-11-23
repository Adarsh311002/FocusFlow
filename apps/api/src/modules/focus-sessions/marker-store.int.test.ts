import { randomUUID } from 'node:crypto';

import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestHarness, stopTestHarness, type TestHarness } from '../../../test/harness.js';
import { createRedisClient, waitForRedisReady } from '../../platform/redis.js';
import { redisKeys } from '../../platform/redis-keys.js';
import type { DisconnectMarker } from './decision.js';
import { formatMarker, MARKER_TTL_MS } from './marker.js';
import { createDisconnectMarkerStore, type DisconnectMarkerStore } from './marker-store.js';

// The marker store against a real Redis: the E10 rules applied with WATCH/MULTI, including
// genuinely concurrent writers on separate connections (separate "processes").

let harness: TestHarness | undefined;
const connections: Redis[] = [];

const requireHarness = (): TestHarness => {
  if (harness === undefined) {
    throw new Error('the harness failed to start');
  }
  return harness;
};

/** A dedicated connection (fail-fast like the general client), once it is ready. */
const newConnection = async (): Promise<Redis> => {
  const h = requireHarness();
  const redis = createRedisClient(h.config, h.runtime.logger);
  connections.push(redis);
  await waitForRedisReady(redis, 10_000);
  return redis;
};

/** A store on its own dedicated connection, as each API process has. */
const newStore = async (): Promise<DisconnectMarkerStore> =>
  createDisconnectMarkerStore({ redis: await newConnection() });

const R = 1_791_000_000_000;
const marker = (
  sessionId: string,
  disconnectedAtMs: number,
  evidence: DisconnectMarker['evidence'] = 'observed',
): DisconnectMarker => ({ sessionId, disconnectedAtMs, evidence });

const rawMarker = (userId: string) =>
  requireHarness().redis.get(redisKeys.userDisconnected(userId));

beforeAll(async () => {
  harness = await startTestHarness();
}, 180_000);

afterAll(async () => {
  for (const connection of connections) {
    connection.disconnect();
  }
  if (harness !== undefined) {
    await stopTestHarness(harness);
  }
}, 60_000);

describe('record and read', () => {
  it('stores the formatted value under the user’s key, with the safety TTL', async () => {
    const store = await newStore();
    const userId = randomUUID();
    const sessionId = randomUUID();
    const result = await store.record(userId, marker(sessionId, R + 5_000), R);

    expect(result).toMatchObject({ action: 'write', kind: 'created' });
    expect(await rawMarker(userId)).toBe(formatMarker(marker(sessionId, R + 5_000)));
    expect(await store.read(userId)).toEqual(marker(sessionId, R + 5_000));
    const ttl = await requireHarness().redis.pttl(redisKeys.userDisconnected(userId));
    expect(ttl).toBeGreaterThan(MARKER_TTL_MS - 60_000);
    expect(ttl).toBeLessThanOrEqual(MARKER_TTL_MS);
  });

  it('applies the E10 rules: older keeps, newer replaces, equal upgrades, other session replaces', async () => {
    const store = await newStore();
    const userId = randomUUID();
    const s1 = randomUUID();
    const s2 = randomUUID();

    await store.record(userId, marker(s1, R + 10_000, 'detected'), R);
    expect((await store.record(userId, marker(s1, R + 9_000), R)).action).toBe('keep');
    expect((await store.record(userId, marker(s1, R + 10_000, 'observed'), R)).action).toBe(
      'write',
    );
    expect(await store.read(userId)).toEqual(marker(s1, R + 10_000, 'observed'));
    expect((await store.record(userId, marker(s1, R + 10_000, 'detected'), R)).action).toBe('keep');
    expect((await store.record(userId, marker(s1, R + 20_000, 'detected'), R)).action).toBe(
      'write',
    );
    expect(await store.read(userId)).toEqual(marker(s1, R + 20_000, 'detected'));
    await store.record(userId, marker(s2, R + 1_000, 'observed'), R);
    expect(await store.read(userId)).toEqual(marker(s2, R + 1_000, 'observed'));
  });

  it('ignores an event from before the running stretch', async () => {
    const store = await newStore();
    const userId = randomUUID();
    const result = await store.record(userId, marker(randomUUID(), R - 10_000), R);
    expect(result).toEqual({ action: 'keep', reason: 'predates_stretch' });
    expect(await rawMarker(userId)).toBeNull();
  });

  it('reads a malformed value as absent, and a record replaces it', async () => {
    const store = await newStore();
    const userId = randomUUID();
    await requireHarness().redis.set(redisKeys.userDisconnected(userId), 'garbage');
    expect(await store.read(userId)).toBeUndefined();
    const sessionId = randomUUID();
    await store.record(userId, marker(sessionId, R + 1), R);
    expect(await store.read(userId)).toEqual(marker(sessionId, R + 1));
  });
});

describe('clear', () => {
  it('never deletes another session’s marker (the S1 cleanup after S2 started)', async () => {
    const store = await newStore();
    const userId = randomUUID();
    const s1 = randomUUID();
    const s2 = randomUUID();
    await store.record(userId, marker(s2, R + 1_000), R);

    expect(await store.clear(userId, { kind: 'session', sessionId: s1 })).toBe(false);
    expect(await store.clear(userId, { kind: 'upTo', sessionId: s1, upToMs: R + 999_999 })).toBe(
      false,
    );
    expect(await store.read(userId)).toEqual(marker(s2, R + 1_000));
  });

  it('a reconnect clears only up to its confirmation time', async () => {
    const store = await newStore();
    const userId = randomUUID();
    const sessionId = randomUUID();
    await store.record(userId, marker(sessionId, R + 5_000), R);

    expect(await store.clear(userId, { kind: 'upTo', sessionId, upToMs: R + 4_999 })).toBe(false);
    expect(await store.read(userId)).not.toBeUndefined();
    expect(await store.clear(userId, { kind: 'upTo', sessionId, upToMs: R + 5_000 })).toBe(true);
    expect(await rawMarker(userId)).toBeNull();
  });

  it('never deletes a malformed marker (it cannot prove ownership)', async () => {
    const store = await newStore();
    const userId = randomUUID();
    await requireHarness().redis.set(redisKeys.userDisconnected(userId), 'garbage');
    expect(await store.clear(userId, { kind: 'session', sessionId: randomUUID() })).toBe(false);
    expect(await rawMarker(userId)).toBe('garbage');
  });
});

describe('concurrency (WATCH/MULTI)', () => {
  it('concurrent writers on separate connections converge on the latest disconnect', async () => {
    const stores = await Promise.all(Array.from({ length: 4 }, () => newStore()));
    const userId = randomUUID();
    const sessionId = randomUUID();
    const times = Array.from({ length: 40 }, (_unused, index) => R + 1_000 + index * 7);

    await Promise.all(
      times.map((time, index) =>
        stores[index % stores.length]!.record(
          userId,
          marker(sessionId, time, index % 3 === 0 ? 'detected' : 'observed'),
          R,
        ).catch((error: unknown) => error),
      ),
    );

    const latest = Math.max(...times);
    const latestIndex = times.indexOf(latest);
    expect(await stores[0]!.read(userId)).toEqual(
      marker(sessionId, latest, latestIndex % 3 === 0 ? 'detected' : 'observed'),
    );
  });

  it('an upgrade and a newer disconnect racing each other keep the newer disconnect', async () => {
    for (let round = 0; round < 20; round += 1) {
      const [a, b] = await Promise.all([newStore(), newStore()]);
      const userId = randomUUID();
      const sessionId = randomUUID();
      await a.record(userId, marker(sessionId, R + 1_000, 'detected'), R);

      await Promise.all([
        a.record(userId, marker(sessionId, R + 1_000, 'observed'), R),
        b.record(userId, marker(sessionId, R + 2_000, 'detected'), R),
      ]);
      expect(await a.read(userId)).toEqual(marker(sessionId, R + 2_000, 'detected'));
    }
  });

  it('a reconnect clear racing a newer disconnect never deletes the newer disconnect', async () => {
    for (let round = 0; round < 20; round += 1) {
      const [a, b] = await Promise.all([newStore(), newStore()]);
      const userId = randomUUID();
      const sessionId = randomUUID();
      await a.record(userId, marker(sessionId, R + 1_000), R);

      await Promise.all([
        a.clear(userId, { kind: 'upTo', sessionId, upToMs: R + 1_500 }),
        b.record(userId, marker(sessionId, R + 2_000), R),
      ]);
      // Either order ends with the newer disconnect stored.
      expect(await a.read(userId)).toEqual(marker(sessionId, R + 2_000));
    }
  });

  it('gives up after the bounded number of attempts under constant interference', async () => {
    const h = requireHarness();
    const redis = await newConnection();
    const userId = randomUUID();
    const key = redisKeys.userDisconnected(userId);
    // A connection whose every GET is followed by a competing write before EXEC.
    const interfering = new Proxy(redis, {
      get(target, property, receiver) {
        if (property === 'get') {
          return async (name: string) => {
            const value = await target.get(name);
            await h.redis.set(key, formatMarker(marker(randomUUID(), R + Math.random() * 1e6)));
            return value;
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== 'function') {
          return value;
        }
        return (...args: unknown[]): unknown => {
          const result: unknown = Reflect.apply(value, target, args);
          return result;
        };
      },
    });
    const store = createDisconnectMarkerStore({ redis: interfering, maxAttempts: 3 });
    await expect(store.record(userId, marker(randomUUID(), R + 1), R)).rejects.toThrow(
      'kept changing',
    );
  });
});
