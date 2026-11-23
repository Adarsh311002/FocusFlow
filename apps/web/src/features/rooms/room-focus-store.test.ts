import {
  focusSessionIdSchema,
  type RoomFocusParticipantsEvent,
  roomFocusParticipantsEventSchema,
  type RoomId,
  roomIdSchema,
  roomSnapshotSchema,
  type UserId,
  userIdSchema,
} from '@focus-flow/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  focusParticipant,
  focusSnapshot,
  NEXT_RUN_ID,
  RUN_ID,
  timerView,
} from '../../test/fake-room-client';
import { createRoomLiveStore } from './room-live-store';

const ROOM: RoomId = roomIdSchema.parse('0191a3b2-7c4d-7e5f-8a9b-0c1d2e3f4a5b');
const OTHER_ROOM: RoomId = roomIdSchema.parse('0191a3b2-7c4d-7e5f-8a9b-0c1d2e3f4a5c');
const ADA: UserId = userIdSchema.parse('3f1c4b0a-5b6d-4e2f-9a8b-7c6d5e4f3a2b');
const GRACE: UserId = userIdSchema.parse('7b0a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d');

const snapshot = (focus = focusSnapshot(), timer = timerView(ROOM)) =>
  roomSnapshotSchema.parse({
    room: {
      id: ROOM,
      code: 'ABC234',
      name: 'Deep work',
      isPrivate: false,
      hostId: ADA,
      timerSettings: { focusSeconds: 1_500, shortBreakSeconds: 300, longBreakSeconds: 900 },
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    presence: [],
    timer,
    focus,
    serverNowMs: 1,
  });

// Every event gets the next server version, as consecutive changes of one run do (G2).
let eventVersion = 0;

const participantsEvent = (
  runId: string | null,
  userIds: string[],
  roomId: string = ROOM,
): RoomFocusParticipantsEvent => {
  eventVersion += 1;
  return roomFocusParticipantsEventSchema.parse({
    roomId,
    focusRunId: runId,
    participants: userIds.map((id) => focusParticipant(id)),
    participantsVersion: runId === null ? 0 : eventVersion,
  });
};

let store: ReturnType<typeof createRoomLiveStore>;
beforeEach(() => {
  eventVersion = 0;
  store = createRoomLiveStore(ROOM);
});

describe('room live store: focus participants', () => {
  it('has no focus state until the first snapshot, which is authoritative', () => {
    expect(store.getState().focus).toBeNull();
    store.getState().joined(
      snapshot(
        focusSnapshot({
          participants: [focusParticipant(ADA)],
          me: { participation: null },
        }),
      ),
    );
    expect(store.getState().focus?.participants.map((entry) => entry.userId)).toEqual([ADA]);
    expect(store.getState().focus?.focusRunId).toBe(RUN_ID);
  });

  it('replaces the list from an event about the current run', () => {
    store.getState().joined(snapshot());
    store.getState().focusParticipantsReceived(participantsEvent(RUN_ID, [ADA, GRACE]));
    expect(store.getState().focus?.participants.map((entry) => entry.userId)).toEqual([ADA, GRACE]);
    store.getState().focusParticipantsReceived(participantsEvent(RUN_ID, [GRACE]));
    expect(store.getState().focus?.participants.map((entry) => entry.userId)).toEqual([GRACE]);
  });

  it('ignores another room, and a stale event about a run it already replaced', () => {
    store.getState().joined(snapshot());
    store.getState().focusParticipantsReceived(participantsEvent(RUN_ID, [ADA], OTHER_ROOM));
    expect(store.getState().focus?.participants).toEqual([]);

    // The run changes: new run, empty list.
    store.getState().focusParticipantsReceived(participantsEvent(NEXT_RUN_ID, []));
    expect(store.getState().focus?.focusRunId).toBe(NEXT_RUN_ID);
    // A late event of the old run must not bring the old list back.
    store.getState().focusParticipantsReceived(participantsEvent(RUN_ID, [ADA, GRACE]));
    expect(store.getState().focus?.focusRunId).toBe(NEXT_RUN_ID);
    expect(store.getState().focus?.participants).toEqual([]);
  });

  it('clears the participants and the participation when a new run starts, by event or by timer', () => {
    store.getState().joined(
      snapshot(
        focusSnapshot({
          participants: [focusParticipant(ADA)],
          me: {
            participation: {
              sessionId: focusSessionIdSchema.parse(crypto.randomUUID()),
              focusRunId: RUN_ID,
            },
          },
        }),
      ),
    );
    store.getState().focusParticipantsReceived(participantsEvent(NEXT_RUN_ID, [GRACE]));
    expect(store.getState().focus?.participants.map((entry) => entry.userId)).toEqual([GRACE]);
    expect(store.getState().focus?.me.participation).toBeNull();

    // A newer timer for yet another run empties the list until its own event arrives.
    store
      .getState()
      .timerReceived(timerView(ROOM, { version: 2_000, focusRunId: null, phase: 'short_break' }));
    expect(store.getState().focus).toMatchObject({ focusRunId: null, participants: [] });
  });

  it('follows a newer timer into a new run, but not an older timer back to an old one', () => {
    store.getState().joined(snapshot(focusSnapshot({ participants: [focusParticipant(ADA)] })));
    store.getState().timerReceived(timerView(ROOM, { version: 1_010, focusRunId: NEXT_RUN_ID }));
    expect(store.getState().focus).toMatchObject({ focusRunId: NEXT_RUN_ID, participants: [] });
    // An older-versioned timer is ignored by the version rule.
    store.getState().timerReceived(timerView(ROOM, { version: 1_005, focusRunId: RUN_ID }));
    expect(store.getState().focus?.focusRunId).toBe(NEXT_RUN_ID);
  });

  it('keeps the list when the timer only changes status inside the same run', () => {
    store.getState().joined(snapshot(focusSnapshot({ participants: [focusParticipant(ADA)] })));
    store.getState().timerReceived(timerView(ROOM, { version: 1_010, status: 'paused' }));
    expect(store.getState().focus?.participants).toHaveLength(1);
  });

  it('lets a new snapshot replace everything, even with an older-looking run', () => {
    store.getState().joined(snapshot());
    store.getState().focusParticipantsReceived(participantsEvent(NEXT_RUN_ID, [GRACE]));
    store.getState().joined(snapshot(focusSnapshot({ participants: [focusParticipant(ADA)] })));
    expect(store.getState().focus?.focusRunId).toBe(RUN_ID);
    expect(store.getState().focus?.participants.map((entry) => entry.userId)).toEqual([ADA]);
    // After a snapshot, events about the snapshot's run apply again.
    store.getState().focusParticipantsReceived(participantsEvent(RUN_ID, [ADA, GRACE]));
    expect(store.getState().focus?.participants).toHaveLength(2);
  });

  it('shows a break as no run, and forgets focus state on removal and reset', () => {
    store.getState().joined(snapshot(focusSnapshot({ participants: [focusParticipant(ADA)] })));
    store.getState().focusParticipantsReceived(participantsEvent(null, []));
    expect(store.getState().focus).toMatchObject({ focusRunId: null, participants: [] });

    store.getState().memberRemoved('removed');
    expect(store.getState().focus).toBeNull();
    store.getState().joined(snapshot());
    store.getState().reset();
    expect(store.getState().focus).toBeNull();
  });

  it('keeps the last focus picture while the socket is down', () => {
    store.getState().joined(snapshot(focusSnapshot({ participants: [focusParticipant(ADA)] })));
    store.getState().disconnected();
    expect(store.getState().joinStatus).toBe('idle');
    expect(store.getState().focus?.participants).toHaveLength(1);
  });
});
