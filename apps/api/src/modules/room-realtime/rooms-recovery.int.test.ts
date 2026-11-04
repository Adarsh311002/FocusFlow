import { roomSnapshotSchema } from '@focus-flow/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { startInstance } from '../../../test/harness.js';
import { closeAllSockets, eventually, recordEvents } from '../../../test/sockets.js';
import { redisTimeMs } from '../../platform/redis.js';
import { redisKeys } from '../../platform/redis-keys.js';
import {
  createRoomKit,
  type LeftPayload,
  type PresentPayload,
  ROOM_TIMINGS,
} from './room-test-kit.js';

// Instance death, clean shutdown and the repair of single entries (M5, T6). Redis losing
// all its data has its own file: it needs a harness of its own.

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

const INSTANCE_TTL_MS = Number(ROOM_TIMINGS.INSTANCE_TTL_MS);

describe('the join snapshot', () => {
  it('carries a server time between two reads of Redis TIME', async () => {
    const host = await kit.newUser('host');
    const roomId = await kit.createRoom(host);
    const socket = await kit.connect(host);
    const redis = kit.harness().redis;

    const before = await redisTimeMs(redis);
    const snapshot = roomSnapshotSchema.parse((await kit.joinOk(socket, roomId)).snapshot);
    const after = await redisTimeMs(redis);

    expect(snapshot.serverNowMs).toBeGreaterThanOrEqual(before);
    expect(snapshot.serverNowMs).toBeLessThanOrEqual(after);
  });
});

describe('instance death', () => {
  it('stops showing a dead instance’s people once its heartbeat is stale, and announces them when it is cleaned up', async () => {
    const h = kit.harness();
    const doomed = await startInstance(h, ROOM_TIMINGS);
    try {
      const host = await kit.newUser('host');
      const stranded = await kit.newUser('stranded');
      const roomId = await kit.createRoom(host);
      await kit.joinMembership(stranded, roomId);
      const hostSocket = await kit.connect(host);
      await kit.joinOk(hostSocket, roomId);
      await kit.joinOk(await kit.connect(stranded, doomed), roomId);
      const departures = recordEvents<LeftPayload>(hostSocket, 'room:presence:left');
      const presence = h.runtime.roomRealtime.presence;
      const listed = async (): Promise<boolean> =>
        (await presence.present([roomId]))
          .get(roomId)
          ?.some((user) => user.userId === stranded.userId) ?? false;
      expect(await listed()).toBe(true);

      // A crash: the instance loses Redis without cleaning anything up.
      doomed.runtime.redis.disconnect();
      const lastBeat = Number(await h.redis.zscore(redisKeys.instances, doomed.runtime.instanceId));
      expect(lastBeat).toBeGreaterThan(0);

      // Every read lists the person until the heartbeat is older than the TTL, and none
      // lists them after.
      const seen = { listed: false };
      await eventually(async () => {
        const before = await redisTimeMs(h.redis);
        const isListed = await listed();
        const after = await redisTimeMs(h.redis);
        if (isListed) {
          seen.listed = true;
          expect(before).toBeLessThanOrEqual(lastBeat + INSTANCE_TTL_MS);
          return false;
        }
        expect(after).toBeGreaterThan(lastBeat + INSTANCE_TTL_MS);
        return true;
      }, 10_000);
      expect(seen.listed || (await redisTimeMs(h.redis)) > lastBeat + INSTANCE_TTL_MS).toBe(true);
      expect(await kit.redisEntries(roomId, stranded.userId)).toHaveLength(1);
      expect(departures).toEqual([]);

      await h.runtime.reconciler.run({
        schemaVersion: 1,
        trigger: 'recovery',
        correlationId: 'room-test',
      });

      await eventually(() => departures.some((event) => event.userId === stranded.userId));
      expect(await kit.redisEntries(roomId, stranded.userId)).toEqual([]);
      expect(await h.redis.smembers(redisKeys.instanceRooms(doomed.runtime.instanceId))).toEqual(
        [],
      );
      expect(await h.redis.hexists(redisKeys.roomPresence(roomId), stranded.userId)).toBe(0);
    } finally {
      await doomed.runtime.stop().catch(() => undefined);
      h.extraInstances.splice(h.extraInstances.indexOf(doomed), 1);
    }
  });

  it('removes a stopped instance’s people on a clean shutdown', async () => {
    const h = kit.harness();
    const leaving = await startInstance(h, ROOM_TIMINGS);
    try {
      const host = await kit.newUser('host');
      const guest = await kit.newUser('guest');
      const roomId = await kit.createRoom(host);
      await kit.joinMembership(guest, roomId);
      const hostSocket = await kit.connect(host);
      await kit.joinOk(hostSocket, roomId);
      await kit.joinOk(await kit.connect(guest, leaving), roomId);
      const departures = recordEvents<LeftPayload>(hostSocket, 'room:presence:left');

      await leaving.runtime.stop();

      await eventually(() => departures.some((event) => event.userId === guest.userId));
      expect(await kit.redisEntries(roomId, guest.userId)).toEqual([]);
    } finally {
      await leaving.runtime.stop().catch(() => undefined);
      h.extraInstances.splice(h.extraInstances.indexOf(leaving), 1);
    }
  });
});

describe('repairing single entries', () => {
  it('repairs a missing entry from the socket’s room, and drops a stale one', async () => {
    const h = kit.harness();
    const host = await kit.newUser('host');
    const guest = await kit.newUser('guest');
    const roomId = await kit.createRoom(host);
    await kit.joinMembership(guest, roomId);
    const hostSocket = await kit.connect(host);
    const guestSocket = await kit.connect(guest);
    await kit.joinOk(hostSocket, roomId);
    await kit.joinOk(guestSocket, roomId);
    const departures = recordEvents<LeftPayload>(hostSocket, 'room:presence:left');
    const arrivals = recordEvents<PresentPayload>(hostSocket, 'room:presence:joined');

    // Redis loses the guest's entries although the socket is still in the room.
    await h.redis.del(redisKeys.roomPresenceSockets(roomId, guest.userId));
    await h.redis.hdel(redisKeys.roomPresence(roomId), guest.userId);
    await h.redis.srem(
      redisKeys.instanceRooms(h.runtime.instanceId),
      `${roomId}:${guest.userId}:${String(guestSocket.id)}`,
    );

    await eventually(async () => (await kit.redisEntries(roomId, guest.userId)).length === 1);
    await eventually(() => arrivals.length === 1);

    // An entry with no socket behind it (a missed disconnect).
    const ghost = await kit.newUser('ghost');
    await kit.joinMembership(ghost, roomId);
    const ghostSocketId = 'ghost-socket';
    await h.redis
      .multi()
      .sadd(
        redisKeys.roomPresenceSockets(roomId, ghost.userId),
        `${h.runtime.instanceId}:${ghostSocketId}`,
      )
      .sadd(
        redisKeys.instanceRooms(h.runtime.instanceId),
        `${roomId}:${ghost.userId}:${ghostSocketId}`,
      )
      .hset(
        redisKeys.roomPresence(roomId),
        ghost.userId,
        JSON.stringify({ displayName: 'Ghost', avatarUrl: null, firstJoinedAtMs: 1 }),
      )
      .exec();

    await eventually(() => departures.some((event) => event.userId === ghost.userId));
    expect(await kit.redisEntries(roomId, ghost.userId)).toEqual([]);
  });
});
