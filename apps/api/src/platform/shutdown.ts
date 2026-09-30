import type { Server } from 'node:http';

import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { Logger } from 'pino';

import { withTimeout } from './timeout.js';

/** The few members shutdown needs; the real objects satisfy these structurally. */
export type ShutdownServer = {
  /** `false` once closed (Socket.IO's `io.close()` closes the HTTP server it is attached to). */
  readonly listening?: boolean;
  close: (callback: (error?: Error) => void) => unknown;
  closeIdleConnections: () => void;
  closeAllConnections: () => void;
};

export type ShutdownPool = { end: () => Promise<void> };

export type ShutdownRedis = { quit: () => Promise<unknown>; disconnect: () => void };

export type ShutdownLogger = Pick<Logger, 'info' | 'warn' | 'error'>;

/**
 * A named resource to close after the HTTP server stops and before Redis and PostgreSQL
 * are closed (for example the Socket.IO server, the heartbeat, queue workers). Steps run
 * in order; a failing step is logged and never skips the ones after it.
 */
export type ShutdownStep = { readonly name: string; readonly run: () => Promise<void> };

export type ShutdownDeps = {
  server: ShutdownServer;
  pool: ShutdownPool;
  redis: ShutdownRedis;
  logger: ShutdownLogger;
  timeoutMs: number;
  /**
   * Run before the HTTP server is closed. Long-lived connections the server cannot drain
   * on its own (Socket.IO's upgraded WebSockets) must be closed here, or `server.close()`
   * would wait for them until the deadline.
   */
  beforeServerClose?: readonly ShutdownStep[];
  /** Closed between the HTTP server and the data stores, in order. */
  steps?: readonly ShutdownStep[];
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
  beforeServerClose = [],
  steps = [],
  exit,
}: ShutdownDeps): Shutdown => {
  let shuttingDown = false;

  // Each step gets a share of the budget: one hung step (for example a client waiting
  // on a Redis that is gone) is abandoned so the steps after it still run.
  const stepTimeoutMs = timeoutMs / 4;
  const runSteps = async (list: readonly ShutdownStep[]): Promise<void> => {
    for (const step of list) {
      try {
        const finished = await withTimeout(
          step.run().then(() => true),
          stepTimeoutMs,
          false,
        );
        if (!finished) {
          logger.warn({ step: step.name, stepTimeoutMs }, 'Shutdown step timed out; continuing');
        }
      } catch (error) {
        logger.warn({ err: error, step: step.name }, 'Shutdown step failed');
      }
    }
  };

  const closeServer = (): Promise<void> => {
    if (server.listening === false) {
      return Promise.resolve();
    }
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

    await runSteps(beforeServerClose);

    try {
      await closeServer();
    } catch (error) {
      logger.warn({ err: error }, 'Failed to close the HTTP server cleanly');
    }
    clearTimeout(cutConnections);

    await runSteps(steps);

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
  beforeServerClose: readonly ShutdownStep[];
  steps: readonly ShutdownStep[];
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
