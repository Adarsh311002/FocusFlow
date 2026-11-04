import { roomIdSchema, userIdSchema } from '@focus-flow/contracts';
import type { Logger } from 'pino';

import type { SocketEmitter } from '../../platform/socket.js';
import { roomRoom, userRoom } from '../realtime/types.js';
import type { RoomLive } from '../rooms/ports.js';
import type { KnockStore } from './knocks.js';
import type { RoomPresence } from './room-presence.js';

export type RoomLiveDeps = {
  readonly presence: RoomPresence;
  readonly knocks: KnockStore;
  readonly emitter: SocketEmitter;
  readonly logger: Logger;
};

/**
 * The realtime side of the REST module's port (`modules/rooms/ports.ts`). The REST module
 * persists first and calls these after the PostgreSQL commit, so the `announce…` methods
 * log a failure instead of throwing: the committed change must not be
 * reported as failed. The readers (`presentCounts`, `isKnockPending`) reject when Redis
 * is unreachable and the caller decides what that means.
 */
export const createRoomLive = ({ presence, knocks, emitter, logger }: RoomLiveDeps): RoomLive => {
  const safely = async (what: string, context: object, work: () => Promise<void> | void) => {
    try {
      await work();
    } catch (error) {
      logger.warn({ err: error, ...context }, `Could not ${what}`);
    }
  };

  return {
    presentCounts: async (roomIds) => {
      const present = await presence.present(roomIds);
      return new Map(roomIds.map((roomId) => [roomId, present.get(roomId)?.length ?? 0]));
    },

    isKnockPending: (roomId, userId) => knocks.isPending(roomId, userId),

    resolveKnock: async (roomId, hostId, userId, outcome) => {
      // The removal is the gate between a racing approve and reject: only the caller that
      // removed the knock gets `true`. A failing removal rejects (the caller answers 503);
      // a failing emit after it is logged and the removal still counts.
      if (!(await knocks.remove(roomId, userId))) {
        return false;
      }
      await safely('announce a resolved knock', { roomId, userId, outcome }, () => {
        const room = roomIdSchema.parse(roomId);
        emitter.to(userRoom(userId)).emit('room:knock:resolved', { roomId: room, outcome });
        emitter.to(userRoom(hostId)).emit('room:knock:removed', {
          roomId: room,
          userId: userIdSchema.parse(userId),
          reason: outcome,
        });
      });
      return true;
    },

    announceMemberJoined: (roomId, member) =>
      safely('announce a new member', { roomId, userId: member.userId }, () => {
        emitter
          .to(roomRoom(roomId))
          .emit('room:member:joined', { roomId: roomIdSchema.parse(roomId), member });
      }),

    announceMemberRemoved: (roomId, userId, reason) =>
      safely('announce a removed member', { roomId, userId, reason }, async () => {
        // Sockets leave the Socket.IO room first (through the emitter, so on every
        // instance), then the user's presence goes; a sync that still sees a socket in
        // the room in between re-adds it and the next one removes it again.
        emitter.in(userRoom(userId)).socketsLeave(roomRoom(roomId));
        try {
          await presence.evict(roomId, userId);
        } finally {
          // Sent even when Redis presence failed: the user must hear about it. One emit to
          // both rooms delivers once to a socket that is in both.
          emitter
            .to(roomRoom(roomId))
            .to(userRoom(userId))
            .emit('room:member:removed', {
              roomId: roomIdSchema.parse(roomId),
              userId: userIdSchema.parse(userId),
              reason,
            });
        }
      }),

    announceSettingsUpdated: (roomId, timerSettings) =>
      safely('announce new timer settings', { roomId }, () => {
        emitter.to(roomRoom(roomId)).emit('room:settings:updated', {
          roomId: roomIdSchema.parse(roomId),
          timerSettings,
          effectiveFrom: 'next_phase',
        });
      }),
  };
};
