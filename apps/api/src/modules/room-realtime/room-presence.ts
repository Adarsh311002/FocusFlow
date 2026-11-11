import { presenceUserSchema, roomIdSchema, userIdSchema } from '@focus-flow/contracts';
import type { Logger } from 'pino';

import type { SocketEmitter } from '../../platform/socket.js';
import { type AppServer, roomRoom } from '../realtime/types.js';
import type { LocalRoomSocket, RoomSocketRef } from './entries.js';
import type {
  JoinResult,
  LeaveResult,
  PresentUser,
  RoomPresenceStore,
  UserInRoom,
} from './store.js';

// Room presence with its announcements (M5): `room:presence:joined` when a user's first
// live socket joins a room, `room:presence:left` when their last one goes (explicit leave,
// disconnect, eviction, sync or a dead instance). The store decides first/last atomically;
// this layer only sends. Events go through the Socket.IO Redis emitter, so they reach
// sockets on every instance and the same code serves a worker-only process.

export type RoomPresence = {
  /**
   * Records the socket and announces the user when this is their first live socket. With
   * `maxPresent` the cap is checked atomically (F5); a `full` result wrote nothing.
   */
  readonly join: (socket: LocalRoomSocket, maxPresent?: number) => Promise<JoinResult>;
  /** Removes the socket and announces the user when this was their last live socket. */
  readonly leave: (ref: RoomSocketRef) => Promise<LeaveResult>;
  /** Removes the user from the room everywhere; whether they were present (announced). */
  readonly evict: (roomId: string, userId: string) => Promise<boolean>;
  readonly present: (roomIds: readonly string[]) => Promise<Map<string, PresentUser[]>>;
  /**
   * Two-way synchronisation of this instance's room entries (H1 for rooms). With
   * `announce: false` (after Redis lost its data) nothing is announced: clients are told
   * to rejoin instead.
   */
  readonly syncLocal: (
    readLocal: () => readonly LocalRoomSocket[],
    options?: { readonly announce?: boolean },
  ) => Promise<{ readonly added: number; readonly removed: number }>;
  /** Removes an instance's room entries (dead, or a clean shutdown) and announces who left. */
  readonly removeInstance: (instanceId: string) => Promise<void>;
  /** Whether the user has another live socket in the room than the given socket. */
  readonly hasOtherSocket: (ref: RoomSocketRef) => Promise<boolean>;
};

/**
 * Called after the presence change itself, for the focus-run integration (Phase 8). Both are
 * hints that may fail or repeat: the implementation logs and never throws.
 */
export type PresenceHooks = {
  /** The user's last live socket in the room is gone (disconnect, sync, dead instance, eviction). */
  readonly userLeft: (users: readonly UserInRoom[]) => void;
  /** A sync found a socket in a room whose user was not present (the user became present). */
  readonly userJoined: (socket: LocalRoomSocket) => void;
};

type Deps = {
  readonly store: RoomPresenceStore;
  readonly emitter: SocketEmitter;
  readonly logger: Logger;
  readonly hooks?: PresenceHooks;
};

export const createRoomPresence = ({ store, emitter, logger, hooks }: Deps): RoomPresence => {
  const announceJoined = (socket: LocalRoomSocket): void => {
    try {
      emitter
        .to(roomRoom(socket.roomId))
        .except(socket.socketId)
        .emit('room:presence:joined', {
          roomId: roomIdSchema.parse(socket.roomId),
          user: presenceUserSchema.parse({
            userId: userIdSchema.parse(socket.userId),
            displayName: socket.displayName,
            avatarUrl: socket.avatarUrl,
          }),
        });
    } catch (error) {
      logger.warn({ err: error, roomId: socket.roomId }, 'Could not announce room arrival');
    }
  };

  const announceLeft = (users: readonly UserInRoom[]): void => {
    if (users.length > 0) {
      hooks?.userLeft(users);
    }
    for (const { roomId, userId } of users) {
      try {
        emitter.to(roomRoom(roomId)).emit('room:presence:left', {
          roomId: roomIdSchema.parse(roomId),
          userId: userIdSchema.parse(userId),
        });
      } catch (error) {
        logger.warn({ err: error, roomId, userId }, 'Could not announce room departure');
      }
    }
  };

  return {
    join: async (socket, maxPresent) => {
      const result = await store.join(socket, socket, maxPresent);
      if (result.first && !result.full) {
        announceJoined(socket);
      }
      return result;
    },

    leave: async (ref) => {
      const result = await store.leave(ref);
      if (result.last) {
        announceLeft([ref]);
      }
      return result;
    },

    evict: async (roomId, userId) => {
      const wasPresent = await store.evictUser(roomId, userId);
      if (wasPresent) {
        announceLeft([{ roomId, userId }]);
      }
      return wasPresent;
    },

    present: (roomIds) => store.readPresent(roomIds),

    syncLocal: async (readLocal, options = {}) => {
      const result = await store.sync(readLocal);
      if (options.announce !== false) {
        for (const { socket, first } of result.joined) {
          if (first) {
            announceJoined(socket);
            hooks?.userJoined(socket);
          }
        }
        announceLeft(result.left);
      }
      if (result.joined.length > 0 || result.left.length > 0) {
        logger.info(
          { added: result.joined.length, left: result.left.length },
          'Synchronised local room presence',
        );
      }
      return { added: result.joined.length, removed: result.left.length };
    },

    removeInstance: async (instanceId) => {
      announceLeft(await store.removeInstance(instanceId));
    },

    hasOtherSocket: (ref) => store.hasOtherLiveSocket(ref),
  };
};

/**
 * The sockets of this instance that are in Socket.IO rooms of the form `room:{roomId}`,
 * read synchronously (see `RoomPresenceStore.sync`). The Socket.IO room, not
 * `socket.data.joinedRooms`, is the authority (M5): REST eviction changes it without
 * touching `socket.data`.
 */
export const localRoomSockets = (io: AppServer): LocalRoomSocket[] => {
  const result: LocalRoomSocket[] = [];
  for (const socket of io.of('/').sockets.values()) {
    for (const name of socket.rooms) {
      if (name.startsWith('room:')) {
        result.push({
          roomId: name.slice('room:'.length),
          userId: socket.data.userId,
          socketId: socket.id,
          displayName: socket.data.displayName,
          avatarUrl: socket.data.avatarUrl,
        });
      }
    }
  }
  return result;
};
