import type { DependencyStatus } from '@focus-flow/contracts';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';

import type { AppConfig } from './config.js';
import { withTimeout } from './timeout.js';

/**
 * The general connection: application keys (presence, heartbeats, epoch, revocation)
 * under `REDIS_KEY_PREFIX` (P3). It fails fast rather than queueing commands while
 * Redis is down, so readiness and request paths never hang on an outage.
 */
export const createRedisClient = (config: AppConfig, logger: Logger): Redis => {
  const client = new Redis(config.REDIS_URL, {
    keyPrefix: config.REDIS_KEY_PREFIX,
    lazyConnect: false,
    // Readiness must fail fast rather than queue commands while Redis is down.
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });

  client.on('error', (error: Error) => {
    logger.warn({ err: error }, 'Redis client error');
  });

  return client;
};

/**
 * Connections the general client cannot serve (docs/architecture/redis-keys.md,
 * "Configuration"). Neither uses ioredis `keyPrefix`:
 * - `bullmq`: BullMQ does not support ioredis `keyPrefix` (it has its own `prefix`
 *   option) and its workers issue blocking commands that need `maxRetriesPerRequest:
 *   null`.
 * - `pubsub`: the Socket.IO adapter's publisher and subscriber. A subscribed connection
 *   can run nothing else, and channel names are namespaced by the adapter's own `key`.
 */
export type RedisConnectionRole = 'bullmq' | 'pubsub';

export const createRedisConnection = (
  config: AppConfig,
  logger: Logger,
  role: RedisConnectionRole,
): Redis => {
  const client = new Redis(
    config.REDIS_URL,
    role === 'bullmq' ? { maxRetriesPerRequest: null } : { maxRetriesPerRequest: 1 },
  );

  client.on('error', (error: Error) => {
    logger.warn({ err: error, role }, 'Redis connection error');
  });

  return client;
};

/**
 * Converts a Redis `TIME` reply (`[seconds, microseconds]`, returned as strings at
 * runtime despite the typings) to epoch milliseconds.
 */
export const redisTimeReplyToMs = (reply: unknown): number => {
  if (!Array.isArray(reply) || reply.length !== 2) {
    throw new Error('unexpected Redis TIME reply');
  }
  const seconds = Number(reply[0]);
  const micros = Number(reply[1]);
  if (!Number.isInteger(seconds) || !Number.isInteger(micros)) {
    throw new Error('unexpected Redis TIME reply');
  }
  return seconds * 1_000 + Math.floor(micros / 1_000);
};

/**
 * The authoritative clock for protocol arithmetic (approved: heartbeats, `time:sync`,
 * and later the room timer). API server clocks are never used for these, so two API
 * hosts with skewed clocks still agree.
 */
export const redisTimeMs = async (client: Pick<Redis, 'time'>): Promise<number> =>
  redisTimeReplyToMs(await client.time());

/** Resolves once the client is connected and ready, or rejects after `timeoutMs`. */
export const waitForRedisReady = (client: Redis, timeoutMs: number): Promise<void> => {
  if (client.status === 'ready') {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('ready', onReady);
      reject(new Error(`Redis was not ready within ${String(timeoutMs)} ms`));
    }, timeoutMs);
    const onReady = (): void => {
      clearTimeout(timer);
      resolve();
    };
    client.once('ready', onReady);
  });
};

export const checkRedis = (client: Redis, timeoutMs = 1_500): Promise<DependencyStatus> => {
  const probe = async (): Promise<DependencyStatus> => {
    try {
      await client.ping();
      return 'ok';
    } catch {
      return 'unavailable';
    }
  };

  return withTimeout(probe(), timeoutMs, 'unavailable');
};
