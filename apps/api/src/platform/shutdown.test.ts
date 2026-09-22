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
    exit: (code) => {
      exits.push(code);
    },
  });

  return { calls, exits, shutdown };
};

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
