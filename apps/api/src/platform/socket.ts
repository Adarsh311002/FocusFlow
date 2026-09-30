import type { Server as HttpServer } from 'node:http';

import { type ServerToClientEvents, SOCKET_IO_PATH } from '@focus-flow/contracts';
import { createAdapter } from '@socket.io/redis-adapter';
import { Emitter } from '@socket.io/redis-emitter';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { Server } from 'socket.io';

import type { AuthDeps } from '../modules/auth/service.js';
import { handleConnection } from '../modules/realtime/connection.js';
import { createHandshakeMiddleware } from '../modules/realtime/handshake.js';
import type { AppServer, AppSocket } from '../modules/realtime/types.js';
import type { AppConfig } from './config.js';

/** Same limit as the REST JSON body: socket payloads in this app are small. */
const MAX_SOCKET_MESSAGE_BYTES = 16 * 1024;

/**
 * The adapter's and emitter's pub/sub channel prefix, derived from `REDIS_KEY_PREFIX` so a
 * deployment (or a test file) only ever hears its own broadcasts (P3).
 */
export const socketIoChannelKey = (config: AppConfig): string =>
  `${config.REDIS_KEY_PREFIX}socket.io`;

type SocketServerDeps = {
  readonly httpServer: HttpServer;
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly authDeps: AuthDeps;
  readonly pubClient: Redis;
  readonly subClient: Redis;
  readonly onConnect: readonly ((socket: AppSocket) => void)[];
};

/**
 * The Socket.IO server (I5), attached to the API's own HTTP server on the same origin.
 * Default transports (polling, upgraded to WebSocket: approved); the Redis adapter fans
 * broadcasts out to every API instance.
 */
export const createSocketServer = ({
  httpServer,
  config,
  logger,
  authDeps,
  pubClient,
  subClient,
  onConnect,
}: SocketServerDeps): AppServer => {
  const io: AppServer = new Server(httpServer, {
    path: SOCKET_IO_PATH,
    serveClient: false,
    pingInterval: config.SOCKET_PING_INTERVAL_MS,
    pingTimeout: config.SOCKET_PING_TIMEOUT_MS,
    maxHttpBufferSize: MAX_SOCKET_MESSAGE_BYTES,
    adapter: createAdapter(pubClient, subClient, { key: socketIoChannelKey(config) }),
  });

  io.use(createHandshakeMiddleware(authDeps));
  io.on('connection', (socket) => {
    handleConnection(socket, { redis: authDeps.redis, logger, onConnect });
  });

  return io;
};

export type SocketEmitter = Emitter<ServerToClientEvents>;

/**
 * Sends to sockets on every instance through Redis, without a Socket.IO server. REST
 * services and (later) workers use it, so moving workers to their own process needs no
 * code change (I7).
 */
export const createSocketEmitter = (pubClient: Redis, config: AppConfig): SocketEmitter =>
  new Emitter(pubClient, { key: socketIoChannelKey(config) });
