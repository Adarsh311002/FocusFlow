import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import type { ReconcileJob } from '@focus-flow/contracts';
import type { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { Logger } from 'pino';

import { createDb, type Db } from '../db/client.js';
import type { AuthDeps } from '../modules/auth/service.js';
import { createPresence, localSocketRefs, type Presence } from '../modules/presence/presence.js';
import { createPresenceStore } from '../modules/presence/store.js';
import { type AppServer, type AppSocket, sessionRoom } from '../modules/realtime/types.js';
import { createReconciler, type Reconciler } from '../modules/reconciler/reconciler.js';
import type { AppConfig } from './config.js';
import { createPool } from './db.js';
import { createEpochMonitor, type EpochMonitor } from './epoch.js';
import { createApp } from './http/app.js';
import { createInstanceHeartbeat, type InstanceHeartbeat } from './instance.js';
import { createLogger } from './logger.js';
import {
  createMaintenanceQueue,
  createMaintenanceWorker,
  enqueueReconcile,
  type MaintenanceQueue,
  upsertReconcileSchedule,
} from './queues.js';
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
  /** Per-user presence: which users have a live socket on a live instance. */
  readonly presence: Presence;
  /** The `maintenance` queue (every role can enqueue; only workers process). */
  readonly maintenanceQueue: MaintenanceQueue;
  /** Present when the role runs workers. */
  readonly maintenanceWorker: Worker<ReconcileJob> | undefined;
  readonly reconciler: Reconciler;
  /**
   * Starts the process according to its ROLE: listens on `listenOn` when the role serves
   * the API (resolving with the bound port), then publishes the heartbeat, ensures the
   * reconcile schedule and, when the role runs workers, starts them and queues a startup
   * reconcile. A worker-only process has no HTTP listener (approved Phase 3 decision 7).
   */
  readonly start: (listenOn?: { port: number; host: string }) => Promise<number | undefined>;
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
  const servesApi = config.ROLE !== 'worker';
  const runsWorkers = config.ROLE !== 'api';
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

  // BullMQ gets connections of its own (no keyPrefix; I7). The queue exists before the
  // epoch check so global recovery can queue a reconcile run.
  const queueConnection = createRedisConnection(config, logger, 'bullmq');
  const workerConnection = runsWorkers
    ? createRedisConnection(config, logger, 'bullmq')
    : undefined;
  const maintenanceQueue = createMaintenanceQueue(queueConnection, config);
  const ensureSchedule = async (): Promise<void> => {
    try {
      await upsertReconcileSchedule(maintenanceQueue, config);
    } catch (error) {
      logger.warn({ err: error, instanceId }, 'Could not register the reconcile schedule');
    }
  };
  // The SET NX winner queues one recovery run per epoch; every instance that sees the
  // epoch change re-registers the schedule, which was lost with Redis's data.
  epoch.onGlobalRecovery(() =>
    enqueueReconcile(maintenanceQueue, 'recovery', epoch.known() ?? instanceId),
  );
  epoch.onLocalRecovery(ensureSchedule);

  // The epoch is established before anything is served. If Redis is unreachable the API
  // still starts (readiness reports it) and the check runs as soon as Redis connects.
  try {
    await waitForRedisReady(redis, REDIS_STARTUP_WAIT_MS);
    await epoch.check('startup');
  } catch (error) {
    logger.warn({ err: error, instanceId }, 'Redis unavailable at startup; epoch check deferred');
  }

  let started = false;

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

  // Built for every role so the process is wired the same way; a worker-only process
  // simply never listens, so it serves no HTTP and accepts no sockets.
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

  const presence = createPresence({
    store: createPresenceStore({ redis, instanceId, instanceTtlMs: config.INSTANCE_TTL_MS }),
    listLocalSockets: () => localSocketRefs(io),
    logger,
  });
  onSocketConnect.push(presence.track);
  // Presence is synchronised with the live sockets on every heartbeat, so any missed
  // write is repaired within one interval; data loss and a rejoin sync at once.
  heartbeat.onTick(() => presence.syncLocal());
  epoch.onLocalRecovery(async () => {
    await presence.syncLocal();
  });
  heartbeat.onRejoined(() => presence.syncLocal());

  const reconciler = createReconciler({
    redis,
    presence,
    instanceTtlMs: config.INSTANCE_TTL_MS,
    logger,
  });
  const maintenanceWorker =
    workerConnection === undefined
      ? undefined
      : createMaintenanceWorker({
          connection: workerConnection,
          config,
          logger,
          reconcile: reconciler.run,
        });

  // ioredis emits `ready` after every reconnect: re-check the epoch (Redis may have come
  // back empty), re-publish the heartbeat, and sync this instance's sockets (presence
  // writes made while Redis was unreachable failed). The tick never rejects.
  redis.on('ready', () => {
    if (started) {
      void heartbeat.tick('reconnect');
    }
  });

  // Socket.IO first: its upgraded connections would otherwise hold the HTTP server open.
  const beforeServerClose: ShutdownStep[] = [
    { name: 'socket.io', run: () => closeSocketServer(io) },
  ];
  const shutdownSteps: ShutdownStep[] = [
    { name: 'instance heartbeat', run: heartbeat.stop },
    // A clean shutdown removes this instance's presence at once instead of leaving it
    // for the reconciler to find after the heartbeat TTL.
    { name: 'presence', run: () => presence.removeInstance(instanceId, 'disconnect') },
    ...(maintenanceWorker === undefined
      ? []
      : [
          {
            name: 'maintenance worker',
            // Graceful when Redis is reachable (the running job finishes); forced when it is
            // not, so BullMQ drops its blocking connection instead of waiting on QUIT.
            run: () => maintenanceWorker.close(workerConnection?.status !== 'ready'),
          },
        ]),
    { name: 'maintenance queue', run: () => maintenanceQueue.close() },
    {
      name: 'redis connections',
      run: () =>
        closeConnections(
          pubClient,
          subClient,
          queueConnection,
          ...(workerConnection === undefined ? [] : [workerConnection]),
        ),
    },
  ];

  const listen = async (port: number, host: string): Promise<number> => {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected the HTTP server to listen on a TCP port');
    }
    return address.port;
  };

  const start = async (listenOn?: { port: number; host: string }): Promise<number | undefined> => {
    const port =
      servesApi && listenOn !== undefined ? await listen(listenOn.port, listenOn.host) : undefined;
    started = true;
    await heartbeat.start();
    await ensureSchedule();
    if (maintenanceWorker !== undefined) {
      maintenanceWorker.run().catch((error: unknown) => {
        logger.error({ err: error, instanceId }, 'The maintenance worker stopped unexpectedly');
      });
      try {
        await enqueueReconcile(maintenanceQueue, 'startup', instanceId);
      } catch (error) {
        logger.warn({ err: error, instanceId }, 'Could not queue the startup reconcile');
      }
    }
    return port;
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
    presence,
    maintenanceQueue,
    maintenanceWorker,
    reconciler,
    start,
    beforeServerClose,
    shutdownSteps,
    stop: () => stop('stop', 0),
  };
};
