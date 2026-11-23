import {
  type FocusRunId,
  type KnockView,
  type PresenceUser,
  type RoomChatMessageEvent,
  roomChatMessageEventSchema,
  type RoomFocusParticipant,
  roomFocusParticipantSchema,
  type RoomFocusSnapshot,
  type RoomId,
  roomIdSchema,
  roomSnapshotSchema,
  type TimerView,
  type UserId,
  userIdSchema,
} from '@focus-flow/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { focusSnapshot, NEXT_RUN_ID, RUN_ID, timerView } from '../../test/fake-room-client';
import {
  type ChatEntry,
  createRoomLiveStore,
  getRoomLiveStore,
  incomingKnocksFor,
  MAX_CHAT_MESSAGES,
  resetRoomLiveState,
  useKnockStore,
} from './room-live-store';

const ROOM: RoomId = roomIdSchema.parse('0191a3b2-7c4d-7e5f-8a9b-0c1d2e3f4a5b');
const OTHER_ROOM: RoomId = roomIdSchema.parse('0191a3b2-7c4d-7e5f-8a9b-0c1d2e3f4a5c');
const ADA: UserId = userIdSchema.parse('3f1c4b0a-5b6d-4e2f-9a8b-7c6d5e4f3a2b');
const GRACE: UserId = userIdSchema.parse('7b0a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d');

const TIMER = timerView(ROOM);

const person = (userId: UserId, displayName: string): PresenceUser => ({
  userId,
  displayName,
  avatarUrl: null,
});

const snapshot = (
  present: PresenceUser[],
  timer: TimerView = TIMER,
  focus: Partial<RoomFocusSnapshot> = {},
) =>
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
    presence: present,
    timer,
    focus: focusSnapshot({ focusRunId: timer.focusRunId, ...focus }),
    serverNowMs: 1,
  });

const incoming = (n: number): RoomChatMessageEvent =>
  roomChatMessageEventSchema.parse({
    roomId: ROOM,
    messageId: `0191a3b2-7c4d-7e5f-8a9b-${String(n).padStart(12, '0')}`,
    clientMessageId: `1191a3b2-7c4d-7e5f-8a9b-${String(n).padStart(12, '0')}`,
    sender: { userId: GRACE, displayName: 'Grace' },
    body: `m${String(n)}`,
    sentAtMs: n,
  });

const pending = (clientMessageId: string): ChatEntry => ({
  clientMessageId,
  messageId: null,
  sender: { userId: ADA, displayName: 'You' },
  body: 'hello',
  sentAtMs: null,
  status: 'pending',
  error: null,
});

beforeEach(() => {
  resetRoomLiveState();
});

