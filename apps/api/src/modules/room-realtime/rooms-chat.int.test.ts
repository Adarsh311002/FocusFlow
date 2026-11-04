import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { closeAllSockets, eventually, recordEvents } from '../../../test/sockets.js';
import { redisKeys } from '../../platform/redis-keys.js';
import { CHAT_DEDUPE_TTL_MS } from './chat.js';
import { createRoomKit } from './room-test-kit.js';

// Room chat de-duplication and rate limiting over real sockets and Redis (M8, T4, F4).
// Delivery is checked with a sentinel: a message sent afterwards on the same path has
// arrived, so everything sent before it either arrived already or never will.

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

type Heard = { body: string; messageId: string; clientMessageId: string };

/** Sends a sentinel from `socket` and waits until `heard` holds it: all earlier traffic is in. */
const flush = async (
  socket: Parameters<typeof kit.send>[0],
  roomId: string,
  heard: Heard[],
): Promise<void> => {
  const body = `sentinel ${crypto.randomUUID()}`;
  expect(await kit.send(socket, roomId, body)).toMatchObject({ ok: true });
  await eventually(() => heard.some((message) => message.body === body));
};

const bodies = (heard: Heard[]): string[] =>
  heard.map((message) => message.body).filter((body) => !body.startsWith('sentinel '));

describe('chat de-duplication', () => {
  it('delivers concurrent sends of one client message id once, with identical ids', async () => {
    const host = await kit.newUser('host');
    const roomId = await kit.createRoom(host);
    const first = await kit.connect(host);
    const second = await kit.connect(host, kit.second());
    await kit.joinOk(first, roomId);
    await kit.joinOk(second, roomId);
    const heard = recordEvents<Heard>(first, 'room:chat:message');
    const clientMessageId = crypto.randomUUID();

    const answers = await Promise.all([
      kit.send(first, roomId, 'twice?', clientMessageId),
      kit.send(second, roomId, 'twice?', clientMessageId),
      kit.send(first, roomId, 'twice?', clientMessageId),
    ]);

    expect(answers.every((answer) => answer.ok)).toBe(true);
    expect(new Set(answers.map((answer) => answer.messageId)).size).toBe(1);
    expect(new Set(answers.map((answer) => answer.sentAtMs)).size).toBe(1);
    await flush(first, roomId, heard);
    expect(bodies(heard)).toEqual(['twice?']);
    expect(heard[0]?.messageId).toBe(answers[0].messageId);
  });

  it('treats the same client message id from another person as another message', async () => {
    const host = await kit.newUser('host');
    const guest = await kit.newUser('guest');
    const roomId = await kit.createRoom(host);
    await kit.joinMembership(guest, roomId);
    const hostSocket = await kit.connect(host);
    const guestSocket = await kit.connect(guest);
    await kit.joinOk(hostSocket, roomId);
    await kit.joinOk(guestSocket, roomId);
    const heard = recordEvents<Heard>(hostSocket, 'room:chat:message');
    const clientMessageId = crypto.randomUUID();

    const fromHost = await kit.send(hostSocket, roomId, 'from host', clientMessageId);
    const fromGuest = await kit.send(guestSocket, roomId, 'from guest', clientMessageId);

    expect(fromHost.ok && fromGuest.ok).toBe(true);
    expect(fromGuest.messageId).not.toBe(fromHost.messageId);
    await flush(hostSocket, roomId, heard);
    expect(bodies(heard)).toEqual(['from host', 'from guest']);
  });

  it('treats the same client message id in another room as another message (F4)', async () => {
    const host = await kit.newUser('host');
    const roomA = await kit.createRoom(host);
    const roomB = await kit.createRoom(host);
    const socket = await kit.connect(host);
    await kit.joinOk(socket, roomA);
    await kit.joinOk(socket, roomB);
    const heard = recordEvents<Heard & { roomId: string }>(socket, 'room:chat:message');
    const clientMessageId = crypto.randomUUID();

    const inA = await kit.send(socket, roomA, 'in A', clientMessageId);
    const inB = await kit.send(socket, roomB, 'in B', clientMessageId);

    expect(inA.ok && inB.ok).toBe(true);
    expect(inB.messageId).not.toBe(inA.messageId);
    await eventually(() => bodies(heard).length === 2);
    expect(heard.map((message) => [message.roomId, message.body])).toEqual([
      [roomA, 'in A'],
      [roomB, 'in B'],
    ]);
    const redis = kit.harness().redis;
    const ttl = await redis.pttl(redisKeys.chatDedupe(host.userId, roomA, clientMessageId));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(CHAT_DEDUPE_TTL_MS);
    expect(await redis.exists(redisKeys.chatDedupe(host.userId, roomB, clientMessageId))).toBe(1);
  });
});

describe('chat rate limit', () => {
  it('answers a retry of a delivered message with its ids even when the sender is limited', async () => {
    const host = await kit.newUser('host');
    const roomId = await kit.createRoom(host);
    const socket = await kit.connect(host);
    await kit.joinOk(socket, roomId);
    const heard = recordEvents<Heard>(socket, 'room:chat:message');
    const clientMessageId = crypto.randomUUID();
    const original = await kit.send(socket, roomId, 'message 0', clientMessageId);
    expect(original.ok).toBe(true);
    for (let count = 1; count < 10; count += 1) {
      expect(await kit.send(socket, roomId, `message ${String(count)}`)).toMatchObject({
        ok: true,
      });
    }
    expect(await kit.send(socket, roomId, 'one too many')).toMatchObject({
      error: { code: 'RATE_LIMITED' },
    });

    const retry = await kit.send(socket, roomId, 'message 0', clientMessageId);

    expect(retry).toEqual(original);
    await eventually(() => heard.length === 10);
    expect(bodies(heard)).not.toContain('one too many');
  });

  it('is shared by two sockets of one person and does not apply to another person', async () => {
    const host = await kit.newUser('host');
    const guest = await kit.newUser('guest');
    const roomId = await kit.createRoom(host);
    await kit.joinMembership(guest, roomId);
    const one = await kit.connect(host);
    const two = await kit.connect(host, kit.second());
    const guestSocket = await kit.connect(guest);
    await kit.joinOk(one, roomId);
    await kit.joinOk(two, roomId);
    await kit.joinOk(guestSocket, roomId);

    for (let count = 0; count < 5; count += 1) {
      expect(await kit.send(one, roomId, `one ${String(count)}`)).toMatchObject({ ok: true });
      expect(await kit.send(two, roomId, `two ${String(count)}`)).toMatchObject({ ok: true });
    }
    expect(await kit.send(one, roomId, 'eleventh')).toMatchObject({
      error: { code: 'RATE_LIMITED' },
    });
    expect(await kit.send(two, roomId, 'eleventh')).toMatchObject({
      error: { code: 'RATE_LIMITED' },
    });
    // Someone else is not limited by it.
    expect(await kit.send(guestSocket, roomId, 'hello')).toMatchObject({ ok: true });

    const ttl = await kit.harness().redis.pttl(redisKeys.rateLimit('chat', host.userId));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(10_000);
  });
});
