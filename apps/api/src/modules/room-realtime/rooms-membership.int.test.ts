import { roomSnapshotSchema } from '@focus-flow/contracts';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { startInstance } from '../../../test/harness.js';
import { closeAllSockets, eventually, recordEvents } from '../../../test/sockets.js';
import { roomMembers } from '../../db/schema.js';
import { redisKeys } from '../../platform/redis-keys.js';
import {
  type Answer,
  createGate,
  createRoomKit,
  type LeftPayload,
  type PresentPayload,
  ROOM_TIMINGS,
  sleep,
} from './room-test-kit.js';

// Joining and leaving a room under pressure: the presence cap (F5), the join-versus-
// removal interleavings (T3), the join rate limit (F6) and the backstop for a lost
// eviction (F1). Seams are the room presence object of the runtime and the PostgreSQL row.

const kit = createRoomKit();

beforeAll(async () => {
  await kit.start();
}, 180_000);

afterEach(() => {
  vi.restoreAllMocks();
  closeAllSockets();
});

afterAll(async () => {
  await kit.stop();
}, 60_000);

const deleteMembershipRow = async (roomId: string, userId: string): Promise<void> => {
  await kit
    .harness()
    .db.delete(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)));
};

describe('the presence cap (F5)', () => {
  it('lets exactly one of two concurrent new people into the last seat', async () => {
    const host = await kit.newUser('host');
    const [a, b, c] = await Promise.all([kit.newUser('a'), kit.newUser('b'), kit.newUser('c')]);
    const roomId = await kit.createRoom(host);
    for (const person of [a, b, c]) {
      await kit.joinMembership(person, roomId);
    }
    await kit.joinOk(await kit.connect(host), roomId);
    await kit.joinOk(await kit.connect(a), roomId);
    const bSocket = await kit.connect(b, kit.second());
    const cSocket = await kit.connect(c);

    const answers = await Promise.all([kit.join(bSocket, roomId), kit.join(cSocket, roomId)]);

    expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
    expect(answers.filter((answer) => answer.error?.code === 'ROOM_FULL')).toHaveLength(1);
    expect(await kit.presenceHashSize(roomId)).toBe(3);
    const present = await kit.harness().runtime.roomRealtime.presence.present([roomId]);
    expect(present.get(roomId)).toHaveLength(3);

    // A seat that frees up is available again, to the person who was refused.
    const [refused, refusedSocket] = answers[0].ok ? [c, cSocket] : [b, bSocket];
    expect((await kit.rest(a, 'DELETE', `/rooms/${roomId}/membership`)).status).toBe(204);
    await eventually(async () => (await kit.presenceHashSize(roomId)) === 2);
    expect(refused.userId).toBeDefined();
    await kit.joinOk(refusedSocket, roomId);
    expect(await kit.presenceHashSize(roomId)).toBe(3);
  });

  it('never refuses a person who is already present, and leaves no entry for a refused one', async () => {
    const host = await kit.newUser('host');
    const a = await kit.newUser('a');
    const b = await kit.newUser('b');
    const late = await kit.newUser('late');
    const roomId = await kit.createRoom(host);
    for (const person of [a, b, late]) {
      await kit.joinMembership(person, roomId);
    }
    await kit.joinOk(await kit.connect(host), roomId);
    await kit.joinOk(await kit.connect(a), roomId);
    await kit.joinOk(await kit.connect(b), roomId);

    expect(await kit.join(await kit.connect(late), roomId)).toMatchObject({
      error: { code: 'ROOM_FULL' },
    });
    expect(await kit.redisEntries(roomId, late.userId)).toEqual([]);
    expect(await kit.presenceHashSize(roomId)).toBe(3);
    // A second tab of someone present is not a new person.
    await kit.joinOk(await kit.connect(a, kit.second()), roomId);
  });

  it('does not count the people of a dead instance', async () => {
    const h = kit.harness();
    const doomed = await startInstance(h, ROOM_TIMINGS);
    try {
      const host = await kit.newUser('host');
      const stranded = await kit.newUser('stranded');
      const x = await kit.newUser('x');
      const y = await kit.newUser('y');
      const roomId = await kit.createRoom(host);
      for (const person of [stranded, x, y]) {
        await kit.joinMembership(person, roomId);
      }
      await kit.joinOk(await kit.connect(host), roomId);
      await kit.joinOk(await kit.connect(stranded, doomed), roomId);
      await kit.joinOk(await kit.connect(x), roomId);
      const ySocket = await kit.connect(y);
      expect(await kit.join(ySocket, roomId)).toMatchObject({ error: { code: 'ROOM_FULL' } });

      // A crash: the instance loses Redis without cleaning anything up.
      doomed.runtime.redis.disconnect();

      // Retries are spaced out: joining is rate limited (F6).
      let answer: Answer = { ok: false };
      await eventually(async () => {
        answer = await kit.join(ySocket, roomId);
        if (!answer.ok) {
          await sleep(400);
        }
        return answer.ok;
      }, 12_000);
      expect(answer.ok).toBe(true);
    } finally {
      await doomed.runtime.stop().catch(() => undefined);
      h.extraInstances.splice(h.extraInstances.indexOf(doomed), 1);
    }
  });
});

