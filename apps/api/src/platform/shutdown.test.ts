import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createShutdown,
  type ShutdownLogger,
  type ShutdownPool,
  type ShutdownRedis,
  type ShutdownServer,
} from './shutdown.js';

const TIMEOUT_MS = 10_000;

type Calls = string[];

const createHarness = (
  overrides: {
    redisQuit?: () => Promise<unknown>;
    poolEnd?: () => Promise<void>;
    /** Models a request that keeps the server open until its socket is cut. */
    lingeringConnection?: boolean;
    beforeServerClose?: string[];
    steps?: string[];
    failingStep?: string;
    hangingStep?: string;
  } = {},
) => {
  const calls: Calls = [];
  const exits: number[] = [];
  let finishClose: (() => void) | undefined;

  const server: ShutdownServer = {
    close(callback) {
      calls.push('server.close');
      if (overrides.lingeringConnection === true) {
        finishClose = () => {
          callback();
        };
      } else {
        callback();
      }
    },
    closeIdleConnections() {
      calls.push('server.closeIdleConnections');
    },
    closeAllConnections() {
      calls.push('server.closeAllConnections');
      finishClose?.();
    },
  };

  const redis: ShutdownRedis = {
    quit:
      overrides.redisQuit ??
      (() => {
        calls.push('redis.quit');
        return Promise.resolve('OK');
      }),
    disconnect() {
      calls.push('redis.disconnect');
    },
  };

  const pool: ShutdownPool = {
    end:
      overrides.poolEnd ??
      (() => {
        calls.push('pool.end');
        return Promise.resolve();
      }),
  };

  const logger: ShutdownLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };

  const shutdown = createShutdown({
    server,
    pool,
    redis,
    logger,
    timeoutMs: TIMEOUT_MS,
    beforeServerClose: (overrides.beforeServerClose ?? []).map((name) => ({
      name,
      run: () => {
        calls.push(name);
        return Promise.resolve();
      },
    })),
    steps: (overrides.steps ?? []).map((name) => ({
      name,
      run: () => {
        calls.push(name);
        if (name === overrides.hangingStep) {
          return new Promise<void>(() => undefined);
        }
        return name === overrides.failingStep
          ? Promise.reject(new Error(`${name} failed`))
          : Promise.resolve();
      },
    })),
    exit: (code) => {
      exits.push(code);
    },
  });

  return { calls, exits, shutdown };
};

describe('createShutdown steps', () => {
  it('runs pre-close steps before the server, other steps between the server and the stores', async () => {
    const { calls, exits, shutdown } = createHarness({
      beforeServerClose: ['socket.io'],
      steps: ['heartbeat', 'presence', 'worker', 'queue', 'connections'],
    });

    await shutdown('SIGTERM', 0);

    const order = calls.filter((call) => call !== 'server.closeIdleConnections');
    // The approved Phase 3 order: Socket.IO, HTTP, heartbeat and presence, the BullMQ worker
    // and queue, the remaining Redis connections, then the general Redis client and PostgreSQL.
    expect(order).toEqual([
      'socket.io',
      'server.close',
      'heartbeat',
      'presence',
      'worker',
      'queue',
      'connections',
      'redis.quit',
      'pool.end',
    ]);
    expect(exits).toEqual([0]);
  });

  it('keeps going when a step fails, so later resources are still closed', async () => {
    const { calls, exits, shutdown } = createHarness({
      steps: ['heartbeat', 'workers'],
      failingStep: 'heartbeat',
    });

    await shutdown('SIGTERM', 0);

    expect(calls).toContain('workers');
    expect(calls).toContain('redis.quit');
    expect(calls).toContain('pool.end');
    expect(exits).toEqual([0]);
  });
});

describe('createShutdown step budget', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('abandons a hung step after its share of the budget and still closes what follows', async () => {
    const { calls, exits, shutdown } = createHarness({
      steps: ['worker', 'heartbeat'],
      hangingStep: 'worker',
    });

    const done = shutdown('SIGTERM', 0);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS / 4 + 1);
    await done;

    expect(calls).toContain('heartbeat');
    expect(calls).toContain('redis.quit');
    expect(calls).toContain('pool.end');
    expect(exits).toEqual([0]);
  });
});

