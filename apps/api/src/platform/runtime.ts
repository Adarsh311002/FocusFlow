import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { Logger } from 'pino';

import { createDb, type Db } from '../db/client.js';
import type { AuthDeps } from '../modules/auth/service.js';
import { type AppServer, type AppSocket, sessionRoom } from '../modules/realtime/types.js';
import type { AppConfig } from './config.js';
import { createPool } from './db.js';
import { createEpochMonitor, type EpochMonitor } from './epoch.js';
import { createApp } from './http/app.js';
import { createInstanceHeartbeat, type InstanceHeartbeat } from './instance.js';
import { createLogger } from './logger.js';
import { createRedisClient, createRedisConnection, waitForRedisReady } from './redis.js';
import { createShutdown, type ShutdownStep } from './shutdown.js';
import { createSocketEmitter, createSocketServer, type SocketEmitter } from './socket.js';

/** How long startup waits for Redis before continuing without the epoch check. */
const REDIS_STARTUP_WAIT_MS = 5_000;

/**
 * Closes connections gracefully when Redis is reachable. When it is not, `quit()` would
 * wait in the offline queue for a server that is gone, so the connection is dropped.
 */
const closeConnections = async (...clients: Redis[]): Promise<void> => {
  for (const client of clients) {
    if (client.status !== 'ready') {
      client.disconnect();
      continue;
    }
    try {
      await client.quit();
    } catch {
      client.disconnect();
    }
  }
};

/**
 * Stops Socket.IO on this instance only: every local socket is disconnected (their
 * disconnect handlers run while Redis is still open) and the engine stops accepting
 * connections. `io.close()` is deliberately not used: it also closes the Redis adapter,
 * whose un-awaited UNSUBSCRIBE commands would reject when Redis is down; the adapter's
 * subscriptions end with its connection instead.
 */
const closeSocketServer = (io: AppServer): Promise<void> => {
  io.local.disconnectSockets(true);
  io.engine.close();
  return Promise.resolve();
};

/**
 * One API process, fully wired but not yet listening. `main.ts` and the integration-test
 * harness both build it, so tests exercise the real startup order (docs/implementation/
 * plan.md, I5): config → logger → PostgreSQL → Redis → epoch check → Express → HTTP
 * server → … → listen.
 */
export type Runtime = {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly instanceId: string;
  readonly pool: Pool;
  readonly redis: Redis;
  readonly db: Db;
  readonly authDeps: AuthDeps;
  readonly epoch: EpochMonitor;
  readonly heartbeat: InstanceHeartbeat;
  readonly server: Server;
  /** The Socket.IO server attached to `server`, with the Redis adapter. */
  readonly io: AppServer;
  /** Broadcasts through Redis to sockets on every instance. */
  readonly socketEmitter: SocketEmitter;
  /** Hooks run for every authenticated socket (feature modules register here). */
  readonly onSocketConnect: ((socket: AppSocket) => void)[];
  /** Resolves with the bound port once listening; the heartbeat starts then. */
  readonly listen: (port: number, host: string) => Promise<number>;
  /** Closed before the HTTP server (long-lived connections). */
  readonly beforeServerClose: readonly ShutdownStep[];
  /** Closed after the HTTP server, before Redis and PostgreSQL. */
  readonly shutdownSteps: readonly ShutdownStep[];
  /** The graceful shutdown sequence without exiting the process (tests). */
  readonly stop: () => Promise<void>;
};

export type RuntimeOptions = {
  readonly logger?: Logger;
};

export const createRuntime = async (
  config: AppConfig,
  options: RuntimeOptions = {},
): Promise<Runtime> => {
  const logger = options.logger ?? createLogger(config);
  // A process start is always a new instance: a restarted process never inherits the
  // presence of the one that died (docs/architecture/redis-keys.md).
  const instanceId = config.INSTANCE_ID ?? randomUUID();
  const pool = createPool(config, logger);
  const redis = createRedisClient(config, logger);
  const db = createDb(pool);

  const epoch = createEpochMonitor({ redis, logger, instanceId });
  const heartbeat = createInstanceHeartbeat({
    redis,
    logger,
    instanceId,
    intervalMs: config.INSTANCE_HEARTBEAT_MS,
    epoch,
  });
  epoch.onLocalRecovery(() => heartbeat.publish());

  // The epoch is established before anything is served. If Redis is unreachable the API
  // still starts — readiness reports it — and the check runs as soon as Redis connects.
  try {
    await waitForRedisReady(redis, REDIS_STARTUP_WAIT_MS);
    await epoch.check('startup');
  } catch (error) {
    logger.warn({ err: error, instanceId }, 'Redis unavailable at startup; epoch check deferred');
  }

  let listening = false;
  // ioredis emits `ready` after every reconnect: re-check the epoch (Redis may have come
  // back empty) and re-publish the heartbeat straight away.
  redis.on('ready', () => {
    if (listening) {
      void heartbeat.tick('reconnect');
    }
  });

  // Socket.IO's adapter needs its own publisher and subscriber connections; the emitter
  // publishes on the same channels through the publisher.
  const pubClient = createRedisConnection(config, logger, 'pubsub');
  const subClient = createRedisConnection(config, logger, 'pubsub');
  const socketEmitter = createSocketEmitter(pubClient, config);

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
    disconnectSession: (sid) => {
      socketEmitter.in(sessionRoom(sid)).disconnectSockets(true);
    },
  };

  const app = createApp({ config, logger, pool, redis, authDeps });
  const server = createServer(app);
  const onSocketConnect: ((socket: AppSocket) => void)[] = [];
  const io = createSocketServer({
    httpServer: server,
    config,
    logger,
    authDeps,
    pubClient,
    subClient,
    onConnect: onSocketConnect,
  });

  // Socket.IO first: its upgraded connections would otherwise hold the HTTP server open.
  const beforeServerClose: ShutdownStep[] = [
    { name: 'socket.io', run: () => closeSocketServer(io) },
  ];
  const shutdownSteps: ShutdownStep[] = [
    { name: 'instance heartbeat', run: heartbeat.stop },
    { name: 'redis pub/sub', run: () => closeConnections(pubClient, subClient) },
  ];

  const listen = async (port: number, host: string): Promise<number> => {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    listening = true;
    await heartbeat.start();
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected the HTTP server to listen on a TCP port');
    }
    return address.port;
  };

  const stop = createShutdown({
    server,
    pool,
    redis,
    logger,
    timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
    beforeServerClose,
    steps: shutdownSteps,
    exit: () => undefined,
  });

  return {
    config,
    logger,
    instanceId,
    pool,
    redis,
    db,
    authDeps,
    epoch,
    heartbeat,
    server,
    io,
    socketEmitter,
    onSocketConnect,
    listen,
    beforeServerClose,
    shutdownSteps,
    stop: () => stop('stop', 0),
  };
};