describe('joining while the membership ends (T3)', () => {
  it('rolls back a join that the removal overtakes', async () => {
    const h = kit.harness();
    const presence = h.runtime.roomRealtime.presence;
    const original = presence.join.bind(presence);
    const gate = createGate();
    const host = await kit.newUser('host');
    const guest = await kit.newUser('guest');
    const roomId = await kit.createRoom(host);
    await kit.joinMembership(guest, roomId);
    const hostSocket = await kit.connect(host);
    await kit.joinOk(hostSocket, roomId);
    const arrivals = recordEvents<PresentPayload>(hostSocket, 'room:presence:joined');
    const departures = recordEvents<LeftPayload>(hostSocket, 'room:presence:left');
    const hostHeard = recordEvents(hostSocket, 'room:chat:message');
    const guestSocket = await kit.connect(guest);
    const guestHeard = recordEvents(guestSocket, 'room:chat:message');
    vi.spyOn(presence, 'join').mockImplementationOnce(async (...args) => {
      await gate.wait();
      return original(...args);
    });

    const pending = kit.join(guestSocket, roomId);
    await gate.arrival;
    // The membership check has passed; the removal now commits and finishes its eviction.
    const removal = await kit.rest(host, 'DELETE', `/rooms/${roomId}/members/${guest.userId}`);
    expect(removal.status).toBe(204);
    gate.open();
    const answer = await pending;

    expect(answer).toMatchObject({ ok: false, error: { code: 'NOT_A_MEMBER' } });
    await eventually(async () => (await kit.redisEntries(roomId, guest.userId)).length === 0);
    expect(await h.redis.hexists(redisKeys.roomPresence(roomId), guest.userId)).toBe(0);
    // Out of the room: the host's message reaches the host (control) and not the guest.
    expect(await kit.send(hostSocket, roomId, 'anyone there?')).toMatchObject({ ok: true });
    await eventually(() => hostHeard.length === 1);
    await sleep(200);
    expect(guestHeard).toEqual([]);
    // No net announcement: whatever was announced was withdrawn.
    await eventually(() => arrivals.length === departures.length);
  });

  it('rolls back a join whose socket disconnects midway', async () => {
    const h = kit.harness();
    const presence = h.runtime.roomRealtime.presence;
    const original = presence.join.bind(presence);
    const gate = createGate();
    const host = await kit.newUser('host');
    const guest = await kit.newUser('guest');
    const roomId = await kit.createRoom(host);
    await kit.joinMembership(guest, roomId);
    const hostSocket = await kit.connect(host);
    await kit.joinOk(hostSocket, roomId);
    const arrivals = recordEvents<PresentPayload>(hostSocket, 'room:presence:joined');
    const departures = recordEvents<LeftPayload>(hostSocket, 'room:presence:left');
    const guestSocket = await kit.connect(guest);
    vi.spyOn(presence, 'join').mockImplementationOnce(async (...args) => {
      await gate.wait();
      return original(...args);
    });

    void kit.join(guestSocket, roomId).catch(() => undefined);
    await gate.arrival;
    const serverSocketId = String(guestSocket.id);
    guestSocket.disconnect();
    await eventually(() => !h.runtime.io.of('/').sockets.has(serverSocketId));
    gate.open();

    await eventually(async () => (await kit.redisEntries(roomId, guest.userId)).length === 0);
    await eventually(
      async () => (await h.redis.hexists(redisKeys.roomPresence(roomId), guest.userId)) === 0,
    );
    await eventually(() => arrivals.length === departures.length);
  });

  it('answers INTERNAL and undoes the join when presence cannot be recorded', async () => {
    const h = kit.harness();
    const presence = h.runtime.roomRealtime.presence;
    const host = await kit.newUser('host');
    const guest = await kit.newUser('guest');
    const roomId = await kit.createRoom(host);
    await kit.joinMembership(guest, roomId);
    const hostSocket = await kit.connect(host);
    await kit.joinOk(hostSocket, roomId);
    const hostHeard = recordEvents(hostSocket, 'room:chat:message');
    const guestSocket = await kit.connect(guest);
    const guestHeard = recordEvents(guestSocket, 'room:chat:message');
    vi.spyOn(presence, 'join').mockRejectedValueOnce(new Error('redis went away'));

    expect(await kit.join(guestSocket, roomId)).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL' },
    });

    expect(await kit.redisEntries(roomId, guest.userId)).toEqual([]);
    expect(h.runtime.io.of('/').sockets.size).toBeGreaterThan(0);
    expect(await kit.send(hostSocket, roomId, 'hello')).toMatchObject({ ok: true });
    await eventually(() => hostHeard.length === 1);
    await sleep(200);
    expect(guestHeard).toEqual([]);
    // The socket is not stuck half-joined: a retry works.
    await kit.joinOk(guestSocket, roomId);
  });

  it('shows the joiner a person who arrives while the snapshot is read, as an event', async () => {
    const h = kit.harness();
    const presence = h.runtime.roomRealtime.presence;
    const original = presence.present.bind(presence);
    const gate = createGate();
    const host = await kit.newUser('host');
    const first = await kit.newUser('first');
    const third = await kit.newUser('third');
    const roomId = await kit.createRoom(host);
    await kit.joinMembership(first, roomId);
    await kit.joinMembership(third, roomId);
    const firstSocket = await kit.connect(first);
    const arrivals = recordEvents<PresentPayload>(firstSocket, 'room:presence:joined');
    const thirdSocket = await kit.connect(third);
    // The join reads presence twice (the cap check, then the snapshot): hold the second
    // read after it has produced its answer. Gate only the first socket's join.
    let reads = 0;
    let armed = true;
    vi.spyOn(presence, 'present').mockImplementation(async (roomIds) => {
      if (!armed) {
        return original(roomIds);
      }
      reads += 1;
      const result = await original(roomIds);
      if (reads === 2) {
        armed = false;
        await gate.wait();
      }
      return result;
    });

    const pending = kit.join(firstSocket, roomId);
    await gate.arrival;
    await kit.joinOk(thirdSocket, roomId);
    gate.open();
    const answer = await pending;

    expect(answer.ok).toBe(true);
    const snapshot = roomSnapshotSchema.parse(answer.snapshot);
    // The read predates the third person, so the snapshot cannot show them; the event must.
    expect(snapshot.presence.some((user) => user.userId === third.userId)).toBe(false);
    await eventually(() => arrivals.some((event) => event.user.userId === third.userId));
  });
});

