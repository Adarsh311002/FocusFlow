import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { startInstance } from '../../../test/harness.js';
import { closeAllSockets, emitWithAck, eventually, recordEvents } from '../../../test/sockets.js';
import { startTcpProxy } from '../../../test/tcp-proxy.js';
import type { TestUser } from '../../../test/users.js';
import { roomMembers } from '../../db/schema.js';
import { redisTimeMs } from '../../platform/redis.js';
import { redisKeys } from '../../platform/redis-keys.js';
import { type Answer, codeOf, createRoomKit, ROOM_TIMINGS, sleep } from './room-test-kit.js';

// Knocks over real sockets, REST and Redis (M7, T1): expiry without anyone reading the
// set, every way a knock can already be gone when the host approves, and Redis outages.

const kit = createRoomKit();

beforeAll(async () => {
  await kit.start();
}, 180_000);

afterEach(() => {
  closeAllSockets();
});

afterAll(async () => {
  await kit.stop();
}, 60_000);

const approve = (host: TestUser, roomId: string, visitor: TestUser, baseUrl?: string) =>
  kit.rest(host, 'POST', `/rooms/${roomId}/knocks/${visitor.userId}/approve`, undefined, baseUrl);

const memberRows = async (roomId: string, userId: string) =>
  kit
    .harness()
    .db.select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)));

/** Waits until Redis TIME has passed `instantMs` (no join or list may run meanwhile). */
const waitUntilRedisPast = (instantMs: number) =>
  eventually(async () => (await redisTimeMs(kit.harness().redis)) > instantMs, 10_000);

/** A private room whose host is online (a knock needs that), and a visitor with a socket. */
const knockSetup = async () => {
  const host = await kit.newUser('host');
  const visitor = await kit.newUser('visitor');
  const roomId = await kit.createRoom(host, true);
  const hostSocket = await kit.connect(host);
  const visitorSocket = await kit.connect(visitor);
  await eventually(() => kit.harness().runtime.presence.isUserOnline(host.userId));
  return { host, visitor, roomId, hostSocket, visitorSocket };
};

describe('approving a knock that is already gone (T1)', () => {
  it('answers KNOCK_EXPIRED once the knock expired, although nobody joined or listed meanwhile', async () => {
    const { host, visitor, roomId, visitorSocket } = await knockSetup();
    const first = await kit.knock(visitorSocket, roomId);
    expect(first).toMatchObject({ ok: true });

    await waitUntilRedisPast(Number(first.expiresAtMs));
    // Nothing reads or prunes the set meanwhile; the whole key may already have expired.
    const result = await approve(host, roomId, visitor);

    expect(result.status).toBe(410);
    expect(codeOf(result.json)).toBe('KNOCK_EXPIRED');
    expect(await memberRows(roomId, visitor.userId)).toEqual([]);
  });

  it('answers KNOCK_EXPIRED after the requester cancelled', async () => {
    const { host, visitor, roomId, visitorSocket } = await knockSetup();
    await kit.knock(visitorSocket, roomId);
    expect(await emitWithAck<Answer>(visitorSocket, 'room:knock:cancel', { roomId })).toEqual({
      ok: true,
    });

    const result = await approve(host, roomId, visitor);

    expect(result.status).toBe(410);
    expect(codeOf(result.json)).toBe('KNOCK_EXPIRED');
    expect(await memberRows(roomId, visitor.userId)).toEqual([]);
  });

  it('answers KNOCK_EXPIRED after the host rejected', async () => {
    const { host, visitor, roomId, visitorSocket } = await knockSetup();
    await kit.knock(visitorSocket, roomId);
    expect(
      (await kit.rest(host, 'POST', `/rooms/${roomId}/knocks/${visitor.userId}/reject`)).status,
    ).toBeLessThan(300);

    const result = await approve(host, roomId, visitor);

    expect(result.status).toBe(410);
    expect(codeOf(result.json)).toBe('KNOCK_EXPIRED');
    expect(await memberRows(roomId, visitor.userId)).toEqual([]);
  });

  it('approves a knock that was refreshed just before the first one would have expired', async () => {
    const { host, visitor, roomId, visitorSocket } = await knockSetup();
    const first = await kit.knock(visitorSocket, roomId);
    await waitUntilRedisPast(Number(first.expiresAtMs) - 500);
    const refreshed = await kit.knock(visitorSocket, roomId);
    expect(Number(refreshed.expiresAtMs)).toBeGreaterThan(Number(first.expiresAtMs));
    // Past the first expiry, before the second.
    await waitUntilRedisPast(Number(first.expiresAtMs) + 10);

    const result = await approve(host, roomId, visitor);

    expect(result.status).toBe(201);
    expect(await memberRows(roomId, visitor.userId)).toHaveLength(1);
  });

  it('answers 503 when the knock state cannot be read, and changes nothing', async () => {
    const h = kit.harness();
    const redisProxy = await startTcpProxy(h.redisContainer.getHost(), h.redisContainer.getPort());
    const isolated = await startInstance(h, {
      ...ROOM_TIMINGS,
      REDIS_URL: `redis://127.0.0.1:${String(redisProxy.port)}`,
    });
    try {
      const { host, visitor, roomId, visitorSocket } = await knockSetup();
      expect(await kit.knock(visitorSocket, roomId)).toMatchObject({ ok: true });

      await redisProxy.cut();
      const result = await approve(host, roomId, visitor, isolated.baseUrl);

      expect(result.status).toBe(503);
      expect(await memberRows(roomId, visitor.userId)).toEqual([]);
      // The knock is still pending for a healthy instance: a retry succeeds.
      expect((await approve(host, roomId, visitor)).status).toBe(201);
    } finally {
      await redisProxy.close();
      await isolated.runtime.stop().catch(() => undefined);
      h.extraInstances.splice(h.extraInstances.indexOf(isolated), 1);
    }
  });
});