describe('room live store: join and presence', () => {
  it('starts idle and moves joining, joined; the snapshot replaces presence', () => {
    const store = createRoomLiveStore(ROOM);
    expect(store.getState().joinStatus).toBe('idle');
    store.getState().joining();
    expect(store.getState().joinStatus).toBe('joining');
    store.getState().joined(snapshot([person(ADA, 'Ada')]));
    expect(store.getState().joinStatus).toBe('joined');
    expect(store.getState().presence).toEqual([person(ADA, 'Ada')]);

    store.getState().presenceJoined(person(GRACE, 'Grace'));
    store.getState().joined(snapshot([person(GRACE, 'Grace')]));
    expect(store.getState().presence).toEqual([person(GRACE, 'Grace')]);
  });

  it('replays presence events that arrived between the request and its older snapshot', () => {
    const store = createRoomLiveStore(ROOM);
    store.getState().joining();
    store.getState().presenceLeft(GRACE);
    store.getState().presenceJoined(person(ADA, 'Ada'));
    // The snapshot was taken before both events.
    store.getState().joined(snapshot([person(GRACE, 'Grace')]));
    expect(store.getState().presence).toEqual([person(ADA, 'Ada')]);
    // Once answered, later snapshots are not shaped by the old buffer.
    store.getState().joining();
    store.getState().joined(snapshot([person(GRACE, 'Grace')]));
    expect(store.getState().presence).toEqual([person(GRACE, 'Grace')]);
  });

  it('forgets buffered presence events when the request is abandoned', () => {
    const store = createRoomLiveStore(ROOM);
    store.getState().joining();
    store.getState().presenceLeft(GRACE);
    store.getState().disconnected();
    store.getState().joined(snapshot([person(GRACE, 'Grace')]));
    expect(store.getState().presence).toEqual([person(GRACE, 'Grace')]);
  });

  it('does not fall back from joined to joining on a repeated join request', () => {
    const store = createRoomLiveStore(ROOM);
    store.getState().joined(snapshot([]));
    store.getState().joining();
    expect(store.getState().joinStatus).toBe('joined');
  });

  it('keeps one entry per user however often presence joined arrives', () => {
    const store = createRoomLiveStore(ROOM);
    store.getState().presenceJoined(person(GRACE, 'Grace'));
    store.getState().presenceJoined(person(GRACE, 'Grace H.'));
    expect(store.getState().presence).toEqual([person(GRACE, 'Grace H.')]);
    store.getState().presenceLeft(GRACE);
    store.getState().presenceLeft(GRACE);
    expect(store.getState().presence).toEqual([]);
  });

  it('records a refusal and a lost connection', () => {
    const store = createRoomLiveStore(ROOM);
    store.getState().joinFailed('not_member', 'Nope.');
    expect(store.getState()).toMatchObject({ joinStatus: 'not_member', joinError: 'Nope.' });
    store.getState().joined(snapshot([]));
    expect(store.getState().joinError).toBeNull();
    store.getState().disconnected();
    expect(store.getState().joinStatus).toBe('idle');
  });

  it('empties the room when the user is removed', () => {
    const store = createRoomLiveStore(ROOM);
    store.getState().joined(snapshot([person(ADA, 'Ada')]));
    store.getState().chatReceived(incoming(1));
    store.getState().memberRemoved('removed');
    expect(store.getState()).toMatchObject({
      removed: 'removed',
      joinStatus: 'idle',
      presence: [],
      messages: [],
    });
    store.getState().reset();
    expect(store.getState().removed).toBeNull();
  });

  it('keeps one store per room', () => {
    expect(getRoomLiveStore(ROOM)).toBe(getRoomLiveStore(ROOM));
    expect(getRoomLiveStore(ROOM)).not.toBe(getRoomLiveStore(OTHER_ROOM));
  });
});