describe('rate limits (F6)', () => {
  it('limits room:join to 30 per 10 seconds per person', async () => {
    const host = await kit.newUser('host');
    const roomId = await kit.createRoom(host);
    const socket = await kit.connect(host);

    for (let attempt = 0; attempt < 30; attempt += 1) {
      expect(await kit.join(socket, roomId)).toMatchObject({ ok: true });
    }
    expect(await kit.join(socket, roomId)).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    const ttl = await kit.harness().redis.pttl(redisKeys.rateLimit('join', host.userId));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(10_000);
  });
});

describe('a lost eviction (F1)', () => {
  it('refuses chat from a removed member whose socket is still in the room', async () => {
    const h = kit.harness();
    // The heartbeat sync would repair this on its own; hold it so the chat check is alone.
    vi.spyOn(h.runtime.roomRealtime, 'syncLocal').mockResolvedValue(undefined);
    const host = await kit.newUser('host');
    const guest = await kit.newUser('guest');
    const roomId = await kit.createRoom(host);
    await kit.joinMembership(guest, roomId);
    const hostSocket = await kit.connect(host);
    const guestSocket = await kit.connect(guest);
    await kit.joinOk(hostSocket, roomId);
    await kit.joinOk(guestSocket, roomId);
    const hostHeard = recordEvents(hostSocket, 'room:chat:message');
    const departures = recordEvents<LeftPayload>(hostSocket, 'room:presence:left');

    // The membership ends in PostgreSQL but the eviction never happens.
    await deleteMembershipRow(roomId, guest.userId);

    expect(await kit.send(guestSocket, roomId, 'still here?')).toMatchObject({
      ok: false,
      error: { code: 'NOT_A_MEMBER' },
    });
    await eventually(() => departures.length === 1);
    expect(departures[0]).toEqual({ roomId, userId: guest.userId });
    expect(await kit.redisEntries(roomId, guest.userId)).toEqual([]);
    // The room never heard the refused message (control: it hears the host's).
    expect(await kit.send(hostSocket, roomId, 'only me')).toMatchObject({ ok: true });
    await eventually(() => hostHeard.length === 1);
    expect(hostHeard[0]).toMatchObject({ body: 'only me' });
  });

  it('lets the heartbeat sync drop the socket and presence of a former member', async () => {
    const h = kit.harness();
    const host = await kit.newUser('host');
    const guest = await kit.newUser('guest');
    const roomId = await kit.createRoom(host);
    await kit.joinMembership(guest, roomId);
    const hostSocket = await kit.connect(host);
    const guestSocket = await kit.connect(guest);
    await kit.joinOk(hostSocket, roomId);
    await kit.joinOk(guestSocket, roomId);
    const hostHeard = recordEvents(hostSocket, 'room:chat:message');
    const guestHeard = recordEvents(guestSocket, 'room:chat:message');
    const departures = recordEvents<LeftPayload>(hostSocket, 'room:presence:left');
    const told = recordEvents(guestSocket, 'room:member:removed');

    await deleteMembershipRow(roomId, guest.userId);

    await eventually(() => departures.length === 1, 10_000);
    expect(departures[0]).toEqual({ roomId, userId: guest.userId });
    await eventually(async () => (await kit.redisEntries(roomId, guest.userId)).length === 0);
    expect(await h.redis.hexists(redisKeys.roomPresence(roomId), guest.userId)).toBe(0);
    await eventually(() => told.length === 1);
    expect(told[0]).toEqual({ roomId, userId: guest.userId, reason: 'removed' });
    expect(await kit.send(hostSocket, roomId, 'control')).toMatchObject({ ok: true });
    await eventually(() => hostHeard.length === 1);
    await sleep(200);
    expect(guestHeard).toEqual([]);
    // Further heartbeats do not bring the socket back.
    await sleep(600);
    expect(await kit.redisEntries(roomId, guest.userId)).toEqual([]);
    expect(departures).toHaveLength(1);
  });
});
