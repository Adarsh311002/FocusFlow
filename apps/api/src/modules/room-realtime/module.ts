import { roomIdSchema } from '@focus-flow/contracts';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import type { Db } from '../../db/client.js';
import type { SocketEmitter } from '../../platform/socket.js';
import type { PresenceCheck } from '../presence/store.js';
import { type AppServer, type AppSocket, roomRoom } from '../realtime/types.js';
import type { RoomTimerService } from '../room-timer/types.js';
import type { RoomLive } from '../rooms/ports.js';
import { createChatDedupe } from './chat.js';
import { dropNonMemberSockets } from './guard.js';
import { registerRoomHandlers } from './handlers.js';
import { createKnockStore } from './knocks.js';
import { createRateLimiter } from './limiter.js';
import { createRoomLive } from './live.js';
import { createRoomPresence, localRoomSockets, type RoomPresence } from './room-presence.js';
import { createRoomPresenceStore } from './store.js';

export type RoomRealtimeDeps = {
  readonly redis: Redis;
  readonly db: Db;
  readonly emitter: SocketEmitter;
  readonly logger: Logger;
  readonly instanceId: string;
  readonly instanceTtlMs: number;
  readonly knockTtlMs: number;
  readonly maxPresent: number;
  /** The shared room timer (Phase 7). */
  readonly timer: RoomTimerService;
  /** User-level presence, for "the host is online" (D20). */
  readonly checkUser: (userId: string) => Promise<PresenceCheck>;
};

export type RoomRealtime = {
  /** What the REST module calls (`modules/rooms/ports.ts`). */
  readonly live: RoomLive;
  readonly presence: RoomPresence;
  /** Registers the room events on an authenticated socket (an `onSocketConnect` hook). */
  readonly attachSocket: (socket: AppSocket) => void;
  /** Makes this instance's room entries match its sockets' rooms (H1 for rooms). */
  readonly syncLocal: (io: AppServer) => Promise<void>;
  /**
   * After Redis lost its data: rebuilds this instance's room entries from its sockets
   * without announcing, then asks the clients of every local room to join again.
   */
  readonly recover: (io: AppServer) => Promise<void>;
  /** Removes an instance's room entries and announces who left (dead, or clean shutdown). */
  readonly removeInstance: (instanceId: string) => Promise<void>;
};

/** The realtime side of rooms (Phase 6): room presence, knocks, chat and their wiring. */
export const createRoomRealtime = (deps: RoomRealtimeDeps): RoomRealtime => {
  const { redis, db, emitter, logger } = deps;
  const store = createRoomPresenceStore({
    redis,
    instanceId: deps.instanceId,
    instanceTtlMs: deps.instanceTtlMs,
  });
  const presence = createRoomPresence({ store, emitter, logger });
  const knocks = createKnockStore(redis, deps.knockTtlMs);
  const limiter = createRateLimiter(redis);
  const chat = createChatDedupe(redis);

  // Single-flight, like the user-level sync: a request during a running sync is served by
  // one more sync after it, since the running one may have read the sockets too early.
  let syncing: Promise<void> | undefined;
  let queued: Promise<void> | undefined;
  const syncLocal = (io: AppServer, announce: boolean): Promise<void> => {
    if (syncing === undefined) {
      syncing = dropNonMemberSockets({ io, db, logger })
        .then(() => presence.syncLocal(() => localRoomSockets(io), { announce }))
        .then(() => undefined)
        .finally(() => {
          syncing = undefined;
        });
      return syncing;
    }
    queued ??= syncing
      .catch(() => undefined)
      .then(() => {
        queued = undefined;
        return syncLocal(io, announce);
      });
    return queued;
  };

  return {
    live: createRoomLive({ presence, knocks, emitter, logger }),
    presence,
    attachSocket: (socket) => {
      registerRoomHandlers(socket, {
        db,
        redis,
        emitter,
        logger,
        presence,
        knocks,
        limiter,
        chat,
        timer: deps.timer,
        checkUser: deps.checkUser,
        maxPresent: deps.maxPresent,
      });
    },
    syncLocal: (io) => syncLocal(io, true),
    recover: async (io) => {
      await syncLocal(io, false);
      const roomIds = new Set(localRoomSockets(io).map(({ roomId }) => roomId));
      for (const roomId of roomIds) {
        io.local.to(roomRoom(roomId)).emit('room:resync', { roomId: roomIdSchema.parse(roomId) });
      }
    },
    removeInstance: (instanceId) => presence.removeInstance(instanceId),
  };
};
