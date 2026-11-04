import { z } from 'zod';

import { focusSessionViewSchema } from '../http/focus-sessions';
import type { AuthSessionId, UserId } from '../ids';
import { type Ack, type AckError, ackErrorSchema } from './ack';
import type {
  RoomChatMessageEvent,
  RoomChatSendRequest,
  RoomChatSendResult,
  RoomJoinRequest,
  RoomJoinResult,
  RoomKnockReceivedEvent,
  RoomKnockRemovedEvent,
  RoomKnockResolvedEvent,
  RoomKnockResult,
  RoomMemberJoinedEvent,
  RoomMemberRemovedEvent,
  RoomPresenceJoinedEvent,
  RoomPresenceLeftEvent,
  RoomRequest,
  RoomResyncEvent,
  RoomSettingsUpdatedEvent,
} from './rooms';

// Typed Socket.IO events (docs/architecture/contracts.md, "Typed Socket.IO"). The one
// client event is the clock sync; the one server event so far is `focus:session:updated`
// (Phase 4B). Names are `area:action`; payloads never carry identity; units are in the
// names (`…Ms`, `…AtMs`).

/** `time:sync` request: the client's send time, echoed back so it can measure the round trip. */
export const timeSyncRequestSchema = z.strictObject({
  clientSentAtMs: z.number().int().nonnegative(),
});
export type TimeSyncRequest = z.infer<typeof timeSyncRequestSchema>;

/** `time:sync` result: the server's authoritative time (Redis `TIME`), epoch milliseconds. */
export const timeSyncResultSchema = z.object({
  serverNowMs: z.number().int().nonnegative(),
});
export type TimeSyncResult = z.infer<typeof timeSyncResultSchema>;

/** The full `time:sync` acknowledgement, success or error (for client-side validation). */
export const timeSyncAckSchema = z.discriminatedUnion('ok', [
  timeSyncResultSchema.extend({ ok: z.literal(true) }),
  ackErrorSchema,
]);

/** An acknowledgement with no result beyond success. */
export type EmptyAck = { ok: true } | AckError;

/** Every client event is answered through its acknowledgement (docs/api/socket-events.md). */
export type ClientToServerEvents = {
  'time:sync': (request: TimeSyncRequest, ack: (response: Ack<TimeSyncResult>) => void) => void;
  'room:join': (request: RoomJoinRequest, ack: (response: Ack<RoomJoinResult>) => void) => void;
  'room:leave': (request: RoomRequest, ack: (response: EmptyAck) => void) => void;
  'room:knock': (request: RoomRequest, ack: (response: Ack<RoomKnockResult>) => void) => void;
  'room:knock:cancel': (request: RoomRequest, ack: (response: EmptyAck) => void) => void;
  'room:chat:send': (
    request: RoomChatSendRequest,
    ack: (response: Ack<RoomChatSendResult>) => void,
  ) => void;
};

/**
 * `focus:session:updated` (E6; docs/api/socket-events.md): the user's focus session after
 * every committed transition, sent to `user:{userId}` (every tab). The payload is a hint
 * to refetch, never proof of an outcome: clients validate it, then re-read the server.
 */
export const focusSessionUpdatedEventSchema = z.object({ session: focusSessionViewSchema });
export type FocusSessionUpdatedEvent = z.infer<typeof focusSessionUpdatedEventSchema>;

/** Names are `area:action` and payloads never carry the receiver's own identity. */
export type ServerToClientEvents = {
  'focus:session:updated': (event: FocusSessionUpdatedEvent) => void;
  'room:presence:joined': (event: RoomPresenceJoinedEvent) => void;
  'room:presence:left': (event: RoomPresenceLeftEvent) => void;
  'room:member:joined': (event: RoomMemberJoinedEvent) => void;
  'room:member:removed': (event: RoomMemberRemovedEvent) => void;
  'room:settings:updated': (event: RoomSettingsUpdatedEvent) => void;
  'room:knock:received': (event: RoomKnockReceivedEvent) => void;
  'room:knock:removed': (event: RoomKnockRemovedEvent) => void;
  'room:knock:resolved': (event: RoomKnockResolvedEvent) => void;
  'room:chat:message': (event: RoomChatMessageEvent) => void;
  'room:resync': (event: RoomResyncEvent) => void;
};

export type InterServerEvents = Record<string, never>;

/**
 * Set only by the server's handshake middleware from the verified access token (F7).
 * Handlers read identity from here, never from payloads.
 */
export type SocketData = {
  userId: UserId;
  sid: AuthSessionId;
  displayName: string;
  avatarUrl: string | null;
  /** When the access token used for this connection expires; the server disconnects then. */
  tokenExpiresAtMs: number;
  /** Rooms joined through `room:join`; the socket's Socket.IO rooms stay the authority. */
  joinedRooms: string[];
};
