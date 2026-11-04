import { z } from 'zod';

import { roomMemberViewSchema, roomTimerSettingsSchema, roomViewSchema } from '../http/rooms';
import { roomIdSchema, userIdSchema } from '../ids';

// Room events (Phase 6; docs/api/socket-events.md). Identity never travels in a payload:
// the server knows who is asking from the handshake, and every `userId` below names
// someone else (a member, a requester) in a server → client event.

/** Matches the documented 1–1000 character chat body. */
export const CHAT_BODY_MAX_LENGTH = 1_000;

export const roomJoinRequestSchema = z.strictObject({ roomId: roomIdSchema });
export type RoomJoinRequest = z.infer<typeof roomJoinRequestSchema>;

/** `room:leave`, `room:knock` and `room:knock:cancel` all name just a room. */
export const roomRequestSchema = z.strictObject({ roomId: roomIdSchema });
export type RoomRequest = z.infer<typeof roomRequestSchema>;

export const roomChatSendRequestSchema = z.strictObject({
  roomId: roomIdSchema,
  /** Chosen by the sender; a retry with the same id is answered, not delivered twice (M8). */
  clientMessageId: z.uuid(),
  /** Trimmed; a message of only whitespace is refused. */
  body: z.string().trim().min(1).max(CHAT_BODY_MAX_LENGTH),
});
export type RoomChatSendRequest = z.infer<typeof roomChatSendRequestSchema>;

export const presenceUserSchema = z.object({
  userId: userIdSchema,
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
});
export type PresenceUser = z.infer<typeof presenceUserSchema>;

/** A pending knock. Expiry is not announced: both sides know `expiresAtMs`. */
export const knockViewSchema = z.object({
  userId: userIdSchema,
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  expiresAtMs: z.number().int().nonnegative(),
});
export type KnockView = z.infer<typeof knockViewSchema>;

/**
 * The authoritative picture of a room at the moment of joining (M6). Phase 7 adds the
 * timer and Phase 8 the focus participants; they are additive.
 */
export const roomSnapshotSchema = z.object({
  room: roomViewSchema,
  presence: z.array(presenceUserSchema),
  /** Host only: knocks waiting for an answer. */
  pendingKnocks: z.array(knockViewSchema).optional(),
  serverNowMs: z.number().int().nonnegative(),
});
export type RoomSnapshot = z.infer<typeof roomSnapshotSchema>;

// ---- Acknowledgement results ----------------------------------------------------------

export const roomJoinResultSchema = z.object({ snapshot: roomSnapshotSchema });
export type RoomJoinResult = z.infer<typeof roomJoinResultSchema>;

export const roomKnockResultSchema = z.object({ expiresAtMs: z.number().int().nonnegative() });
export type RoomKnockResult = z.infer<typeof roomKnockResultSchema>;

export const roomChatSendResultSchema = z.object({
  messageId: z.uuid(),
  sentAtMs: z.number().int().nonnegative(),
});
export type RoomChatSendResult = z.infer<typeof roomChatSendResultSchema>;

// ---- Server → client payloads ---------------------------------------------------------

export const roomPresenceJoinedEventSchema = z.object({
  roomId: roomIdSchema,
  user: presenceUserSchema,
});
export type RoomPresenceJoinedEvent = z.infer<typeof roomPresenceJoinedEventSchema>;

export const roomPresenceLeftEventSchema = z.object({
  roomId: roomIdSchema,
  userId: userIdSchema,
});
export type RoomPresenceLeftEvent = z.infer<typeof roomPresenceLeftEventSchema>;

/** A person became a member (joined a public room or was let in). A hint to show them. */
export const roomMemberJoinedEventSchema = z.object({
  roomId: roomIdSchema,
  member: roomMemberViewSchema,
});
export type RoomMemberJoinedEvent = z.infer<typeof roomMemberJoinedEventSchema>;

/**
 * Sent to the room and to `user:{userId}`; the server also takes that user's sockets out of
 * the room. `reason` tells the person why: removed by the host, or left on purpose.
 */
export const roomMemberRemovedEventSchema = z.object({
  roomId: roomIdSchema,
  userId: userIdSchema,
  reason: z.enum(['removed', 'left']),
});
export type RoomMemberRemovedEvent = z.infer<typeof roomMemberRemovedEventSchema>;

export const roomSettingsUpdatedEventSchema = z.object({
  roomId: roomIdSchema,
  timerSettings: roomTimerSettingsSchema,
  effectiveFrom: z.literal('next_phase'),
});
export type RoomSettingsUpdatedEvent = z.infer<typeof roomSettingsUpdatedEventSchema>;

export const roomKnockReceivedEventSchema = z.object({
  roomId: roomIdSchema,
  requester: presenceUserSchema,
  expiresAtMs: z.number().int().nonnegative(),
});
export type RoomKnockReceivedEvent = z.infer<typeof roomKnockReceivedEventSchema>;

export const roomKnockRemovedEventSchema = z.object({
  roomId: roomIdSchema,
  userId: userIdSchema,
  reason: z.enum(['approved', 'rejected', 'cancelled']),
});
export type RoomKnockRemovedEvent = z.infer<typeof roomKnockRemovedEventSchema>;

/** To the requester only (`user:{requesterId}`). */
export const roomKnockResolvedEventSchema = z.object({
  roomId: roomIdSchema,
  outcome: z.enum(['approved', 'rejected']),
});
export type RoomKnockResolvedEvent = z.infer<typeof roomKnockResolvedEventSchema>;

export const roomChatMessageEventSchema = z.object({
  roomId: roomIdSchema,
  messageId: z.uuid(),
  clientMessageId: z.uuid(),
  sender: z.object({ userId: userIdSchema, displayName: z.string() }),
  body: z.string(),
  sentAtMs: z.number().int().nonnegative(),
});
export type RoomChatMessageEvent = z.infer<typeof roomChatMessageEventSchema>;

/** The room's live state may have been lost; clients answer with `room:join`. */
export const roomResyncEventSchema = z.object({ roomId: roomIdSchema });
export type RoomResyncEvent = z.infer<typeof roomResyncEventSchema>;
