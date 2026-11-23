import {
  API_BASE_PATH,
  roomChatMessageEventSchema,
  roomIdSchema,
  roomJoinResultSchema,
  roomKnockReceivedEventSchema,
  roomSnapshotSchema,
} from '@focus-flow/contracts';
import { and, eq } from 'drizzle-orm';
import type { Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  startInstance,
  startTestHarness,
  stopTestHarness,
  type TestHarness,
  type TestInstance,
} from '../../../test/harness.js';
import {
  closeAllSockets,
  connectSocket,
  emitWithAck,
  eventually,
  recordEvents,
} from '../../../test/sockets.js';
import { signUpTestUser, type TestUser } from '../../../test/users.js';
import { roomMembers } from '../../db/schema.js';
import { redisKeys } from '../../platform/redis-keys.js';

// Rooms over real Socket.IO clients, Redis and PostgreSQL, with two API instances: join
// snapshots and permissions, room presence, knocks, chat, membership eviction, instance
// death, Redis data loss and the races between them (Phase 6, M4–M10).

const TIMINGS = {
  INSTANCE_HEARTBEAT_MS: '200',
  INSTANCE_TTL_MS: '2000',
  KNOCK_TTL_MS: '1500',
  ROOM_MAX_PRESENT: '3',
};

let harness: TestHarness | undefined;
let second: TestInstance | undefined;

const requireHarness = (): TestHarness => {
  if (harness === undefined) {
    throw new Error('the API harness failed to start');
  }
  return harness;
};
const requireSecond = (): TestInstance => {
  if (second === undefined) {
    throw new Error('the second API instance failed to start');
  }
  return second;
};

beforeAll(async () => {
  harness = await startTestHarness(TIMINGS);
  second = await startInstance(harness, TIMINGS);
}, 180_000);

afterEach(() => {
  closeAllSockets();
});

afterAll(async () => {
  closeAllSockets();
  if (harness !== undefined) {
    await stopTestHarness(harness);
  }
}, 60_000);

