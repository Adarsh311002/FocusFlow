import type { Server } from 'node:http';

import {
  API_BASE_PATH,
  errorBodySchema,
  healthPaths,
  livenessResponseSchema,
  readinessResponseSchema,
} from '@focus-flow/contracts';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../platform/config.js';
import { createPool } from '../../platform/db.js';
import { createApp } from '../../platform/http/app.js';
import { createLogger } from '../../platform/logger.js';
import { createRedisClient } from '../../platform/redis.js';

type Harness = {
  server: Server;
  pool: Pool;
  redis: Redis;
  baseUrl: string;
};

let postgresContainer: StartedPostgreSqlContainer | undefined;
let redisContainer: StartedRedisContainer | undefined;
let redisStopped = false;
let harness: Harness | undefined;

const requireHarness = (): Harness => {
  if (harness === undefined) {
    throw new Error('the API harness failed to start');
  }
  return harness;
};

const urlFor = (path: string): string => `${requireHarness().baseUrl}${API_BASE_PATH}${path}`;

const sleep = (ms: number): Promise<void> => {
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, ms);
  });
};

const listeningPort = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve) => {
    server.once('listening', () => {
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected the server to listen on a TCP port');
  }
  return address.port;
};

// The Redis client connects eagerly but not instantly, so readiness is the signal
// that both dependencies are actually usable.
const waitUntilReady = async (): Promise<void> => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await fetch(urlFor(healthPaths.readiness));
    await response.text();
    if (response.status === 200) {
      return;
    }
    await sleep(250);
  }

  throw new Error('the API never reported itself ready');
};

const stopRedisContainer = async (): Promise<void> => {
  if (redisContainer !== undefined && !redisStopped) {
    redisStopped = true;
    await redisContainer.stop();
  }
};

beforeAll(async () => {
  // Same engines as local development (infra/compose.yaml), so tests and dev agree.
  postgresContainer = await new PostgreSqlContainer('postgres:18').start();
  redisContainer = await new RedisContainer('redis:7.4-alpine').start();

  const config = loadConfig({
    APP_ENV: 'test',
    LOG_LEVEL: 'error',
    DATABASE_URL: postgresContainer.getConnectionUri(),
    REDIS_URL: redisContainer.getConnectionUrl(),
    REDIS_KEY_PREFIX: 'ff-int:',
  });

  const logger = createLogger(config);
  const pool = createPool(config, logger);
  const redis = createRedisClient(config, logger);
  const server = createApp({ config, logger, pool, redis }).listen(0);

  harness = { server, pool, redis, baseUrl: `http://127.0.0.1:${await listeningPort(server)}` };

  await waitUntilReady();
});

afterAll(async () => {
  if (harness !== undefined) {
    const { server, pool, redis } = harness;
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    redis.disconnect();
    await pool.end();
    harness = undefined;
  }

  await stopRedisContainer();
  if (postgresContainer !== undefined) {
    await postgresContainer.stop();
  }
});

describe('system endpoints', () => {
  it('answers liveness with the contract shape', async () => {
    const response = await fetch(urlFor(healthPaths.liveness));

    expect(response.status).toBe(200);
    expect(livenessResponseSchema.parse(await response.json())).toEqual({ status: 'ok' });
  });

  it('answers readiness while both dependencies are reachable', async () => {
    const response = await fetch(urlFor(healthPaths.readiness));

    expect(response.status).toBe(200);
    expect(readinessResponseSchema.parse(await response.json())).toEqual({
      status: 'ready',
      checks: { postgres: 'ok', redis: 'ok' },
    });
  });

  it('returns the shared error envelope for an unknown path', async () => {
    const response = await fetch(urlFor('/does-not-exist'));

    expect(response.status).toBe(404);
    const body = errorBodySchema.parse(await response.json());
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toContain('/does-not-exist');
  });

  it('fails readiness but keeps liveness when Redis is gone', async () => {
    await stopRedisContainer();

    const readiness = await fetch(urlFor(healthPaths.readiness));
    expect(readiness.status).toBe(503);
    const body = readinessResponseSchema.parse(await readiness.json());
    expect(body.status).toBe('not_ready');
    expect(body.checks.redis).toBe('unavailable');
    expect(body.checks.postgres).toBe('ok');

    const liveness = await fetch(urlFor(healthPaths.liveness));
    expect(liveness.status).toBe(200);
    expect(livenessResponseSchema.parse(await liveness.json())).toEqual({ status: 'ok' });
  });
});