describe('createShutdown step invocation', () => {
  const timesCalled = (calls: Calls, name: string): number =>
    calls.filter((call) => call === name).length;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs every step exactly once, before and after the server closes', async () => {
    const { calls, shutdown } = createHarness({
      beforeServerClose: ['socket.io'],
      steps: ['heartbeat', 'presence', 'worker', 'queue', 'connections'],
    });

    await shutdown('SIGTERM', 0);

    for (const name of ['socket.io', 'heartbeat', 'presence', 'worker', 'queue', 'connections']) {
      expect(timesCalled(calls, name), name).toBe(1);
    }
    expect(timesCalled(calls, 'server.close')).toBe(1);
    expect(timesCalled(calls, 'redis.quit')).toBe(1);
    expect(timesCalled(calls, 'pool.end')).toBe(1);
  });

  it('runs a hanging step exactly once: it is abandoned after its budget, never retried', async () => {
    const { calls, exits, shutdown } = createHarness({
      steps: ['worker', 'heartbeat'],
      hangingStep: 'worker',
    });

    const done = shutdown('SIGTERM', 0);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS / 4 + 1);
    await done;
    // Well past the whole deadline: still no second attempt.
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 2);

    expect(timesCalled(calls, 'worker')).toBe(1);
    expect(timesCalled(calls, 'heartbeat')).toBe(1);
    expect(exits).toEqual([0]);
  });

  it('runs a failing step exactly once and continues with the next', async () => {
    const { calls, exits, shutdown } = createHarness({
      steps: ['worker', 'heartbeat'],
      failingStep: 'worker',
    });

    await shutdown('SIGTERM', 0);

    expect(timesCalled(calls, 'worker')).toBe(1);
    expect(timesCalled(calls, 'heartbeat')).toBe(1);
    expect(exits).toEqual([0]);
  });

  it('runs every step exactly once even when shutdown is signalled twice', async () => {
    const { calls, shutdown } = createHarness({
      beforeServerClose: ['socket.io'],
      steps: ['worker'],
    });

    await Promise.all([shutdown('SIGTERM', 0), shutdown('SIGINT', 0)]);

    expect(timesCalled(calls, 'socket.io')).toBe(1);
    expect(timesCalled(calls, 'worker')).toBe(1);
  });
});

describe('createShutdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes the server, drops idle sockets, then Redis and PostgreSQL, and exits with the code', async () => {
    const { calls, exits, shutdown } = createHarness();

    await shutdown('SIGTERM', 0);

    expect(calls).toEqual([
      'server.close',
      'server.closeIdleConnections',
      'redis.quit',
      'pool.end',
    ]);
    expect(exits).toEqual([0]);
  });

  it('runs only once when signalled twice', async () => {
    const { calls, exits, shutdown } = createHarness();

    await Promise.all([shutdown('SIGTERM', 0), shutdown('SIGINT', 0)]);

    expect(calls.filter((call) => call === 'server.close')).toHaveLength(1);
    expect(exits).toEqual([0]);
  });

  it('still closes PostgreSQL when Redis fails to quit', async () => {
    const { calls, exits, shutdown } = createHarness({
      redisQuit: () => Promise.reject(new Error('connection lost')),
    });

    await shutdown('SIGTERM', 0);

    expect(calls).toContain('redis.disconnect');
    expect(calls).toContain('pool.end');
    expect(exits).toEqual([0]);
  });

  it('exits with the failure code it was asked for', async () => {
    const { exits, shutdown } = createHarness();

    await shutdown('uncaughtException', 1);

    expect(exits).toEqual([1]);
  });

  it('cuts a lingering connection halfway through the budget, then finishes cleanly', async () => {
    const { calls, exits, shutdown } = createHarness({ lingeringConnection: true });
    void shutdown('SIGTERM', 0);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS / 2 - 1);
    expect(calls).not.toContain('server.closeAllConnections');
    expect(exits).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);

    expect(calls).toContain('server.closeAllConnections');
    expect(calls).toContain('pool.end');
    expect(exits).toEqual([0]);
  });

  it('forces exit with code 1 at the deadline when a step hangs', async () => {
    const { calls, exits, shutdown } = createHarness({
      poolEnd: () => new Promise<void>(() => undefined),
    });
    void shutdown('SIGTERM', 0);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(exits).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);

    expect(calls).toContain('redis.quit');
    expect(exits).toEqual([1]);
  });
});
