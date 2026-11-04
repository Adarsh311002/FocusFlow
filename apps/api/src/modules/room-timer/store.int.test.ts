import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { redisKeys } from '../../platform/redis-keys.js';
import { createRoomTimerStore } from './store.js';
import type { RoomTimerStore, TimerState } from './types.js';

// The timer store against a real Redis: version-checked atomic writes, the running index
// kept in step with the state, and the defensive read.

const PREFIX = 'ff-test:';
const ROOM = '0190a000-0000-7000-8000-000000000001';

let container: StartedRedisContainer;
let redis: Redis;
let store: RoomTimerStore;

beforeAll(async () => {
  container = await new RedisContainer('redis:7.4-alpine').start();
  redis = new Redis(container.getConnectionUrl(), { keyPrefix: PREFIX });
  store = createRoomTimerStore(redis);
}, 180_000);

afterAll(async () => {
  redis.disconnect();
  await container.stop();
}, 60_000);

beforeEach(async () => {
  await redis.flushall();
});

const idle = (version: number, overrides: Partial<TimerState> = {}): TimerState => ({
  phase: 'focus',
  status: 'idle',
  durationMs: 1_500_000,
  elapsedBeforeMs: 0,
  segmentStartedAtMs: null,
  version,
  ...overrides,
});

const running = (version: number, startedAtMs: number, overrides: Partial<TimerState> = {}) =>
  idle(version, { status: 'running', segmentStartedAtMs: startedAtMs, ...overrides });

const score = (roomId = ROOM): Promise<string | null> =>
  redis.zscore(redisKeys.runningTimers, roomId);

describe('read', () => {
  it('answers absent for a missing key, with Redis TIME', async () => {
    const read = await store.read(ROOM);
    expect(read.state).toBeUndefined();
    const [seconds] = await redis.time();
    expect(Math.abs(read.nowMs - Number(seconds) * 1000)).toBeLessThan(5000);
  });

  it('round-trips every status, including the nullable segment start', async () => {
    for (const [index, state] of [
      idle(10),
      running(11, 1_700_000_000_000, { elapsedBeforeMs: 5000 }),
      idle(12, {
        status: 'paused',
        elapsedBeforeMs: 1000,
        phase: 'short_break',
        durationMs: 60_000,
      }),
    ].entries()) {
      const roomId = `room-${String(index)}`;
      expect(await store.write(roomId, null, state)).toBe('ok');
      expect((await store.read(roomId)).state).toEqual(state);
    }
  });

  it('throws for a malformed hash instead of treating it as absent', async () => {
    await redis.hset(redisKeys.roomTimer(ROOM), { phase: 'focus', status: 'running' });
    await expect(store.read(ROOM)).rejects.toThrow(/malformed/);
    // …and a write from "absent" cannot silently replace it.
    expect(await store.write(ROOM, null, idle(1))).toBe('conflict');
  });

  it('throws for an inconsistent hash (running without a segment start, elapsed over duration)', async () => {
    const key = redisKeys.roomTimer(ROOM);
    await redis.hset(key, {
      phase: 'focus',
      status: 'running',
      durationMs: '1000',
      elapsedBeforeMs: '0',
      segmentStartedAtMs: '',
      version: '3',
    });
    await expect(store.read(ROOM)).rejects.toThrow(/malformed/);
    await redis.hset(key, { status: 'idle', elapsedBeforeMs: '2000' });
    await expect(store.read(ROOM)).rejects.toThrow(/malformed/);
  });
});

