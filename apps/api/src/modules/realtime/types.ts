import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from '@focus-flow/contracts';
import type { Server, Socket } from 'socket.io';

/** The typed Socket.IO server and socket (docs/architecture/contracts.md, "Typed Socket.IO"). */
export type AppServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export type AppSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

/**
 * Server-derived rooms (docs/api/socket-events.md, "Channels"). A socket is put in these
 * by the server from its verified identity; no client input ever names a room here.
 */
export const userRoom = (userId: string): string => `user:${userId}`;
export const sessionRoom = (sid: string): string => `session:${sid}`;
