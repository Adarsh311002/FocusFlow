import { z } from 'zod';

import { roomIdSchema, userIdSchema } from '../ids';

// Rooms and membership (Phase 6; docs/api/rest.md "Rooms", docs/domain/model.md,
// decisions D8, D9, D16, D20 and M1–M10). Everything the client may send is strict:
// unknown keys (for example a `hostId`) are rejected, never silently dropped.

/** Matches `ck_rooms_name`. */
export const ROOM_NAME_MAX_LENGTH = 60;

/**
 * Six characters from an alphabet without look-alikes (no I, L, O, 0, 1), uppercase (M2).
 * Matches `ck_rooms_code`.
 */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_PATTERN = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${String(ROOM_CODE_LENGTH)}}$`);

/** A room code as stored: exactly six characters of the alphabet. */
export const roomCodeSchema = z.string().regex(ROOM_CODE_PATTERN).brand<'RoomCode'>();
export type RoomCode = z.infer<typeof roomCodeSchema>;

/**
 * A room code as typed by a person: whitespace and case are forgiven, so `abc 234` finds
 * `ABC234`. Anything that is still not a code answers `400 VALIDATION_FAILED`.
 */
export const roomCodeInputSchema = z
  .string()
  .max(32)
  .transform((value) => value.replace(/\s+/gu, '').toUpperCase())
  .pipe(roomCodeSchema);

export const roomNameSchema = z.string().trim().min(1).max(ROOM_NAME_MAX_LENGTH);

/** Phase durations in whole seconds (D16, M3). They match the `ck_rooms_*_seconds` CHECKs. */
export const ROOM_FOCUS_SECONDS = { min: 60, max: 14_400, default: 1_500 } as const;
export const ROOM_SHORT_BREAK_SECONDS = { min: 60, max: 3_600, default: 300 } as const;
export const ROOM_LONG_BREAK_SECONDS = { min: 60, max: 7_200, default: 900 } as const;

const durationSchema = (bounds: { readonly min: number; readonly max: number }) =>
  z.number().int().min(bounds.min).max(bounds.max);

export const roomTimerSettingsSchema = z.object({
  focusSeconds: durationSchema(ROOM_FOCUS_SECONDS),
  shortBreakSeconds: durationSchema(ROOM_SHORT_BREAK_SECONDS),
  longBreakSeconds: durationSchema(ROOM_LONG_BREAK_SECONDS),
});
export type RoomTimerSettings = z.infer<typeof roomTimerSettingsSchema>;

export const DEFAULT_ROOM_TIMER_SETTINGS: RoomTimerSettings = {
  focusSeconds: ROOM_FOCUS_SECONDS.default,
  shortBreakSeconds: ROOM_SHORT_BREAK_SECONDS.default,
  longBreakSeconds: ROOM_LONG_BREAK_SECONDS.default,
};

/** Any subset of the three durations; omitted ones keep their default (create) or value (patch). */
export const roomTimerSettingsInputSchema = z.strictObject({
  focusSeconds: durationSchema(ROOM_FOCUS_SECONDS).optional(),
  shortBreakSeconds: durationSchema(ROOM_SHORT_BREAK_SECONDS).optional(),
  longBreakSeconds: durationSchema(ROOM_LONG_BREAK_SECONDS).optional(),
});
export type RoomTimerSettingsInput = z.infer<typeof roomTimerSettingsInputSchema>;

/** What anyone with a room code may see, including non-members of a private room. */
export const roomPreviewSchema = z.object({
  id: roomIdSchema,
  code: roomCodeSchema,
  name: z.string().min(1).max(ROOM_NAME_MAX_LENGTH),
  isPrivate: z.boolean(),
});
export type RoomPreview = z.infer<typeof roomPreviewSchema>;

/** A room as its members see it. `hostId` lets the client tell whether the viewer is the host. */
export const roomViewSchema = roomPreviewSchema.extend({
  hostId: userIdSchema,
  timerSettings: roomTimerSettingsSchema,
  createdAt: z.iso.datetime(),
});
export type RoomView = z.infer<typeof roomViewSchema>;

export const roomMemberViewSchema = z.object({
  userId: userIdSchema,
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  joinedAt: z.iso.datetime(),
  isHost: z.boolean(),
});
export type RoomMemberView = z.infer<typeof roomMemberViewSchema>;

export const roomMembershipViewSchema = z.object({
  roomId: roomIdSchema,
  userId: userIdSchema,
  joinedAt: z.iso.datetime(),
});
export type RoomMembershipView = z.infer<typeof roomMembershipViewSchema>;

// ---- Requests -------------------------------------------------------------------------

export const createRoomRequestSchema = z.strictObject({
  name: roomNameSchema,
  isPrivate: z.boolean(),
  timerSettings: roomTimerSettingsInputSchema.optional(),
});
export type CreateRoomRequest = z.infer<typeof createRoomRequestSchema>;

/** `PATCH /rooms/:roomId/timer-settings`: at least one duration. */
export const updateRoomTimerSettingsRequestSchema = roomTimerSettingsInputSchema.refine(
  (value) => Object.values(value).some((entry) => entry !== undefined),
  { message: 'Give at least one duration.' },
);
export type UpdateRoomTimerSettingsRequest = z.infer<typeof updateRoomTimerSettingsRequestSchema>;

export const listRoomsQuerySchema = z.strictObject({ scope: z.literal('mine').default('mine') });
export type ListRoomsQuery = z.infer<typeof listRoomsQuerySchema>;

export const roomParamsSchema = z.strictObject({ roomId: roomIdSchema });
export type RoomParams = z.infer<typeof roomParamsSchema>;

export const roomCodeParamsSchema = z.strictObject({ code: roomCodeInputSchema });
export type RoomCodeParams = z.infer<typeof roomCodeParamsSchema>;

export const roomMemberParamsSchema = z.strictObject({
  roomId: roomIdSchema,
  userId: userIdSchema,
});
export type RoomMemberParams = z.infer<typeof roomMemberParamsSchema>;

// ---- Responses ------------------------------------------------------------------------

export const roomResponseSchema = z.object({ room: roomViewSchema });
export type RoomResponse = z.infer<typeof roomResponseSchema>;

/** People with at least one socket joined to the room right now (Redis presence). */
export const roomListItemSchema = roomViewSchema.extend({ presentCount: z.number().int().min(0) });
export type RoomListItem = z.infer<typeof roomListItemSchema>;

export const roomListResponseSchema = z.object({ rooms: z.array(roomListItemSchema) });
export type RoomListResponse = z.infer<typeof roomListResponseSchema>;

/**
 * How the viewer relates to a room found by its code: `host` and `member` see the full
 * room; `can_join` (public) and `must_knock` (private) see only the preview. `presentCount`
 * is `null` for a non-member of a private room (nothing about it is revealed).
 */
export const roomLookupResponseSchema = z.discriminatedUnion('access', [
  z.object({
    access: z.enum(['host', 'member']),
    room: roomViewSchema,
    presentCount: z.number().int().min(0),
  }),
  z.object({
    access: z.enum(['can_join', 'must_knock']),
    room: roomPreviewSchema,
    presentCount: z.number().int().min(0).nullable(),
  }),
]);
export type RoomLookupResponse = z.infer<typeof roomLookupResponseSchema>;
export type RoomAccess = RoomLookupResponse['access'];

export const roomMembersResponseSchema = z.object({ members: z.array(roomMemberViewSchema) });
export type RoomMembersResponse = z.infer<typeof roomMembersResponseSchema>;

export const roomMembershipResponseSchema = z.object({ membership: roomMembershipViewSchema });
export type RoomMembershipResponse = z.infer<typeof roomMembershipResponseSchema>;
