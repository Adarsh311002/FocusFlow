import type { Redis } from 'ioredis';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import type { EpochMonitor } from './epoch.js';
import { createInstanceHeartbeat } from './instance.js';

// The heartbeat's retry rules over a scripted Redis: what runs after a heartbeat, and
// that a failed rejoin or tick step is not forgotten.

const logger = pino({ level: 'silent' });

const epoch = {
  check: () => Promise.resolve({ epoch: 'e', change: 'unchanged', created: false }),
} as unknown as EpochMonitor;

/** ZADD answers come from the script, then 0 ("already a member"). */
const scriptedRedis = (zaddReplies: number[], { failTime = false } = {}) => {
  const state = { failTime };
  const redis = {
    time: () =>
      state.failTime
        ? Promise.reject(new Error('Redis is down'))
        : Promise.resolve(['1790000000', '0']),
    zadd: () => Promise.resolve(zaddReplies.shift() ?? 0),
    zrem: () => Promise.resolve(1),
  };
  return { redis: redis as unknown as Redis, state };
};

const heartbeatOn = (redis: Redis) =>
  createInstanceHeartbeat({ redis, logger, instanceId: 'i-1', intervalMs: 60_000, epoch });

describe('rejoin', () => {
  it('retries a failed rejoin on the next heartbeat, although ZADD reports it only once', async () => {
    // First publish adds the member; the second finds it missing (rejoin); later ones
    // find it present again.
    const { redis } = scriptedRedis([1, 1]);
    const heartbeat = heartbeatOn(redis);
    let attempts = 0;
    heartbeat.onRejoined(() => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('presence sync failed');
      }
    });

    await heartbeat.tick('tick');
    expect(attempts).toBe(0);
    await heartbeat.tick('tick');
    expect(attempts).toBe(1);
    await heartbeat.tick('tick');
    expect(attempts).toBe(2);
    await heartbeat.tick('tick');
    expect(attempts).toBe(2);
  });
});

describe('tick handlers', () => {
  it('run after every heartbeat, and a failed one runs again on the next tick', async () => {
    const { redis } = scriptedRedis([1]);
    const heartbeat = heartbeatOn(redis);
    const runs: string[] = [];
    heartbeat.onTick(() => {
      runs.push('sync');
      if (runs.length === 1) {
        throw new Error('presence sync failed');
      }
    });
    heartbeat.onTick(() => {
      runs.push('other');
    });

    await expect(heartbeat.tick('tick')).resolves.toBeUndefined();
    await heartbeat.tick('reconnect');

    expect(runs).toEqual(['sync', 'other', 'sync', 'other']);
  });

  it('are skipped while the heartbeat itself fails', async () => {
    const { redis, state } = scriptedRedis([1], { failTime: true });
    const heartbeat = heartbeatOn(redis);
    let runs = 0;
    heartbeat.onTick(() => {
      runs += 1;
    });

    await heartbeat.tick('tick');
    expect(runs).toBe(0);

    state.failTime = false;
    await heartbeat.tick('tick');
    expect(runs).toBe(1);
  });
});
