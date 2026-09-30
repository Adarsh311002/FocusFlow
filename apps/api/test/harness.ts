import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Redis } from 'ioredis';
import pg, { type Pool } from 'pg';

import type { Db } from '../src/db/client.js';
import type { AuthDeps } from '../src/modules/auth/service.js';
import { type AppConfig, loadConfig } from '../src/platform/config.js';
import { createRuntime, type Runtime } from '../src/platform/runtime.js';

// A short-lived JWT signing key for tests only. Never used outside a Testcontainers
// instance that is destroyed at the end of the run.
const TEST_JWT_SECRET = 'test1:0123456789abcdef0123456789abcdef';

export type TestInstance = {
  readonly runtime: Runtime;
  readonly baseUrl: string;
};

export type TestHarness = {
  readonly server: Server;
  readonly baseUrl: string;
  readonly pool: Pool;
  readonly redis: Redis;
  readonly db: Db;
  readonly config: AppConfig;
  readonly authDeps: AuthDeps;
  /** The first API instance; `startInstance` adds more on the same containers. */
  readonly runtime: Runtime;
  readonly postgresContainer: StartedPostgreSqlContainer;
  readonly redisContainer: StartedRedisContainer;
  /** Extra instances started by `startInstance`, stopped with the harness. */
  readonly extraInstances: TestInstance[];
};

type ConfigOverrides = Partial<Record<string, string>>;

/** The configuration an instance on this harness’s containers would use. */
export const configFor = (harness: TestHarness, overrides: ConfigOverrides = {}): AppConfig =>
  buildConfig(harness.postgresContainer, harness.redisContainer, overrides);

const buildConfig = (
  postgres: StartedPostgreSqlContainer,
  redis: StartedRedisContainer,
  overrides: ConfigOverrides,
): AppConfig =>
  loadConfig({
    APP_ENV: 'test',
    LOG_LEVEL: 'error',
    DATABASE_URL: postgres.getConnectionUri(),
    REDIS_URL: redis.getConnectionUrl(),
    REDIS_KEY_PREFIX: 'ff-test:',
    JWT_ACCESS_SECRETS: TEST_JWT_SECRET,
    ...overrides,
  });

const startRuntime = async (config: AppConfig): Promise<TestInstance> => {
  const runtime = await createRuntime(config);
  try {
    const port = await runtime.start({ port: 0, host: '127.0.0.1' });
    if (port === undefined) {
      throw new Error('the test instance did not listen (is ROLE=worker?)');
    }
    return { runtime, baseUrl: `http://127.0.0.1:${String(port)}` };
  } catch (error) {
    await runtime.stop();
    throw error;
  }
};

/**
 * Starts real PostgreSQL and Redis containers (same engines as local development,
 * infra/compose.yaml), applies every committed migration, and boots the full API through
 * the same `createRuntime` that `main.ts` uses, on an ephemeral port. Shared by every
 * integration test so each one exercises the actual migration files and startup order.
 */
export const startTestHarness = async (overrides: ConfigOverrides = {}): Promise<TestHarness> => {
  const postgresContainer = await new PostgreSqlContainer('postgres:18').start();
  try {
    const redisContainer = await new RedisContainer('redis:7.4-alpine').start();
    try {
      const migrationPool = new pg.Pool({ connectionString: postgresContainer.getConnectionUri() });
      try {
        await migrate(drizzle(migrationPool), {
          migrationsFolder: fileURLToPath(new URL('../src/db/migrations', import.meta.url)),
        });
      } finally {
        await migrationPool.end();
      }

      const config = buildConfig(postgresContainer, redisContainer, overrides);
      const { runtime, baseUrl } = await startRuntime(config);

      return {
        server: runtime.server,
        baseUrl,
        pool: runtime.pool,
        redis: runtime.redis,
        db: runtime.db,
        config,
        authDeps: runtime.authDeps,
        runtime,
        postgresContainer,
        redisContainer,
        extraInstances: [],
      };
    } catch (error) {
      await redisContainer.stop();
      throw error;
    }
  } catch (error) {
    await postgresContainer.stop();
    throw error;
  }
};

/**
 * Another API instance on the same PostgreSQL and Redis, as a second process would be in
 * production: its own pools, connections and instance id. Stopped with the harness.
 */
export const startInstance = async (
  harness: TestHarness,
  overrides: ConfigOverrides = {},
): Promise<TestInstance> => {
  const config = buildConfig(harness.postgresContainer, harness.redisContainer, overrides);
  const instance = await startRuntime(config);
  harness.extraInstances.push(instance);
  return instance;
};

export const stopTestHarness = async (harness: TestHarness): Promise<void> => {
  for (const instance of harness.extraInstances) {
    await instance.runtime.stop();
  }
  await harness.runtime.stop();
  await harness.redisContainer.stop();
  await harness.postgresContainer.stop();
};
