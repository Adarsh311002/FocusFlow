import { type AppConfig, loadConfig } from './platform/config.js';
import { createPool } from './platform/db.js';
import { createApp } from './platform/http/app.js';
import { createLogger } from './platform/logger.js';
import { createRedisClient } from './platform/redis.js';
import { registerShutdownHandlers } from './platform/shutdown.js';

const loadConfigOrExit = (): AppConfig => {
  try {
    return loadConfig();
  } catch (error) {
    // The logger itself is configured from the environment, so this is the one place
    // that has to report a failure without it.
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Cannot start the API.\n${message}\n`);
    process.exit(1);
  }
};

const main = (): void => {
  const config = loadConfigOrExit();
  const logger = createLogger(config);
  const pool = createPool(config, logger);
  const redis = createRedisClient(config, logger);
  const app = createApp({ config, logger, pool, redis });

  const server = app.listen(config.PORT, config.HOST, () => {
    logger.info({ host: config.HOST, port: config.PORT, appEnv: config.APP_ENV }, 'API listening');
  });

  registerShutdownHandlers({
    server,
    pool,
    redis,
    logger,
    timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
  });
};

main();
