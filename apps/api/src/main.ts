import { type AppConfig, loadConfig } from './platform/config.js';
import { createRuntime } from './platform/runtime.js';
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

const main = async (): Promise<void> => {
  const config = loadConfigOrExit();
  const runtime = await createRuntime(config);
  const { logger, server, pool, redis } = runtime;

  const port = await runtime.listen(config.PORT, config.HOST);
  logger.info(
    { host: config.HOST, port, appEnv: config.APP_ENV, instanceId: runtime.instanceId },
    'API listening',
  );

  registerShutdownHandlers({
    server,
    pool,
    redis,
    logger,
    timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
    beforeServerClose: runtime.beforeServerClose,
    steps: runtime.shutdownSteps,
  });
};

void main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`The API failed to start.\n${message}\n`);
  process.exit(1);
});
