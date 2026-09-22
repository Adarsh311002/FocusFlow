import type { DependencyStatus } from '@focus-flow/contracts';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';

import type { AppConfig } from './config.js';
import { withTimeout } from './timeout.js';

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