describe('room live store: chat', () => {
  it('adds a pending message once, then marks it sent by the acknowledgement', () => {
    const store = createRoomLiveStore(ROOM);
    store.getState().chatPending(pending('c1'));
    store.getState().chatPending(pending('c1'));
    expect(store.getState().messages).toHaveLength(1);
    store.getState().chatSent('c1', { messageId: 'm1', sentAtMs: 9 });
    expect(store.getState().messages[0]).toMatchObject({
      status: 'sent',
      messageId: 'm1',
      sentAtMs: 9,
    });
  });

  it('merges the echo of a pending message into the same entry', () => {
    const store = createRoomLiveStore(ROOM);
    const echo = { ...incoming(1), sender: { userId: ADA, displayName: 'Ada' } };
    store.getState().chatPending({ ...pending(echo.clientMessageId) });
    store.getState().chatReceived(echo);
    store.getState().chatReceived(echo);
    expect(store.getState().messages).toHaveLength(1);
    expect(store.getState().messages[0]).toMatchObject({
      status: 'sent',
      messageId: echo.messageId,
    });
  });

  it('does not let another sender reusing a clientMessageId touch my pending entry', () => {
    const store = createRoomLiveStore(ROOM);
    const spoof = incoming(1);
    store.getState().chatPending(pending(spoof.clientMessageId));
    store.getState().chatReceived(spoof);
    const { messages } = store.getState();
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ sender: { userId: ADA }, status: 'pending' });
    expect(messages[1]).toMatchObject({ sender: { userId: GRACE }, messageId: spoof.messageId });
    expect(new Set(messages.map((m) => m.clientMessageId)).size).toBe(2);
    // A repeat of the same foreign message is still one entry (dedupe by messageId).
    store.getState().chatReceived(spoof);
    expect(store.getState().messages).toHaveLength(2);
  });

  it('shows a message delivered twice (same message id) once', () => {
    const store = createRoomLiveStore(ROOM);
    const first = incoming(1);
    store.getState().chatReceived(first);
    store.getState().chatReceived({
      ...first,
      clientMessageId: roomChatMessageEventSchema.shape.clientMessageId.parse(
        '2191a3b2-7c4d-7e5f-8a9b-000000000001',
      ),
    });
    expect(store.getState().messages).toHaveLength(1);
  });

  it('fails a pending message, retries it as pending, and never fails a delivered one', () => {
    const store = createRoomLiveStore(ROOM);
    store.getState().chatPending(pending('c1'));
    store.getState().chatFailed('c1', 'Timed out.');
    expect(store.getState().messages[0]).toMatchObject({ status: 'failed', error: 'Timed out.' });
    store.getState().chatRetrying('c1');
    expect(store.getState().messages[0]).toMatchObject({ status: 'pending', error: null });
    store.getState().chatSent('c1', { messageId: 'm1', sentAtMs: 1 });
    store.getState().chatFailed('c1', 'late failure');
    expect(store.getState().messages[0]?.status).toBe('sent');
  });

  it(`keeps only the newest ${String(MAX_CHAT_MESSAGES)} messages`, () => {
    const store = createRoomLiveStore(ROOM);
    for (let n = 1; n <= MAX_CHAT_MESSAGES + 5; n += 1) {
      store.getState().chatReceived(incoming(n));
    }
    const { messages } = store.getState();
    expect(messages).toHaveLength(MAX_CHAT_MESSAGES);
    expect(messages[0]?.body).toBe('m6');
    expect(messages.at(-1)?.body).toBe(`m${String(MAX_CHAT_MESSAGES + 5)}`);
  });
});

describe('knock store', () => {
  const knock = (userId: UserId, expiresAtMs: number): KnockView => ({
    userId,
    displayName: 'Someone',
    avatarUrl: null,
    expiresAtMs,
  });

  it('keeps arrival order, refreshes a repeated knock and removes by user', () => {
    const { knockReceived, knockRemoved } = useKnockStore.getState();
    knockReceived(ROOM, knock(GRACE, 10));
    knockReceived(ROOM, knock(ADA, 20));
    knockReceived(ROOM, knock(GRACE, 30));
    expect(incomingKnocksFor(ROOM)(useKnockStore.getState()).map((k) => k.expiresAtMs)).toEqual([
      30, 20,
    ]);
    knockRemoved(ROOM, GRACE);
    knockRemoved(ROOM, GRACE);
    expect(incomingKnocksFor(ROOM)(useKnockStore.getState()).map((k) => k.userId)).toEqual([ADA]);
  });

  it('keeps rooms apart and lets a snapshot replace one room', () => {
    const state = useKnockStore.getState();
    state.knockReceived(ROOM, knock(GRACE, 10));
    state.knockReceived(OTHER_ROOM, knock(GRACE, 10));
    state.replaceIncoming(ROOM, [knock(ADA, 5)]);
    expect(incomingKnocksFor(ROOM)(useKnockStore.getState()).map((k) => k.userId)).toEqual([ADA]);
    expect(incomingKnocksFor(OTHER_ROOM)(useKnockStore.getState())).toHaveLength(1);
  });

  it("tracks this user's own knock outcome per room and clears it", () => {
    const state = useKnockStore.getState();
    state.outgoingWaiting(ROOM, 99);
    expect(useKnockStore.getState().outgoing[ROOM]).toEqual({ status: 'waiting', expiresAtMs: 99 });
    state.outgoingResolved(ROOM, 'rejected');
    expect(useKnockStore.getState().outgoing[ROOM]).toEqual({ status: 'rejected' });
    state.clearOutgoing(ROOM);
    expect(useKnockStore.getState().outgoing[ROOM]).toBeUndefined();
  });

  it('is emptied, together with every room store, by resetRoomLiveState', () => {
    getRoomLiveStore(ROOM).getState().presenceJoined(person(GRACE, 'Grace'));
    useKnockStore.getState().knockReceived(ROOM, knock(GRACE, 10));
    useKnockStore.getState().outgoingWaiting(OTHER_ROOM, 5);
    resetRoomLiveState();
    expect(getRoomLiveStore(ROOM).getState().presence).toEqual([]);
    expect(useKnockStore.getState().incoming).toEqual({});
    expect(useKnockStore.getState().outgoing).toEqual({});
  });
});

