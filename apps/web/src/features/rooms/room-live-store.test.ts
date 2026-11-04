import {
  type KnockView,
  type PresenceUser,
  type RoomChatMessageEvent,
  roomChatMessageEventSchema,
  type RoomId,
  roomIdSchema,
  roomSnapshotSchema,
  type UserId,
  userIdSchema,
} from '@focus-flow/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

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

const person = (userId: UserId, displayName: string): PresenceUser => ({
  userId,
  displayName,
  avatarUrl: null,
});

const snapshot = (present: PresenceUser[]) =>
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
