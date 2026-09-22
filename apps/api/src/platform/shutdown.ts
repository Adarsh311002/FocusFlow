import type { Server } from 'node:http';

import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { Logger } from 'pino';

/** The few members shutdown needs; the real objects satisfy these structurally. */
export type ShutdownServer = {
  close: (callback: (error?: Error) => void) => unknown;
  closeIdleConnections: () => void;
  closeAllConnections: () => void;
};

export type ShutdownPool = { end: () => Promise<void> };

export type ShutdownRedis = { quit: () => Promise<unknown>; disconnect: () => void };

export type ShutdownLogger = Pick<Logger, 'info' | 'warn' | 'error'>;

export type ShutdownDeps = {
  server: ShutdownServer;
  pool: ShutdownPool;
  redis: ShutdownRedis;
  logger: ShutdownLogger;
  timeoutMs: number;
  /** Terminates the process. Injected so the sequence can be tested without exiting. */
  exit: (code: number) => void;
};

export type Shutdown = (reason: string, exitCode: number) => Promise<void>;

/**
 * Builds the shutdown sequence: stop accepting connections, close idle keep-alive
 * sockets so the drain does not wait for them, then close Redis and PostgreSQL. Every
 * resource gets its own attempt so one failure cannot skip the others, and the
 * sequence runs at most once.
 */
export const createShutdown = ({
  server,
  pool,
  redis,
  logger,
  timeoutMs,
  exit,
}: ShutdownDeps): Shutdown => {
  let shuttingDown = false;

  const closeServer = (): Promise<void> => {
    return new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
      // close() stops new connections but leaves idle keep-alive sockets open, which
      // would otherwise hold the drain until the deadline.
      server.closeIdleConnections();
    });
  };

  return async (reason, exitCode) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ reason }, 'Shutdown started');

    // Requests still in flight get half the budget to finish, then their sockets are
    // cut so the remaining steps can run before the hard deadline.
    const cutConnections = setTimeout(() => {
      server.closeAllConnections();
    }, timeoutMs / 2);
    cutConnections.unref();

    // A hung step must not keep the process alive forever; unref'd so a clean
    // shutdown can still exit before the deadline.
    const forceExit = setTimeout(() => {
      logger.error({ reason, timeoutMs }, 'Shutdown timed out, forcing exit');
      exit(1);
    }, timeoutMs);
    forceExit.unref();

    try {
      await closeServer();
    } catch (error) {
      logger.warn({ err: error }, 'Failed to close the HTTP server cleanly');
    }
    clearTimeout(cutConnections);

    try {
      await redis.quit();
    } catch (error) {
      logger.warn({ err: error }, 'Failed to quit Redis cleanly');
      redis.disconnect();
    }

    try {
      await pool.end();
    } catch (error) {
      logger.warn({ err: error }, 'Failed to close the PostgreSQL pool cleanly');
    }

    clearTimeout(forceExit);
    logger.info({ reason, exitCode }, 'Shutdown complete');
    exit(exitCode);
  };
};

type RegisterDeps = {
  server: Server;
  pool: Pool;
  redis: Redis;
  logger: Logger;
  timeoutMs: number;
};

export const registerShutdownHandlers = (deps: RegisterDeps): void => {
  const { logger } = deps;
  const shutdown = createShutdown({
    ...deps,
    exit: (code) => {
      process.exit(code);
    },
  });

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM', 0);
  });

  process.on('SIGINT', () => {
    void shutdown('SIGINT', 0);
  });

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection');
    void shutdown('unhandledRejection', 1);
  });

  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception');
    void shutdown('uncaughtException', 1);
  });
};