describe('room live store: the shared timer', () => {
  const at = (version: number, overrides: Partial<TimerView> = {}) =>
    timerView(ROOM, { version, ...overrides });

  it('has no timer until the first snapshot, which is authoritative', () => {
    const store = createRoomLiveStore(ROOM);
    expect(store.getState().timer).toBeNull();
    store.getState().joined(snapshot([], at(5)));
    expect(store.getState().timer?.version).toBe(5);
  });

  it('applies a newer event and ignores an older or equal one', () => {
    const store = createRoomLiveStore(ROOM);
    store.getState().joined(snapshot([], at(10)));
    store.getState().timerReceived(at(11, { status: 'paused' }));
    expect(store.getState().timer).toMatchObject({ version: 11, status: 'paused' });
    store.getState().timerReceived(at(10, { status: 'running' }));
    store.getState().timerReceived(at(11, { status: 'running' }));
    expect(store.getState().timer).toMatchObject({ version: 11, status: 'paused' });
  });

  it("ignores another room's timer", () => {
    const store = createRoomLiveStore(ROOM);
    store.getState().joined(snapshot([], at(10)));
    store.getState().timerReceived(timerView(OTHER_ROOM, { version: 99 }));
    expect(store.getState().timer?.version).toBe(10);
  });

  it('lets a snapshot replace the held timer even when its version is lower (after Redis loss)', () => {
    const store = createRoomLiveStore(ROOM);
    store.getState().joined(snapshot([], at(500, { status: 'paused' })));
    store.getState().joining();
    store.getState().joined(snapshot([], at(3)));
    expect(store.getState().timer).toMatchObject({ version: 3, status: 'idle' });
  });

  it('replays the newest event that arrived between the request and an older snapshot', () => {
    const store = createRoomLiveStore(ROOM);
    store.getState().joining();
    store.getState().timerReceived(at(8, { status: 'running' }));
    store.getState().timerReceived(at(9, { status: 'paused' }));
    store.getState().timerReceived(at(7));
    store.getState().joined(snapshot([], at(6)));
    expect(store.getState().timer).toMatchObject({ version: 9, status: 'paused' });
  });

  it('keeps the snapshot when it is newer than the buffered events', () => {
    const store = createRoomLiveStore(ROOM);
    store.getState().joining();
    store.getState().timerReceived(at(8));
    store.getState().joined(snapshot([], at(12, { status: 'running' })));
    expect(store.getState().timer).toMatchObject({ version: 12, status: 'running' });
  });

  it('does not carry a buffered event into a later join once answered or abandoned', () => {
    const store = createRoomLiveStore(ROOM);
    store.getState().joining();
    store.getState().timerReceived(at(50));
    store.getState().joined(snapshot([], at(1)));
    expect(store.getState().timer?.version).toBe(50);
    store.getState().joining();
    store.getState().joined(snapshot([], at(2)));
    expect(store.getState().timer?.version).toBe(2);

    store.getState().joining();
    store.getState().timerReceived(at(70));
    store.getState().disconnected();
    store.getState().joined(snapshot([], at(3)));
    expect(store.getState().timer?.version).toBe(3);
  });

  it('keeps the last timer while disconnected, and forgets it on removal or reset', () => {
    const store = createRoomLiveStore(ROOM);
    store.getState().joined(snapshot([], at(10)));
    store.getState().disconnected();
    expect(store.getState().timer?.version).toBe(10);
    store.getState().memberRemoved('removed');
    expect(store.getState().timer).toBeNull();
    store.getState().joined(snapshot([], at(10)));
    store.getState().reset();
    expect(store.getState().timer).toBeNull();
  });
});

