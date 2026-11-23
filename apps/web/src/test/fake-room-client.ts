import {
  type ErrorCode,
  focusRunIdSchema,
  type RoomFocusParticipant,
  roomFocusParticipantSchema,
  type RoomFocusSnapshot,
  roomFocusSnapshotSchema,
  type TimerView,
  timerViewSchema,
} from '@focus-flow/contracts';
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
  type TimerAck,
} from '../features/realtime/room-events';
import type { FakeRoom } from './fake-room-api';
import { NAMES, RAW_NEXT_RUN_ID, RAW_RUN_ID } from './fake-room-api';

/** The default focus run and the one that follows it (branded, as the contract requires). */
export const RUN_ID = focusRunIdSchema.parse(RAW_RUN_ID);
export const NEXT_RUN_ID = focusRunIdSchema.parse(RAW_NEXT_RUN_ID);
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

/**
 * A validated timer as the server would send it; an idle 25-minute focus phase (in the run
 * `RUN_ID`) by default. A break has no run (RF2) unless the test says otherwise.
 */
export const timerView = (roomId: string, overrides: Partial<TimerView> = {}): TimerView =>
  timerViewSchema.parse({
    roomId,
    phase: 'focus',
    status: 'idle',
    durationMs: 1_500_000,
    elapsedBeforeMs: 0,
    segmentStartedAtMs: null,
    endsAtMs: null,
    version: 1_000,
    focusRunId: (overrides.phase ?? 'focus') === 'focus' ? RUN_ID : null,
    ...overrides,
  });

/** A participant as the server sends it: connected, opted in a moment ago. */
export const focusParticipant = (
  userId: string,
  overrides: Partial<RoomFocusParticipant> = {},
): RoomFocusParticipant =>
  roomFocusParticipantSchema.parse({
    userId,
    displayName: NAMES[userId] ?? 'Someone',
    avatarUrl: null,
    optedInAtMs: 1_000,
    connected: true,
    disconnectedAtMs: null,
    ...overrides,
  });

/** A validated focus snapshot: the default run, nobody opted in, the caller not participating. */
export const focusSnapshot = (overrides: Partial<RoomFocusSnapshot> = {}): RoomFocusSnapshot =>
  roomFocusSnapshotSchema.parse({
    focusRunId: RUN_ID,
    participants: [],
    participantsVersion: 0,
    me: { participation: null },
    ...overrides,
  });

/** A validated `room:join` acknowledgement (so ids are branded, as in production). */
export function joinOk(
  room: FakeRoom,
  presentIds: string[],
  pendingKnocks?: Array<{ userId: string; expiresAtMs: number }>,
  timer?: Partial<TimerView>,
  focus?: Partial<RoomFocusSnapshot>,
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
      timer: timerView(room.id, timer),
      focus: focusSnapshot(
        focus ??
          (timer?.phase !== undefined && timer.phase !== 'focus' ? { focusRunId: null } : {}),
      ),
      serverNowMs: Date.now(),
    },
  });
}

/** A validated accepted-command acknowledgement. */
export const timerOk = (timer: TimerView): TimerAck =>
  roomAckSchemas.timer.parse({ ok: true, timer, serverNowMs: Date.now() });

/** A validated server event, so a test cannot push a payload the real client would drop. */
export function serverEvent(name: RoomServerEventName, payload: unknown): RoomServerEvent {
  const event = parseRoomServerEvent(name, payload);
  if (event === null) {
    throw new Error(`Test pushed an invalid ${name} payload.`);
  }
  return event;
}

/**
 * The stub realtime client with the six room requests as programmable mocks. Each defaults
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
  const sendTimerCommand = vi.fn<RealtimeClient['sendTimerCommand']>((): Promise<TimerAck> =>
    refuse(),
  );
  return Object.assign(stub, {
    joinRoom,
    leaveRoom,
    knockRoom,
    cancelKnock,
    sendChat,
    sendTimerCommand,
    /** Pushes a server event, validated like the real client does. */
    push: (name: RoomServerEventName, payload: unknown) => {
      stub.emitRoomEvent(serverEvent(name, payload));
    },
  });
}

export type FakeRoomClient = ReturnType<typeof createFakeRoomClient>;
