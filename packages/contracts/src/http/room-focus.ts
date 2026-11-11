import { z } from 'zod';

import { roomIdSchema, taskIdSchema } from '../ids';
import { roomFocusSnapshotSchema } from '../socket/room-focus';
import { focusSessionViewSchema } from './focus-sessions';

// Room focus participation (Phase 8; docs/api/rest.md "Rooms"). Identity always comes from
// the token, never from the body (contracts rule 7).

export const roomFocusParamsSchema = z.strictObject({ roomId: roomIdSchema });
export type RoomFocusParams = z.infer<typeof roomFocusParamsSchema>;

/** `POST /rooms/:roomId/focus-participation`: opt into the room's current focus run. */
export const optInRoomFocusRequestSchema = z.strictObject({ taskId: taskIdSchema.optional() });
export type OptInRoomFocusRequest = z.infer<typeof optInRoomFocusRequestSchema>;

/** `201` from opt-in; `200` from opt-out (repeats included). */
export const roomFocusSessionResponseSchema = z.object({ session: focusSessionViewSchema });
export type RoomFocusSessionResponse = z.infer<typeof roomFocusSessionResponseSchema>;

/** `GET /rooms/:roomId/focus-participation`: the current run, for restoring a page. */
export const roomFocusStateResponseSchema = roomFocusSnapshotSchema.extend({
  /** The caller's in-progress session in this room, if they are a participant. */
  session: focusSessionViewSchema.nullable(),
});
export type RoomFocusStateResponse = z.infer<typeof roomFocusStateResponseSchema>;