describe('room live store: focus participants and their server version (G2)', () => {
  const participant = (userId: UserId, name: string): RoomFocusParticipant =>
    roomFocusParticipantSchema.parse({
      userId,
      displayName: name,
      avatarUrl: null,
      optedInAtMs: 1,
      connected: true,
      disconnectedAtMs: null,
    });
  const ADA_P = participant(ADA, 'Ada');
  const GRACE_P = participant(GRACE, 'Grace');
  const event = (
    focusRunId: FocusRunId,
    participantsVersion: number,
    participants: RoomFocusParticipant[],
  ) => ({ roomId: ROOM, focusRunId, participants, participantsVersion });
  /** A join snapshot whose focus part is the run's list at `participantsVersion`. */
  const snapshotAt = (participantsVersion: number, participants: RoomFocusParticipant[]) =>
    snapshot([], TIMER, { participants, participantsVersion });
  const names = (store: ReturnType<typeof createRoomLiveStore>) =>
    store.getState().focus?.participants.map((entry) => entry.displayName);
  const versionOf = (store: ReturnType<typeof createRoomLiveStore>) =>
    store.getState().focus?.participantsVersion;

  it('(a) an event older than the snapshot loses: the snapshot wins', () => {
    const store = createRoomLiveStore(ROOM);
    store.getState().joining();
    store.getState().focusParticipantsReceived(event(RUN_ID, 1, [ADA_P]));
    store.getState().joined(snapshotAt(2, [ADA_P, GRACE_P]));
    expect(names(store)).toEqual(['Ada', 'Grace']);
    expect(versionOf(store)).toBe(2);
  });

  it('(a) an event with the snapshot version carries nothing new: the snapshot stays', () => {
    const store = createRoomLiveStore(ROOM);
    store.getState().joining();
    store.getState().focusParticipantsReceived(event(RUN_ID, 2, [ADA_P]));
    store.getState().joined(snapshotAt(2, [ADA_P, GRACE_P]));
    expect(names(store)).toEqual(['Ada', 'Grace']);
  });

  it('(b) an event newer than the snapshot wins and sets the version', () => {
    const store = createRoomLiveStore(ROOM);
    store.getState().joining();
    store.getState().focusParticipantsReceived(event(RUN_ID, 3, [ADA_P, GRACE_P]));
    store.getState().joined(snapshotAt(2, [ADA_P]));
    expect(names(store)).toEqual(['Ada', 'Grace']);
    expect(versionOf(store)).toBe(3);
  });

  it('(c) of several buffered events the highest version wins, whatever the arrival order', () => {
    const store = createRoomLiveStore(ROOM);
    store.getState().joining();
    store.getState().focusParticipantsReceived(event(RUN_ID, 2, [ADA_P, GRACE_P]));
    store.getState().focusParticipantsReceived(event(RUN_ID, 4, []));
    store.getState().focusParticipantsReceived(event(RUN_ID, 3, [ADA_P]));
    store.getState().joined(snapshotAt(1, [ADA_P]));
    expect(names(store)).toEqual([]);
    expect(versionOf(store)).toBe(4);
  });

  it('(c) an out-of-order event does not overwrite newer state even before the answer', () => {
    const store = createRoomLiveStore(ROOM);
    store.getState().joining();
    store.getState().focusParticipantsReceived(event(RUN_ID, 3, [ADA_P, GRACE_P]));
    store.getState().focusParticipantsReceived(event(RUN_ID, 2, [ADA_P]));
    expect(names(store)).toEqual(['Ada', 'Grace']);
    expect(versionOf(store)).toBe(3);
  });

  it('(d) events about other runs are never applied across runs, nor mixed up when buffered', () => {
    const store = createRoomLiveStore(ROOM);
    store.getState().joining();
    // A higher version of ANOTHER run must not beat or replace the shown run's list.
    store.getState().focusParticipantsReceived(event(NEXT_RUN_ID, 9, [GRACE_P]));
    store.getState().focusParticipantsReceived(event(RUN_ID, 2, [ADA_P]));
    store.getState().joined(snapshotAt(1, []));
    expect(store.getState().focus?.focusRunId).toBe(RUN_ID);
    expect(names(store)).toEqual(['Ada']);
    expect(versionOf(store)).toBe(2);
  });

  it('(d) a buffered event about a different run than the snapshot shows is dropped', () => {
    const store = createRoomLiveStore(ROOM);
    store.getState().joining();
    store.getState().focusParticipantsReceived(event(NEXT_RUN_ID, 9, [ADA_P]));
    store.getState().joined(snapshotAt(1, [GRACE_P]));
    expect(store.getState().focus?.focusRunId).toBe(RUN_ID);
    expect(names(store)).toEqual(['Grace']);
    expect(versionOf(store)).toBe(1);
  });

  it('(d) a version from the old run does not block the new run, which starts again at 0', () => {
    const store = createRoomLiveStore(ROOM);
    store.getState().joining();
    store.getState().joined(snapshotAt(5, [ADA_P]));
    store.getState().focusParticipantsReceived(event(NEXT_RUN_ID, 1, [GRACE_P]));
    expect(store.getState().focus?.focusRunId).toBe(NEXT_RUN_ID);
    expect(names(store)).toEqual(['Grace']);
    expect(versionOf(store)).toBe(1);
    // ...and the run that was replaced stays replaced, whatever its version.
    store.getState().focusParticipantsReceived(event(RUN_ID, 9, [ADA_P]));
    expect(store.getState().focus?.focusRunId).toBe(NEXT_RUN_ID);
  });

  it('(e) later updates apply in increasing version order; stale and duplicate ones are ignored', () => {
    const store = createRoomLiveStore(ROOM);
    store.getState().joining();
    store.getState().joined(snapshotAt(2, [ADA_P]));
    store.getState().focusParticipantsReceived(event(RUN_ID, 3, [ADA_P, GRACE_P]));
    expect(names(store)).toEqual(['Ada', 'Grace']);
    store.getState().focusParticipantsReceived(event(RUN_ID, 3, [ADA_P])); // duplicate version
    store.getState().focusParticipantsReceived(event(RUN_ID, 2, [])); // stale
    expect(names(store)).toEqual(['Ada', 'Grace']);
    expect(versionOf(store)).toBe(3);
    store.getState().focusParticipantsReceived(event(RUN_ID, 4, [GRACE_P]));
    expect(names(store)).toEqual(['Grace']);
    expect(versionOf(store)).toBe(4);
  });

  it('a snapshot after a Redis loss is authoritative even with a lower version', () => {
    const store = createRoomLiveStore(ROOM);
    store.getState().joining();
    store.getState().joined(snapshotAt(7, [ADA_P, GRACE_P]));
    store.getState().joining();
    store.getState().joined(snapshotAt(0, []));
    expect(names(store)).toEqual([]);
    expect(versionOf(store)).toBe(0);
    store.getState().focusParticipantsReceived(event(RUN_ID, 1, [ADA_P]));
    expect(names(store)).toEqual(['Ada']);
  });

  it('uses the snapshot as is when no event arrived', () => {
    const store = createRoomLiveStore(ROOM);
    store.getState().joining();
    store.getState().joined(snapshotAt(0, []));
    expect(names(store)).toEqual([]);
  });

  it('drops a buffered event when the socket drops before the answer', () => {
    const store = createRoomLiveStore(ROOM);
    store.getState().joining();
    store.getState().focusParticipantsReceived(event(RUN_ID, 5, [ADA_P]));
    store.getState().disconnected();
    store.getState().joining();
    store.getState().joined(snapshotAt(1, []));
    expect(names(store)).toEqual([]);
  });

  it('does not carry an event into a later join', () => {
    const store = createRoomLiveStore(ROOM);
    store.getState().joining();
    store.getState().joined(snapshotAt(0, []));
    store.getState().focusParticipantsReceived(event(RUN_ID, 1, [GRACE_P]));
    expect(names(store)).toEqual(['Grace']);
    store.getState().joining();
    store.getState().joined(snapshotAt(0, []));
    expect(names(store)).toEqual([]);
  });
});
