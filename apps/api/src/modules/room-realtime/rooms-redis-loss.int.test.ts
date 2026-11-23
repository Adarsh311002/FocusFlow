import { roomSnapshotSchema } from '@focus-flow/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { closeAllSockets, eventually, recordEvents } from '../../../test/sockets.js';
import { redisKeys } from '../../platform/redis-keys.js';
import { createRoomKit, type LeftPayload } from './room-test-kit.js';

// Redis losing every key (FLUSHALL) while people are in a room. It has a harness of its
// own: nothing else may share the Redis it wipes.

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

describe('Redis data loss', () => {
  it('asks every room’s clients to join again after Redis loses its data', async () => {
    const h = kit.harness();
    const host = await kit.newUser('host');
    const guest = await kit.newUser('guest');
    const roomId = await kit.createRoom(host);
    await kit.joinMembership(guest, roomId);
    const hostSocket = await kit.connect(host);
    const guestSocket = await kit.connect(guest, kit.second());
    await kit.joinOk(hostSocket, roomId);
    await kit.joinOk(guestSocket, roomId);
    const resyncs = recordEvents(hostSocket, 'room:resync');
    const guestResyncs = recordEvents(guestSocket, 'room:resync');
    const departures = recordEvents<LeftPayload>(hostSocket, 'room:presence:left');
    const before = await h.redis.get(redisKeys.epoch);

    await h.redis.flushall();

    await eventually(async () => (await h.redis.get(redisKeys.epoch)) !== before, 15_000);
    await eventually(() => resyncs.length >= 1 && guestResyncs.length >= 1, 15_000);
    expect(resyncs[0]).toEqual({ roomId });
    await eventually(async () => (await kit.redisEntries(roomId, guest.userId)).length === 1);
    expect(departures).toEqual([]);

    // Clients answer with a fresh join and get the rebuilt picture.
    const snapshot = roomSnapshotSchema.parse((await kit.joinOk(hostSocket, roomId)).snapshot);
    expect(snapshot.presence.map((user) => user.userId).sort()).toEqual(
      [host.userId, guest.userId].sort(),
    );
  });
});
