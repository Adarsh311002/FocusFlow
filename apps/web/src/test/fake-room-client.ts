import type { ErrorCode } from '@focus-flow/contracts';
import { vi } from 'vitest';

import type { RealtimeClient } from '../features/realtime/realtime-client';
import {
  type ChatAck,
  type EmptyRoomAck,
  type JoinAck,
  type KnockAck,
  parseRoomServerEvent,
  roomAckSchemas,
  type RoomFailureAck,
  type RoomServerEvent,
  type RoomServerEventName,
  type SocketFailureCode,
} from '../features/realtime/room-events';
import type { FakeRoom } from './fake-room-api';
import { NAMES } from './fake-room-api';
import { createStubRealtimeClient } from './realtime-stub';

/** A failed acknowledgement, as the real client would hand it to a component. */
export const ackFailure = (
  code: ErrorCode | SocketFailureCode,
  message = 'Refused.',
): RoomFailureAck => ({ ok: false, error: { code, message } });

export const presenceUser = (userId: string) => ({
  userId,
  displayName: NAMES[userId] ?? 'Someone',
  avatarUrl: null,
});

/** A validated `room:join` acknowledgement (so ids are branded, as in production). */
export function joinOk(
  room: FakeRoom,
  presentIds: string[],
  pendingKnocks?: Array<{ userId: string; expiresAtMs: number }>,
): JoinAck {
  return roomAckSchemas.join.parse({
    ok: true,
    snapshot: {
      room: {
        id: room.id,
        code: room.code,
        name: room.name,
        isPrivate: room.isPrivate,
        hostId: room.hostId,
        timerSettings: room.timerSettings,
        createdAt: room.createdAt,
      },
      presence: presentIds.map(presenceUser),
      ...(pendingKnocks === undefined
        ? {}
        : {
            pendingKnocks: pendingKnocks.map((knock) => ({
              ...presenceUser(knock.userId),
              expiresAtMs: knock.expiresAtMs,
            })),
          }),
      serverNowMs: Date.now(),
    },
  });
}

/** A validated server event, so a test cannot push a payload the real client would drop. */
export function serverEvent(name: RoomServerEventName, payload: unknown): RoomServerEvent {
  const event = parseRoomServerEvent(name, payload);
  if (event === null) {
    throw new Error(`Test pushed an invalid ${name} payload.`);
  }
  return event;
}

/**
 * The stub realtime client with the five room requests as programmable mocks. Each defaults
 * to a refusal until a test says what the server answers.
 */
export function createFakeRoomClient() {
  const stub = createStubRealtimeClient();
  const refuse = () => Promise.resolve(ackFailure('INTERNAL', 'Not programmed.'));
  const joinRoom = vi.fn<RealtimeClient['joinRoom']>((): Promise<JoinAck> => refuse());
  const leaveRoom = vi.fn<RealtimeClient['leaveRoom']>((): Promise<EmptyRoomAck> =>
    Promise.resolve(roomAckSchemas.empty.parse({ ok: true })),
  );
  const knockRoom = vi.fn<RealtimeClient['knockRoom']>((): Promise<KnockAck> => refuse());
  const cancelKnock = vi.fn<RealtimeClient['cancelKnock']>((): Promise<EmptyRoomAck> =>
    Promise.resolve(roomAckSchemas.empty.parse({ ok: true })),
  );
  const sendChat = vi.fn<RealtimeClient['sendChat']>((): Promise<ChatAck> => refuse());
  return Object.assign(stub, {
    joinRoom,
    leaveRoom,
    knockRoom,
    cancelKnock,
    sendChat,
    /** Pushes a server event, validated like the real client does. */
    push: (name: RoomServerEventName, payload: unknown) => {
      stub.emitRoomEvent(serverEvent(name, payload));
    },
  });
}

export type FakeRoomClient = ReturnType<typeof createFakeRoomClient>;