describe('knock events', () => {
  it('reaches the host and no other member of the room', async () => {
    const { host, roomId, hostSocket, visitorSocket } = await knockSetup();
    // A second member of the private room, admitted by a knock of their own.
    const member = await kit.newUser('member');
    const memberSocket = await kit.connect(member);
    await kit.knock(memberSocket, roomId);
    expect((await approve(host, roomId, member)).status).toBe(201);
    await kit.joinOk(memberSocket, roomId);
    const received = recordEvents(hostSocket, 'room:knock:received');
    const heardByMember = recordEvents(memberSocket, 'room:knock:received');
    const heardByVisitor = recordEvents(visitorSocket, 'room:knock:received');

    await kit.knock(visitorSocket, roomId);
    await eventually(() => received.length === 1);
    await sleep(200);

    expect(heardByMember).toEqual([]);
    expect(heardByVisitor).toEqual([]);
  });

  it('tells the room about the approved member and the requester the outcome', async () => {
    const { host, visitor, roomId, hostSocket, visitorSocket } = await knockSetup();
    await kit.joinOk(hostSocket, roomId);
    const joined = recordEvents<{ roomId: string; member: { userId: string } }>(
      hostSocket,
      'room:member:joined',
    );
    const resolved = recordEvents(visitorSocket, 'room:knock:resolved');
    await kit.knock(visitorSocket, roomId);

    expect((await approve(host, roomId, visitor)).status).toBe(201);

    await eventually(() => joined.length === 1 && resolved.length === 1);
    expect(joined[0]).toMatchObject({ roomId, member: { userId: visitor.userId } });
    expect(resolved[0]).toEqual({ roomId, outcome: 'approved' });
  });

  it('tells the host the knock was rejected', async () => {
    const { host, visitor, roomId, hostSocket, visitorSocket } = await knockSetup();
    const removed = recordEvents(hostSocket, 'room:knock:removed');
    await kit.knock(visitorSocket, roomId);

    expect(
      (await kit.rest(host, 'POST', `/rooms/${roomId}/knocks/${visitor.userId}/reject`)).status,
    ).toBeLessThan(300);

    await eventually(() => removed.length === 1);
    expect(removed[0]).toEqual({ roomId, userId: visitor.userId, reason: 'rejected' });
  });

  it('answers a stranger who tries to approve with 404 ROOM_NOT_FOUND', async () => {
    const { visitor, roomId, visitorSocket } = await knockSetup();
    const stranger = await kit.newUser('stranger');
    await kit.knock(visitorSocket, roomId);

    const result = await approve(stranger, roomId, visitor);

    expect(result.status).toBe(404);
    expect(codeOf(result.json)).toBe('ROOM_NOT_FOUND');
  });
});

describe('knock rate limits and cancelling', () => {
  it('reports the rate limit before it looks the room up', async () => {
    const visitor = await kit.newUser('visitor');
    const socket = await kit.connect(visitor);
    const missing = '0199a000-0000-7000-8000-000000000000';

    expect(await kit.knock(socket, missing)).toMatchObject({ error: { code: 'ROOM_NOT_FOUND' } });
    for (let attempt = 1; attempt < 5; attempt += 1) {
      expect(await kit.knock(socket, missing)).toMatchObject({ error: { code: 'ROOM_NOT_FOUND' } });
    }
    expect(await kit.knock(socket, missing)).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    const ttl = await kit.harness().redis.pttl(redisKeys.rateLimit('knock', visitor.userId));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
  });

  it('limits knock cancellations to ten a minute per person', async () => {
    const { roomId, visitorSocket } = await knockSetup();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(
        await emitWithAck<Answer>(visitorSocket, 'room:knock:cancel', { roomId }),
      ).toMatchObject({ ok: true });
    }
    expect(await emitWithAck<Answer>(visitorSocket, 'room:knock:cancel', { roomId })).toMatchObject(
      { error: { code: 'RATE_LIMITED' } },
    );
  });

  it('answers ROOM_NOT_FOUND for a missing room and cancels nothing of somebody else’s', async () => {
    const { host, visitor, roomId, hostSocket, visitorSocket } = await knockSetup();
    const bystander = await kit.newUser('bystander');
    const bystanderSocket = await kit.connect(bystander);
    const removed = recordEvents(hostSocket, 'room:knock:removed');
    await kit.knock(visitorSocket, roomId);

    expect(
      await emitWithAck<Answer>(bystanderSocket, 'room:knock:cancel', {
        roomId: '0199a000-0000-7000-8000-000000000000',
      }),
    ).toMatchObject({ error: { code: 'ROOM_NOT_FOUND' } });
    // A cancel by someone who never knocked is a no-op: nothing is announced and the
    // visitor's knock is intact (the host can still approve it).
    expect(await emitWithAck<Answer>(bystanderSocket, 'room:knock:cancel', { roomId })).toEqual({
      ok: true,
    });
    await sleep(200);
    expect(removed).toEqual([]);
    expect((await approve(host, roomId, visitor)).status).toBe(201);
  });
});
