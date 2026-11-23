import { roomSnapshotSchema } from '@focus-flow/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { timerCommand } from '../../../test/room-timer.js';
import { closeAllSockets, eventually, recordEvents } from '../../../test/sockets.js';
import { redisKeys } from '../../platform/redis-keys.js';
import { createRoomKit } from '../room-realtime/room-test-kit.js';

// Redis losing every key (FLUSHALL) while a room timer runs (RT11). It has a harness of its
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
  it('recreates the timer idle on the next join, with a version above the lost one', async () => {
    const h = kit.harness();
    const host = await kit.newUser('host');
    const guest = await kit.newUser('guest');
    const roomId = await kit.createRoom(host);
    await kit.joinMembership(guest, roomId);
    const hostSocket = await kit.connect(host);
    const guestSocket = await kit.connect(guest, kit.second());
    await kit.joinOk(hostSocket, roomId);
    await kit.joinOk(guestSocket, roomId);
    const started = await timerCommand(hostSocket, roomId, { type: 'start' });
    expect(started.timer?.status).toBe('running');
    const lostVersion = started.timer?.version ?? Number.MAX_SAFE_INTEGER;
    const resyncs = recordEvents(guestSocket, 'room:resync');
    const before = await h.redis.get(redisKeys.epoch);

    await h.redis.flushall();

    await eventually(async () => (await h.redis.get(redisKeys.epoch)) !== before, 15_000);
    await eventually(() => resyncs.length >= 1, 15_000);
    expect(await h.redis.exists(redisKeys.roomTimer(roomId))).toBe(0);

    // The client answers the resync with a join and receives the recreated timer.
    const snapshot = roomSnapshotSchema.parse((await kit.joinOk(guestSocket, roomId)).snapshot);
    expect(snapshot.timer).toMatchObject({
      phase: 'focus',
      status: 'idle',
      segmentStartedAtMs: null,
      endsAtMs: null,
    });
    // Newer than anything the clients held or any job still around could name (RT2).
    expect(snapshot.timer.version).toBeGreaterThan(lostVersion);

    // The recreated timer is commandable again.
    expect(await timerCommand(hostSocket, roomId, { type: 'start' })).toMatchObject({
      ok: true,
      timer: { status: 'running', version: snapshot.timer.version + 1 },
    });
  });
});
