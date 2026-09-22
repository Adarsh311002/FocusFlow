import type { DependencyStatus } from '@focus-flow/contracts';
import pg, { type Pool } from 'pg';
import type { Logger } from 'pino';

import type { AppConfig } from './config.js';
import { withTimeout } from './timeout.js';

export const createPool = (config: AppConfig, logger: Logger): Pool => {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    application_name: 'focus-flow-api',
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 2_000,
  });

  // An idle client can fail in the background (server restart, dropped TCP
  // connection). Without a listener that error would be fatal to the process.
  pool.on('error', (error) => {
    logger.warn({ err: error }, 'PostgreSQL pool error on an idle client');
  });

  return pool;
};

export const checkDatabase = (pool: Pool, timeoutMs = 1_500): Promise<DependencyStatus> => {
  const probe = async (): Promise<DependencyStatus> => {
    try {
      await pool.query('SELECT 1');
      return 'ok';
    } catch {
      return 'unavailable';
    }
  };

  return withTimeout(probe(), timeoutMs, 'unavailable');
};