describe('write', () => {
  it('creates only from absent and refuses a second creation', async () => {
    expect(await store.write(ROOM, null, idle(5))).toBe('ok');
    expect(await store.write(ROOM, null, idle(6))).toBe('conflict');
    expect((await store.read(ROOM)).state?.version).toBe(5);
  });

  it('refuses a write against a key that does not exist', async () => {
    expect(await store.write(ROOM, 5, idle(6))).toBe('conflict');
    expect((await store.read(ROOM)).state).toBeUndefined();
  });

  it('accepts the current version and refuses a stale or future one, changing nothing', async () => {
    await store.write(ROOM, null, idle(5));
    expect(await store.write(ROOM, 4, idle(6))).toBe('conflict');
    expect(await store.write(ROOM, 6, idle(7))).toBe('conflict');
    expect((await store.read(ROOM)).state).toEqual(idle(5));
    expect(await store.write(ROOM, 5, idle(6, { phase: 'short_break' }))).toBe('ok');
    expect((await store.read(ROOM)).state).toEqual(idle(6, { phase: 'short_break' }));
  });

  it('keeps the running index equal to the state on every transition', async () => {
    const started = 1_700_000_000_000;
    await store.write(ROOM, null, idle(1));
    expect(await score()).toBeNull();

    await store.write(ROOM, 1, running(2, started));
    expect(await score()).toBe(String(started + 1_500_000));

    // Paused: removed.
    await store.write(ROOM, 2, idle(3, { status: 'paused', elapsedBeforeMs: 10_000 }));
    expect(await score()).toBeNull();

    // Resumed with 10 s already elapsed: the score is the new end.
    await store.write(ROOM, 3, running(4, started + 20_000, { elapsedBeforeMs: 10_000 }));
    expect(await score()).toBe(String(started + 20_000 + 1_500_000 - 10_000));

    // A conflicting write does not touch the index.
    await store.write(ROOM, 1, idle(9));
    expect(await score()).toBe(String(started + 20_000 + 1_500_000 - 10_000));

    // Reset: removed again.
    await store.write(ROOM, 4, idle(5));
    expect(await score()).toBeNull();
    expect(await redis.zcard(redisKeys.runningTimers)).toBe(0);
  });

  it('stores the index member without the key prefix and the hash under the prefix', async () => {
    await store.write(ROOM, null, running(1, 1_000));
    const raw = new Redis(container.getConnectionUrl());
    try {
      expect(await raw.zrange(`${PREFIX}${redisKeys.runningTimers}`, '0', '-1')).toEqual([ROOM]);
      expect(await raw.exists(`${PREFIX}${redisKeys.roomTimer(ROOM)}`)).toBe(1);
    } finally {
      raw.disconnect();
    }
  });

  it('lets exactly one of many parallel writes with the same expected version win', async () => {
    await store.write(ROOM, null, idle(100));
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) => store.write(ROOM, 100, running(101, 1_000 + index))),
    );
    expect(results.filter((result) => result === 'ok')).toHaveLength(1);
    expect(results.filter((result) => result === 'conflict')).toHaveLength(19);
    const state = (await store.read(ROOM)).state;
    expect(state?.version).toBe(101);
    // The index holds the winner's end, not a mixture.
    expect(await score()).toBe(String((state?.segmentStartedAtMs ?? 0) + 1_500_000));
  });

  it('lets exactly one of many parallel creations win', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) => store.write(ROOM, null, idle(index + 1))),
    );
    expect(results.filter((result) => result === 'ok')).toHaveLength(1);
  });
});

describe('due and running', () => {
  const seed = async (): Promise<void> => {
    // End times: a=1500+..., computed from start + 1_500_000.
    await store.write('b-room', null, running(1, 2_000));
    await store.write('a-room', null, running(1, 2_000));
    await store.write('c-room', null, running(1, 1_000));
    await store.write('d-room', null, running(1, 9_000));
    await store.write('idle-room', null, idle(1));
  };

  it('lists due timers oldest first, ties by room id, within the limit', async () => {
    await seed();
    const ends = (start: number): number => start + 1_500_000;
    expect(await store.due(ends(1_000) - 1, 10)).toEqual([]);
    expect(await store.due(ends(1_000), 10)).toEqual(['c-room']);
    expect(await store.due(ends(2_000), 10)).toEqual(['c-room', 'a-room', 'b-room']);
    expect(await store.due(ends(2_000), 2)).toEqual(['c-room', 'a-room']);
    expect(await store.due(ends(9_000), 10)).toEqual(['c-room', 'a-room', 'b-room', 'd-room']);
  });

  it('pages running timers by score then room id', async () => {
    await seed();
    const all = await store.running(0, 10);
    expect(all.map((entry) => entry.roomId)).toEqual(['c-room', 'a-room', 'b-room', 'd-room']);
    expect(all[0]).toEqual({ roomId: 'c-room', endsAtMs: 1_501_000 });
    const first = await store.running(0, 3);
    const second = await store.running(3, 3);
    expect([...first, ...second].map((entry) => entry.roomId)).toEqual(
      all.map((entry) => entry.roomId),
    );
    expect(first).toHaveLength(3);
    expect(second).toHaveLength(1);
    expect(await store.running(4, 3)).toEqual([]);
  });
});

describe('forget', () => {
  it('removes a stale member whose hash is absent', async () => {
    await redis.zadd(redisKeys.runningTimers, '5000', ROOM);
    expect(await store.forget(ROOM)).toBe(true);
    expect(await score()).toBeNull();
    expect(await store.forget(ROOM)).toBe(false);
  });

  it('removes a stale member whose timer is paused or idle', async () => {
    for (const state of [idle(1, { status: 'paused', elapsedBeforeMs: 5 }), idle(1)]) {
      await redis.del(redisKeys.roomTimer(ROOM));
      await store.write(ROOM, null, state);
      await redis.zadd(redisKeys.runningTimers, '5000', ROOM);
      expect(await store.forget(ROOM)).toBe(true);
      expect(await score()).toBeNull();
      expect((await store.read(ROOM)).state).toEqual(state);
    }
  });

  it('never removes a running timer', async () => {
    await store.write(ROOM, null, running(1, 1_000));
    expect(await store.forget(ROOM)).toBe(false);
    expect(await score()).toBe(String(1_501_000));
  });

  it('never leaves a running timer unindexed when it races a write', async () => {
    for (let round = 0; round < 20; round += 1) {
      await redis.flushall();
      await store.write(ROOM, null, idle(1));
      await redis.zadd(redisKeys.runningTimers, '1', ROOM);
      await Promise.all([
        store.write(ROOM, 1, running(2, 1_000)),
        store.forget(ROOM),
        store.forget(ROOM),
      ]);
      expect((await store.read(ROOM)).state?.status).toBe('running');
      expect(await score()).toBe(String(1_501_000));
    }
  });
});
