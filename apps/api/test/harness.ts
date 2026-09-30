import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

import { createDb, type Db } from '../src/db/client.js';
import type { AuthDeps } from '../src/modules/auth/service.js';
import { type AppConfig, loadConfig } from '../src/platform/config.js';
import { createPool } from '../src/platform/db.js';
import { createApp } from '../src/platform/http/app.js';
import { createLogger } from '../src/platform/logger.js';
import { createRedisClient } from '../src/platform/redis.js';

// A short-lived JWT signing key for tests only. Never used outside a Testcontainers
// instance that is destroyed at the end of the run.
const TEST_JWT_SECRET = 'test1:0123456789abcdef0123456789abcdef';

export type TestHarness = {
  readonly server: Server;
  readonly baseUrl: string;
  readonly pool: Pool;
  readonly redis: Redis;
  readonly db: Db;
  readonly config: AppConfig;
  readonly authDeps: AuthDeps;
  readonly postgresContainer: StartedPostgreSqlContainer;
  readonly redisContainer: StartedRedisContainer;
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

/**
 * Starts real PostgreSQL and Redis containers (same engines as local development,
 * infra/compose.yaml), applies every committed migration, and boots the full app on
 * an ephemeral port. Shared by every integration test so each one exercises the
 * actual migration files, not just the Drizzle schema definitions.
 */
export const startTestHarness = async (
  configOverrides: Partial<Record<string, string>> = {},
): Promise<TestHarness> => {
  const postgresContainer = await new PostgreSqlContainer('postgres:18').start();
  try {
    const redisContainer = await new RedisContainer('redis:7.4-alpine').start();
    try {
      const config = loadConfig({
        APP_ENV: 'test',
        LOG_LEVEL: 'error',
        DATABASE_URL: postgresContainer.getConnectionUri(),
        REDIS_URL: redisContainer.getConnectionUrl(),
        REDIS_KEY_PREFIX: 'ff-test:',
        JWT_ACCESS_SECRETS: TEST_JWT_SECRET,
        ...configOverrides,
      });

      const logger = createLogger(config);
      const pool = createPool(config, logger);
      const redis = createRedisClient(config, logger);
      const db = createDb(pool);

      try {
        await migrate(drizzle(pool), {
          migrationsFolder: fileURLToPath(new URL('../src/db/migrations', import.meta.url)),
        });

        const authDeps: AuthDeps = {
          db,
          redis,
          logger,
          jwtKeys: config.JWT_ACCESS_SECRETS,
          jwtIssuer: config.JWT_ISSUER,
          jwtAudience: config.JWT_AUDIENCE,
          accessTokenTtlSeconds: config.ACCESS_TOKEN_TTL_SECONDS,
          refreshTokenTtlSeconds: config.REFRESH_TOKEN_TTL_SECONDS,
          refreshOverlapSeconds: config.REFRESH_OVERLAP_SECONDS,
        };

        const server = createApp({ config, logger, pool, redis, authDeps }).listen(0);
        const port = await listeningPort(server);

        return {
          server,
          baseUrl: `http://127.0.0.1:${port}`,
          pool,
          redis,
          db,
          config,
          authDeps,
          postgresContainer,
          redisContainer,
        };
      } catch (error) {
        redis.disconnect();
        await pool.end();
        throw error;
      }
    } catch (error) {
      await redisContainer.stop();
      throw error;
    }
  } catch (error) {
    await postgresContainer.stop();
    throw error;
  }
};

export const stopTestHarness = async (harness: TestHarness): Promise<void> => {
  harness.server.closeAllConnections();
  await new Promise<void>((resolve) => {
    harness.server.close(() => {
      resolve();
    });
  });
  harness.redis.disconnect();
  await harness.pool.end();
  await harness.redisContainer.stop();
  await harness.postgresContainer.stop();
};
