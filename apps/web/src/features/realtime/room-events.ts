import {
  type ErrorCode,
  errorCodeSchema,
  roomChatMessageEventSchema,
  roomChatSendResultSchema,
  roomJoinResultSchema,
  roomKnockReceivedEventSchema,
  roomKnockRemovedEventSchema,
  roomKnockResolvedEventSchema,
  roomKnockResultSchema,
  roomMemberJoinedEventSchema,
  roomMemberRemovedEventSchema,
  roomPresenceJoinedEventSchema,
  roomPresenceLeftEventSchema,
  roomResyncEventSchema,
  roomSettingsUpdatedEventSchema,
} from '@focus-flow/contracts';
import { z } from 'zod';

// The room half of the socket protocol (docs/api/socket-events.md): the events the server
// sends, each validated before anyone sees it, and the acknowledgements of the events the
// client sends. Identity never travels in a payload; the server knows who is asking.

const serverEventSchemas = {
  'room:presence:joined': roomPresenceJoinedEventSchema,
  'room:presence:left': roomPresenceLeftEventSchema,
  'room:member:joined': roomMemberJoinedEventSchema,
  'room:member:removed': roomMemberRemovedEventSchema,
  'room:settings:updated': roomSettingsUpdatedEventSchema,
  'room:knock:received': roomKnockReceivedEventSchema,
  'room:knock:removed': roomKnockRemovedEventSchema,
  'room:knock:resolved': roomKnockResolvedEventSchema,
  'room:chat:message': roomChatMessageEventSchema,
  'room:resync': roomResyncEventSchema,
} as const;

type ServerEventSchemas = typeof serverEventSchemas;
export type RoomServerEventName = keyof ServerEventSchemas;

/** A validated server event; narrowing on `name` narrows `payload`. */
export type RoomServerEvent = {
  [Name in RoomServerEventName]: { name: Name; payload: z.infer<ServerEventSchemas[Name]> };
}[RoomServerEventName];

export const isRoomServerEventName = (name: string): name is RoomServerEventName =>
  Object.hasOwn(serverEventSchemas, name);

/** `null` for an unknown name or a payload that does not match the contract. */
export function parseRoomServerEvent(name: string, payload: unknown): RoomServerEvent | null {
  if (!isRoomServerEventName(name)) {
    return null;
  }
  const parsed = serverEventSchemas[name].safeParse(payload);
  // The schema is chosen by `name`, so the pair is consistent; the union just cannot see it.
  return parsed.success ? ({ name, payload: parsed.data } as RoomServerEvent) : null;
}

export type RoomClientEventName =
  'room:join' | 'room:leave' | 'room:knock' | 'room:knock:cancel' | 'room:chat:send';

/** Failures that never reached the server's acknowledgement. */
export type SocketFailureCode = 'OFFLINE' | 'TIMEOUT' | 'MALFORMED_RESPONSE';

const failureAck = z.object({
  ok: z.literal(false),
  error: z.object({ code: errorCodeSchema, message: z.string() }),
});

const okAck = z.object({ ok: z.literal(true) });

export const roomAckSchemas = {
  join: z.discriminatedUnion('ok', [roomJoinResultSchema.extend(okAck.shape), failureAck]),
  empty: z.discriminatedUnion('ok', [okAck, failureAck]),
  knock: z.discriminatedUnion('ok', [roomKnockResultSchema.extend(okAck.shape), failureAck]),
  chat: z.discriminatedUnion('ok', [roomChatSendResultSchema.extend(okAck.shape), failureAck]),
} as const;

export type RoomFailureAck = {
  ok: false;
  error: { code: ErrorCode | SocketFailureCode; message: string };
};

/** What an acknowledgement schema parses to, or a failure that never reached the server. */
export type RoomAck<Schema extends z.ZodType> = z.infer<Schema> | RoomFailureAck;
export type JoinAck = RoomAck<typeof roomAckSchemas.join>;
export type EmptyRoomAck = RoomAck<typeof roomAckSchemas.empty>;
export type KnockAck = RoomAck<typeof roomAckSchemas.knock>;
export type ChatAck = RoomAck<typeof roomAckSchemas.chat>;
