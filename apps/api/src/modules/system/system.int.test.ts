import {
  API_BASE_PATH,
  errorBodySchema,
  healthPaths,
  livenessResponseSchema,
  readinessResponseSchema,
} from '@focus-flow/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestHarness, type TestHarness } from '../../../test/harness.js';

let harness: TestHarness | undefined;
let redisStopped = false;

const requireHarness = (): TestHarness => {
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
  if (harness !== undefined && !redisStopped) {
    redisStopped = true;
    await harness.redisContainer.stop();
  }
};

beforeAll(async () => {
  harness = await startTestHarness();
  await waitUntilReady();
}, 120_000);

afterAll(async () => {
  if (harness === undefined) {
    return;
  }
  const { server, pool, redis, postgresContainer } = harness;

  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  redis.disconnect();
  await pool.end();

  // Idempotent: the Redis-down test below may already have stopped this container.
  await stopRedisContainer();
  await postgresContainer.stop();
}, 60_000);

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
