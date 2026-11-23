import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import type { RoomFocusService, RoomPresenceCheck } from '../room-focus/types.js';
import type { PresenceHooks } from './room-presence.js';
import { createRoomPresenceStore } from './store.js';

// The seam between room presence and room focus runs (Phase 8, RF7/RF8). Presence only
// reports facts ("the user's last socket in the room is gone", "the user became present");
// the focus service decides what they mean and re-checks presence itself, because every one
// of these is a hint that may be late, repeated or stale (H2).

/** What the socket layer needs from the focus service. */
export type RoomFocusPort = Pick<
  RoomFocusService,
  'snapshot' | 'depart' | 'userLeftRoom' | 'userJoinedRoom'
>;

/**
 * The presence hooks: a failure is logged and nothing else. A missed "left" is repaired by the
 * reconciler's late grace (RF9); a missed "joined" by the next `room:join` or the grace job's
 * own presence re-check.
 */
export const createPresenceHooks = (focus: RoomFocusPort, logger: Logger): PresenceHooks => ({
  userLeft: (users) => {
    for (const { roomId, userId } of users) {
      focus.userLeftRoom(userId, roomId).catch((error: unknown) => {
        logger.warn({ err: error, roomId, userId }, 'Could not record a room focus disconnect');
      });
    }
  },
  userJoined: ({ roomId, userId }) => {
    focus.userJoinedRoom(userId, roomId).catch((error: unknown) => {
      logger.warn({ err: error, roomId, userId }, 'Could not record a room focus reconnect');
    });
  },
});

/**
 * "Does the person have a live socket in the room right now?" for the focus service. Built on
 * its own store over the same Redis keys, so the service can be created before the realtime
 * module (which needs the service).
 */
export const createRoomPresenceCheck = (deps: {
  readonly redis: Redis;
  readonly instanceId: string;
  readonly instanceTtlMs: number;
}): RoomPresenceCheck => {
  const store = createRoomPresenceStore(deps);
  return async (roomId, userId) =>
    (await store.readPresent([roomId])).get(roomId)?.some((user) => user.userId === userId) ??
    false;
};