type Answer = {
  ok: boolean;
  error?: { code: string };
  snapshot?: unknown;
  expiresAtMs?: number;
  messageId?: string;
  sentAtMs?: number;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const rest = async (
  user: TestUser,
  method: string,
  path: string,
  body?: unknown,
  baseUrl = requireHarness().baseUrl,
): Promise<{ status: number; json: unknown }> => {
  const response = await fetch(`${baseUrl}${API_BASE_PATH}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${user.accessToken}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, json: text === '' ? undefined : (JSON.parse(text) as unknown) };
};

const newUser = (label: string) => signUpTestUser(requireHarness(), label);

const createRoom = async (host: TestUser, isPrivate = false): Promise<string> => {
  const { status, json } = await rest(host, 'POST', '/rooms', { name: 'Test room', isPrivate });
  expect(status).toBe(201);
  return roomIdSchema.parse((json as { room: { id: string } }).room.id);
};

const joinMembership = async (user: TestUser, roomId: string): Promise<void> => {
  const { status } = await rest(user, 'POST', `/rooms/${roomId}/membership`);
  expect([200, 201]).toContain(status);
};

const connect = (user: TestUser, instance: { baseUrl: string } = requireHarness()) =>
  connectSocket(instance.baseUrl, user.accessToken);

const join = (socket: Socket, roomId: string): Promise<Answer> =>
  emitWithAck<Answer>(socket, 'room:join', { roomId });

const joinOk = async (socket: Socket, roomId: string): Promise<Answer> => {
  const answer = await join(socket, roomId);
  expect(answer).toMatchObject({ ok: true });
  return answer;
};

type PresentPayload = { roomId: string; user: { userId: string } };
type LeftPayload = { roomId: string; userId: string };

const redisEntries = (roomId: string, userId: string) =>
  requireHarness().redis.smembers(redisKeys.roomPresenceSockets(roomId, userId));

describe('room:join', () => {
  it('refuses non-members and nonexistent rooms alike', async () => {
    const host = await newUser('host');
    const stranger = await newUser('stranger');
    const roomId = await createRoom(host);
    const socket = await connect(stranger);

    expect(await join(socket, roomId)).toMatchObject({
      ok: false,
      error: { code: 'NOT_A_MEMBER' },
    });
    expect(await join(socket, '0199a000-0000-7000-8000-000000000000')).toMatchObject({
      ok: false,
      error: { code: 'NOT_A_MEMBER' },
    });
    expect(await redisEntries(roomId, stranger.userId)).toEqual([]);
  });

  it('validates the payload and tolerates a missing acknowledgement', async () => {
    const host = await newUser('host');
    const roomId = await createRoom(host);
    const socket = await connect(host);

    expect(await emitWithAck<Answer>(socket, 'room:join', {})).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    });
    expect(
      await emitWithAck<Answer>(socket, 'room:join', { roomId, userId: host.userId }),
    ).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    });
    socket.emit('room:join', { roomId });
    socket.emit('room:join', 'not an object');
    socket.emit('room:chat:send');
    await eventually(async () => (await redisEntries(roomId, host.userId)).length === 1);
    // The socket still answers after the unacknowledged calls.
    await joinOk(socket, roomId);
  });

  it('answers the snapshot, with pending knocks for the host only', async () => {
    const h = requireHarness();
    const host = await newUser('host');
    const member = await newUser('member');
    const roomId = await createRoom(host);
    await joinMembership(member, roomId);
    const hostSocket = await connect(host);
    const memberSocket = await connect(member);

    const hostAnswer = await joinOk(hostSocket, roomId);
    const hostSnapshot = roomJoinResultSchema.parse(hostAnswer).snapshot;
    expect(hostSnapshot.room.id).toBe(roomId);
    expect(hostSnapshot.room.hostId).toBe(host.userId);
    expect(hostSnapshot.presence.map((user) => user.userId)).toEqual([host.userId]);
    expect(hostSnapshot.pendingKnocks).toEqual([]);
    expect(Math.abs(hostSnapshot.serverNowMs - Date.now())).toBeLessThan(10_000);
    expect(await h.redis.hget(redisKeys.roomPresence(roomId), host.userId)).toContain(
      'firstJoinedAtMs',
    );
    expect(await h.redis.smembers(redisKeys.instanceRooms(h.runtime.instanceId))).toContain(
      `${roomId}:${host.userId}:${String(hostSocket.id)}`,
    );

    const memberSnapshot = roomSnapshotSchema.parse((await joinOk(memberSocket, roomId)).snapshot);
    expect(memberSnapshot.presence.map((user) => user.userId).sort()).toEqual(
      [host.userId, member.userId].sort(),
    );
    expect(memberSnapshot.pendingKnocks).toBeUndefined();
  });

  it('shows the host the knocks waiting for an answer', async () => {
    const host = await newUser('host');
    const visitor = await newUser('visitor');
    const roomId = await createRoom(host, true);
    const hostSocket = await connect(host);
    const visitorSocket = await connect(visitor);
    await eventually(async () => await requireHarness().runtime.presence.isUserOnline(host.userId));

    const knock = await emitWithAck<Answer>(visitorSocket, 'room:knock', { roomId });
    expect(knock).toMatchObject({ ok: true });

    const snapshot = roomSnapshotSchema.parse((await joinOk(hostSocket, roomId)).snapshot);
    expect(snapshot.pendingKnocks).toHaveLength(1);
    expect(snapshot.pendingKnocks?.[0]).toMatchObject({
      userId: visitor.userId,
      expiresAtMs: knock.expiresAtMs,
    });
  });

  it('is idempotent per socket', async () => {
    const host = await newUser('host');
    const member = await newUser('member');
    const roomId = await createRoom(host);
    await joinMembership(member, roomId);
    const hostSocket = await connect(host);
    const memberSocket = await connect(member);
    await joinOk(hostSocket, roomId);
    const arrivals = recordEvents<PresentPayload>(hostSocket, 'room:presence:joined');

    await joinOk(memberSocket, roomId);
    await joinOk(memberSocket, roomId);
    await joinOk(memberSocket, roomId);
    await eventually(() => arrivals.length >= 1);
    await sleep(300);

    expect(arrivals).toHaveLength(1);
    expect(await redisEntries(roomId, member.userId)).toHaveLength(1);
  });

  it('refuses a new person when the room is full, but not a second tab of someone present', async () => {
    const host = await newUser('host');
    const roomId = await createRoom(host);
    const people = await Promise.all([newUser('a'), newUser('b'), newUser('c')]);
    for (const person of people) {
      await joinMembership(person, roomId);
    }
    const [a, b, c] = people;
    await joinOk(await connect(host), roomId);
    await joinOk(await connect(a), roomId);
    await joinOk(await connect(b), roomId);

    expect(await join(await connect(c), roomId)).toMatchObject({
      ok: false,
      error: { code: 'ROOM_FULL' },
    });
    expect(await redisEntries(roomId, c.userId)).toEqual([]);
    // A second tab of a person already present is not a new person.
    await joinOk(await connect(a), roomId);
  });
});

describe('room presence', () => {
  it('shows each person to the others and announces arrivals', async () => {
    const host = await newUser('host');
    const guest = await newUser('guest');
    const roomId = await createRoom(host);
    await joinMembership(guest, roomId);
    const hostSocket = await connect(host);
    const guestSocket = await connect(guest);
    await joinOk(hostSocket, roomId);
    const arrivals = recordEvents<PresentPayload>(hostSocket, 'room:presence:joined');
    const guestArrivals = recordEvents<PresentPayload>(guestSocket, 'room:presence:joined');

    const snapshot = roomSnapshotSchema.parse((await joinOk(guestSocket, roomId)).snapshot);

    expect(snapshot.presence.map((user) => user.userId)).toContain(host.userId);
    await eventually(() => arrivals.length === 1);
    expect(arrivals[0]).toMatchObject({ roomId, user: { userId: guest.userId } });
    expect(guestArrivals).toEqual([]);
  });

  it('shows two tabs of one person once, and announces departure only for the last', async () => {
    const host = await newUser('host');
    const guest = await newUser('guest');
    const roomId = await createRoom(host);
    await joinMembership(guest, roomId);
    const hostSocket = await connect(host);
    await joinOk(hostSocket, roomId);
    const arrivals = recordEvents<PresentPayload>(hostSocket, 'room:presence:joined');
    const departures = recordEvents<LeftPayload>(hostSocket, 'room:presence:left');
    const tabOne = await connect(guest);
    const tabTwo = await connect(guest, requireSecond());
    await joinOk(tabOne, roomId);
    await joinOk(tabTwo, roomId);

    const snapshot = roomSnapshotSchema.parse((await joinOk(await connect(host), roomId)).snapshot);
    expect(snapshot.presence.filter((user) => user.userId === guest.userId)).toHaveLength(1);
    await eventually(() => arrivals.length === 1);

    tabOne.disconnect();
    await eventually(async () => (await redisEntries(roomId, guest.userId)).length === 1);
    await sleep(300);
    expect(departures).toEqual([]);

    tabTwo.disconnect();
    await eventually(() => departures.length === 1);
    expect(departures[0]).toEqual({ roomId, userId: guest.userId });
    expect(await redisEntries(roomId, guest.userId)).toEqual([]);
    expect(await requireHarness().redis.hexists(redisKeys.roomPresence(roomId), guest.userId)).toBe(
      0,
    );
  });

  it('ends presence, not membership, on an explicit leave', async () => {
    const h = requireHarness();
    const host = await newUser('host');
    const guest = await newUser('guest');
    const roomId = await createRoom(host);
    await joinMembership(guest, roomId);
    const hostSocket = await connect(host);
    const guestSocket = await connect(guest);
    await joinOk(hostSocket, roomId);
    await joinOk(guestSocket, roomId);
    const departures = recordEvents<LeftPayload>(hostSocket, 'room:presence:left');
    const chat = recordEvents(guestSocket, 'room:chat:message');

    expect(await emitWithAck<Answer>(guestSocket, 'room:leave', { roomId })).toEqual({ ok: true });

    await eventually(() => departures.length === 1);
    expect(departures[0]).toEqual({ roomId, userId: guest.userId });
    expect(await redisEntries(roomId, guest.userId)).toEqual([]);
    const [membership] = await h.db
      .select()
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, guest.userId)));
    expect(membership).toBeDefined();
    // No longer receives the room's messages, and may not send to it. The host's own send
    // is the positive control: it is accepted and delivered to the host.
    const hostHeard = recordEvents(hostSocket, 'room:chat:message');
    expect(
      await emitWithAck<Answer>(hostSocket, 'room:chat:send', {
        roomId,
        clientMessageId: crypto.randomUUID(),
        body: 'hello',
      }),
    ).toMatchObject({ ok: true });
    await eventually(() => hostHeard.length === 1);
    await sleep(200);
    expect(chat).toEqual([]);
    expect(await emitWithAck<Answer>(guestSocket, 'room:leave', { roomId })).toMatchObject({
      ok: false,
      error: { code: 'NOT_JOINED' },
    });
  });

  it('announces a departure when the connection closes', async () => {
    const host = await newUser('host');
    const guest = await newUser('guest');
    const roomId = await createRoom(host);
    await joinMembership(guest, roomId);
    const hostSocket = await connect(host);
    const guestSocket = await connect(guest);
    await joinOk(hostSocket, roomId);
    await joinOk(guestSocket, roomId);
    const departures = recordEvents<LeftPayload>(hostSocket, 'room:presence:left');

    guestSocket.disconnect();

    await eventually(() => departures.length === 1);
    expect(departures[0]).toEqual({ roomId, userId: guest.userId });
    expect(await redisEntries(roomId, guest.userId)).toEqual([]);
  });

  it('counts the people present in the room list', async () => {
    const host = await newUser('host');
    const roomId = await createRoom(host);
    await joinOk(await connect(host), roomId);
    await joinOk(await connect(host), roomId);

    const { json } = await rest(host, 'GET', '/rooms');
    const rooms = (json as { rooms: { id: string; presentCount: number }[] }).rooms;

    expect(rooms.find((room) => room.id === roomId)?.presentCount).toBe(1);
  });

  it('works across two API instances', async () => {
    const host = await newUser('host');
    const guest = await newUser('guest');
    const roomId = await createRoom(host);
    await joinMembership(guest, roomId);
    const hostSocket = await connect(host);
    const guestSocket = await connect(guest, requireSecond());
    await joinOk(hostSocket, roomId);
    const arrivals = recordEvents<PresentPayload>(hostSocket, 'room:presence:joined');
    const departures = recordEvents<LeftPayload>(hostSocket, 'room:presence:left');
    const hostChat = recordEvents(hostSocket, 'room:chat:message');
    const guestChat = recordEvents(guestSocket, 'room:chat:message');

    const snapshot = roomSnapshotSchema.parse((await joinOk(guestSocket, roomId)).snapshot);
    expect(snapshot.presence.map((user) => user.userId)).toContain(host.userId);
    await eventually(() => arrivals.length === 1);

    await emitWithAck(guestSocket, 'room:chat:send', {
      roomId,
      clientMessageId: crypto.randomUUID(),
      body: 'from the second instance',
    });
    await eventually(() => hostChat.length === 1 && guestChat.length === 1);

    guestSocket.disconnect();
    await eventually(() => departures.length === 1);
  });
});

describe('knocks', () => {
  const knock = (socket: Socket, roomId: string) =>
    emitWithAck<Answer>(socket, 'room:knock', { roomId });

  it('refuses knocks that make no sense', async () => {
    const host = await newUser('host');
    const visitor = await newUser('visitor');
    const privateRoom = await createRoom(host, true);
    const publicRoom = await createRoom(host, false);
    const visitorSocket = await connect(visitor);
    const hostSocket = await connect(host);
    await eventually(() => requireHarness().runtime.presence.isUserOnline(host.userId));

    expect(await knock(visitorSocket, '0199a000-0000-7000-8000-000000000000')).toMatchObject({
      error: { code: 'ROOM_NOT_FOUND' },
    });
    expect(await knock(visitorSocket, publicRoom)).toMatchObject({
      error: { code: 'NOT_PRIVATE' },
    });
    expect(await knock(hostSocket, privateRoom)).toMatchObject({
      error: { code: 'ALREADY_MEMBER' },
    });
    expect(await emitWithAck<Answer>(visitorSocket, 'room:knock', { roomId: 1 })).toMatchObject({
      error: { code: 'VALIDATION_FAILED' },
    });
  });

  it('needs the host to be online', async () => {
    const host = await newUser('host');
    const visitor = await newUser('visitor');
    const roomId = await createRoom(host, true);
    const visitorSocket = await connect(visitor);

    expect(await knock(visitorSocket, roomId)).toMatchObject({ error: { code: 'HOST_OFFLINE' } });
    expect(await requireHarness().redis.zcard(redisKeys.roomKnocks(roomId))).toBe(0);
  });

  it('tells the host, refreshes a repeated knock and lets the requester cancel', async () => {
    const host = await newUser('host');
    const visitor = await newUser('visitor');
    const roomId = await createRoom(host, true);
    const hostSocket = await connect(host, requireSecond());
    const visitorSocket = await connect(visitor);
    await eventually(() => requireHarness().runtime.presence.isUserOnline(host.userId));
    const received = recordEvents(hostSocket, 'room:knock:received');
    const removed = recordEvents(hostSocket, 'room:knock:removed');

    const first = await knock(visitorSocket, roomId);
    expect(first).toMatchObject({ ok: true });
    await eventually(() => received.length === 1);
    const event = roomKnockReceivedEventSchema.parse(received[0]);
    expect(event.requester.userId).toBe(visitor.userId);
    expect(event.expiresAtMs).toBe(first.expiresAtMs);
    expect(Number(first.expiresAtMs) - Date.now()).toBeLessThanOrEqual(1_600);

    await sleep(50);
    const again = await knock(visitorSocket, roomId);
    expect(Number(again.expiresAtMs)).toBeGreaterThan(Number(first.expiresAtMs));
    expect(await requireHarness().redis.zcard(redisKeys.roomKnocks(roomId))).toBe(1);

    expect(await emitWithAck<Answer>(visitorSocket, 'room:knock:cancel', { roomId })).toEqual({
      ok: true,
    });
    await eventually(() => removed.length === 1);
    expect(removed[0]).toEqual({ roomId, userId: visitor.userId, reason: 'cancelled' });
    expect(await emitWithAck<Answer>(visitorSocket, 'room:knock:cancel', { roomId })).toEqual({
      ok: true,
    });
    await sleep(200);
    expect(removed).toHaveLength(1);
  });

  it('lets a knock expire without announcing it', async () => {
    const host = await newUser('host');
    const visitor = await newUser('visitor');
    const roomId = await createRoom(host, true);
    const hostSocket = await connect(host);
    const visitorSocket = await connect(visitor);
    await eventually(() => requireHarness().runtime.presence.isUserOnline(host.userId));
    const removed = recordEvents(hostSocket, 'room:knock:removed');
    await knock(visitorSocket, roomId);

    await sleep(1_800);

    const snapshot = roomSnapshotSchema.parse((await joinOk(hostSocket, roomId)).snapshot);
    expect(snapshot.pendingKnocks).toEqual([]);
    expect(removed).toEqual([]);
    expect(await requireHarness().redis.zcard(redisKeys.roomKnocks(roomId))).toBe(0);
  });

  it('answers approval to the requester only, and the host alone can approve', async () => {
    const host = await newUser('host');
    const visitor = await newUser('visitor');
    const bystander = await newUser('bystander');
    const roomId = await createRoom(host, true);
    const hostSocket = await connect(host);
    const visitorSocket = await connect(visitor);
    const bystanderSocket = await connect(bystander);
    await eventually(() => requireHarness().runtime.presence.isUserOnline(host.userId));
    const resolved = recordEvents(visitorSocket, 'room:knock:resolved');
    const bystanderEvents = recordEvents(bystanderSocket, 'room:knock:resolved');
    const removed = recordEvents(hostSocket, 'room:knock:removed');
    await knock(visitorSocket, roomId);
    await knock(bystanderSocket, roomId);

    const approvePath = (user: TestUser) => `/rooms/${roomId}/knocks/${user.userId}/approve`;
    const stranger = await rest(bystander, 'POST', approvePath(visitor));
    expect(stranger.status).toBe(404);
    expect((stranger.json as { error: { code: string } }).error.code).toBe('ROOM_NOT_FOUND');
    expect(await emitWithAck<Answer>(visitorSocket, 'room:join', { roomId })).toMatchObject({
      error: { code: 'NOT_A_MEMBER' },
    });
    expect(resolved).toEqual([]);

    expect((await rest(host, 'POST', approvePath(visitor))).status).toBeLessThan(300);
    await eventually(() => resolved.length === 1 && removed.length >= 1);
    expect(resolved[0]).toEqual({ roomId, outcome: 'approved' });
    expect(removed[0]).toEqual({ roomId, userId: visitor.userId, reason: 'approved' });
    expect(bystanderEvents).toEqual([]);
    await joinOk(visitorSocket, roomId);

    // Rejecting the other knock.
    const rejectPath = `/rooms/${roomId}/knocks/${bystander.userId}/reject`;
    expect((await rest(host, 'POST', rejectPath)).status).toBeLessThan(300);
    await eventually(() => bystanderEvents.length === 1);
    expect(bystanderEvents[0]).toEqual({ roomId, outcome: 'rejected' });
    expect(resolved).toHaveLength(1);
  });

  it('limits knocks to five a minute per person', async () => {
    const host = await newUser('host');
    const visitor = await newUser('visitor');
    const roomId = await createRoom(host, true);
    await connect(host);
    const visitorSocket = await connect(visitor);
    await eventually(() => requireHarness().runtime.presence.isUserOnline(host.userId));

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await knock(visitorSocket, roomId)).toMatchObject({ ok: true });
    }
    expect(await knock(visitorSocket, roomId)).toMatchObject({ error: { code: 'RATE_LIMITED' } });
  });
});

describe('chat', () => {
  const send = (socket: Socket, roomId: string, body: string, clientMessageId?: string) =>
    emitWithAck<Answer>(socket, 'room:chat:send', {
      roomId,
      clientMessageId: clientMessageId ?? crypto.randomUUID(),
      body,
    });

  it('reaches every joined socket, the sender included, and nobody else', async () => {
    const host = await newUser('host');
    const guest = await newUser('guest');
    const outsider = await newUser('outsider');
    const roomId = await createRoom(host);
    const otherRoom = await createRoom(outsider);
    await joinMembership(guest, roomId);
    await joinMembership(outsider, roomId);
    const hostSocket = await connect(host);
    const guestSocket = await connect(guest, requireSecond());
    const notJoined = await connect(outsider);
    const elsewhere = await connect(outsider);
    await joinOk(hostSocket, roomId);
    await joinOk(guestSocket, roomId);
    await joinOk(elsewhere, otherRoom);
    const heard = [hostSocket, guestSocket, notJoined, elsewhere].map((socket) =>
      recordEvents(socket, 'room:chat:message'),
    );

    const answer = await send(guestSocket, roomId, '  hello room  ');

    expect(answer).toMatchObject({ ok: true });
    await eventually(() => heard[0]?.length === 1 && heard[1]?.length === 1);
    await sleep(300);
    const message = roomChatMessageEventSchema.parse(heard[0]?.[0]);
    expect(message).toMatchObject({
      roomId,
      body: 'hello room',
      messageId: answer.messageId,
      sentAtMs: answer.sentAtMs,
      sender: { userId: guest.userId },
    });
    expect(heard[1]?.[0]).toEqual(message);
    expect(heard[2]).toEqual([]);
    expect(heard[3]).toEqual([]);
  });

  it('answers a retry with the original ids and delivers it once', async () => {
    const host = await newUser('host');
    const roomId = await createRoom(host);
    const hostSocket = await connect(host);
    await joinOk(hostSocket, roomId);
    const heard = recordEvents(hostSocket, 'room:chat:message');
    const clientMessageId = crypto.randomUUID();

    const first = await send(hostSocket, roomId, 'once', clientMessageId);
    const retry = await send(hostSocket, roomId, 'once', clientMessageId);

    expect(retry).toEqual(first);
    await sleep(300);
    expect(heard).toHaveLength(1);
  });

  it('rejects bad messages and senders outside the room', async () => {
    const host = await newUser('host');
    const outsider = await newUser('outsider');
    const roomId = await createRoom(host);
    await joinMembership(outsider, roomId);
    const hostSocket = await connect(host);
    const outsiderSocket = await connect(outsider);
    await joinOk(hostSocket, roomId);
    const heard = recordEvents(hostSocket, 'room:chat:message');

    for (const body of ['', '   ', 'x'.repeat(1_001)]) {
      expect(await send(hostSocket, roomId, body)).toMatchObject({
        error: { code: 'VALIDATION_FAILED' },
      });
    }
    expect(
      await emitWithAck<Answer>(hostSocket, 'room:chat:send', {
        roomId,
        clientMessageId: 'not-a-uuid',
        body: 'hi',
      }),
    ).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    expect(await send(hostSocket, roomId, 'x'.repeat(1_000))).toMatchObject({ ok: true });
    expect(await send(outsiderSocket, roomId, 'let me in')).toMatchObject({
      error: { code: 'NOT_JOINED' },
    });
    await eventually(() => heard.length === 1);
  });

  it('limits a person to ten messages in ten seconds', async () => {
    const host = await newUser('host');
    const roomId = await createRoom(host);
    const hostSocket = await connect(host);
    await joinOk(hostSocket, roomId);

    for (let count = 0; count < 10; count += 1) {
      expect(await send(hostSocket, roomId, `message ${String(count)}`)).toMatchObject({
        ok: true,
      });
    }
    expect(await send(hostSocket, roomId, 'one too many')).toMatchObject({
      error: { code: 'RATE_LIMITED' },
    });
  });
});

describe('membership changes', () => {
  const send = (socket: Socket, roomId: string, body: string) =>
    emitWithAck<Answer>(socket, 'room:chat:send', {
      roomId,
      clientMessageId: crypto.randomUUID(),
      body,
    });

  it('announces new members and settings to the room', async () => {
    const host = await newUser('host');
    const guest = await newUser('guest');
    const roomId = await createRoom(host);
    const hostSocket = await connect(host);
    await joinOk(hostSocket, roomId);
    const joined = recordEvents<{ roomId: string; member: { userId: string } }>(
      hostSocket,
      'room:member:joined',
    );
    const settings = recordEvents(hostSocket, 'room:settings:updated');

    await joinMembership(guest, roomId);
    await rest(host, 'PATCH', `/rooms/${roomId}/timer-settings`, { focusSeconds: 1800 });

    await eventually(() => joined.length === 1 && settings.length === 1);
    expect(joined[0]?.member.userId).toBe(guest.userId);
    expect(settings[0]).toMatchObject({
      roomId,
      effectiveFrom: 'next_phase',
      timerSettings: { focusSeconds: 1800 },
    });
  });

  it('evicts a removed member from the room and tells everyone', async () => {
    const host = await newUser('host');
    const guest = await newUser('guest');
    const roomId = await createRoom(host);
    await joinMembership(guest, roomId);
    const hostSocket = await connect(host);
    const guestTabs = [await connect(guest), await connect(guest, requireSecond())];
    await joinOk(hostSocket, roomId);
    for (const tab of guestTabs) {
      await joinOk(tab, roomId);
    }
    const hostRemoved = recordEvents(hostSocket, 'room:member:removed');
    const hostDepartures = recordEvents<LeftPayload>(hostSocket, 'room:presence:left');
    const tabRemoved = guestTabs.map((tab) => recordEvents(tab, 'room:member:removed'));
    const tabChat = guestTabs.map((tab) => recordEvents(tab, 'room:chat:message'));

    expect((await rest(host, 'DELETE', `/rooms/${roomId}/members/${guest.userId}`)).status).toBe(
      204,
    );

    await eventually(
      () =>
        hostRemoved.length === 1 &&
        hostDepartures.length === 1 &&
        tabRemoved.every((events) => events.length === 1),
    );
    expect(hostRemoved[0]).toEqual({ roomId, userId: guest.userId, reason: 'removed' });
    expect(tabRemoved[0]?.[0]).toEqual({ roomId, userId: guest.userId, reason: 'removed' });
    expect(await redisEntries(roomId, guest.userId)).toEqual([]);

    // Out of the room: no more messages, and sending is refused. The host's send is the
    // positive control (accepted and received) before the bounded negative wait.
    const hostHeard = recordEvents(hostSocket, 'room:chat:message');
    expect(await send(hostSocket, roomId, 'after removal')).toMatchObject({ ok: true });
    await eventually(() => hostHeard.length === 1);
    await sleep(200);
    expect(tabChat.every((events) => events.length === 0)).toBe(true);
    expect(await send(guestTabs[0] as Socket, roomId, 'hello?')).toMatchObject({
      error: { code: 'NOT_JOINED' },
    });
    expect(await join(guestTabs[0] as Socket, roomId)).toMatchObject({
      error: { code: 'NOT_A_MEMBER' },
    });
  });

  it('removes a member who leaves the membership', async () => {
    const host = await newUser('host');
    const guest = await newUser('guest');
    const roomId = await createRoom(host);
    await joinMembership(guest, roomId);
    const hostSocket = await connect(host);
    const guestSocket = await connect(guest);
    await joinOk(hostSocket, roomId);
    await joinOk(guestSocket, roomId);
    const removed = recordEvents(hostSocket, 'room:member:removed');
    const own = recordEvents(guestSocket, 'room:member:removed');

    expect((await rest(guest, 'DELETE', `/rooms/${roomId}/membership`)).status).toBe(204);

    await eventually(() => removed.length === 1 && own.length === 1);
    expect(removed[0]).toEqual({ roomId, userId: guest.userId, reason: 'left' });
    expect(await redisEntries(roomId, guest.userId)).toEqual([]);
  });
});

describe('races', () => {
  it('announces a person once when several sockets join at the same moment', async () => {
    const host = await newUser('host');
    const guest = await newUser('guest');
    const roomId = await createRoom(host);
    await joinMembership(guest, roomId);
    const hostSocket = await connect(host);
    await joinOk(hostSocket, roomId);
    const arrivals = recordEvents<PresentPayload>(hostSocket, 'room:presence:joined');
    const tabs = await Promise.all([
      connect(guest),
      connect(guest, requireSecond()),
      connect(guest),
      connect(guest, requireSecond()),
    ]);

    const answers = await Promise.all(tabs.map((tab) => join(tab, roomId)));

    expect(answers.every((answer) => answer.ok)).toBe(true);
    await sleep(500);
    expect(arrivals).toHaveLength(1);
    expect(await redisEntries(roomId, guest.userId)).toHaveLength(4);
  });

  it('leaves nothing behind when a join races the removal', async () => {
    const host = await newUser('host');
    const roomId = await createRoom(host);
    for (let round = 0; round < 4; round += 1) {
      const guest = await newUser('guest');
      await joinMembership(guest, roomId);
      const guestSocket = await connect(guest);

      const [answer] = await Promise.all([
        join(guestSocket, roomId),
        rest(host, 'DELETE', `/rooms/${roomId}/members/${guest.userId}`),
      ]);

      expect(['NOT_A_MEMBER', undefined]).toContain(answer.error?.code);
      await eventually(async () => (await redisEntries(roomId, guest.userId)).length === 0);
      const present = await requireHarness().redis.hexists(
        redisKeys.roomPresence(roomId),
        guest.userId,
      );
      expect(present).toBe(0);
    }
  });

  it('announces one departure when a leave races the disconnect', async () => {
    const host = await newUser('host');
    const guest = await newUser('guest');
    const roomId = await createRoom(host);
    await joinMembership(guest, roomId);
    const hostSocket = await connect(host);
    const guestSocket = await connect(guest);
    await joinOk(hostSocket, roomId);
    await joinOk(guestSocket, roomId);
    const departures = recordEvents<LeftPayload>(hostSocket, 'room:presence:left');

    guestSocket.emit('room:leave', { roomId });
    guestSocket.disconnect();

    await eventually(() => departures.length >= 1);
    await sleep(700);
    expect(departures).toHaveLength(1);
    expect(await redisEntries(roomId, guest.userId)).toEqual([]);
  });
});
