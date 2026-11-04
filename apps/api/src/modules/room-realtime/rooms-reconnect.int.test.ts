import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  closeAllSockets,
  eventually,
  recordEvents,
  waitForDisconnect,
} from '../../../test/sockets.js';
import { connectSocket } from '../../../test/sockets.js';
import { logOutTestUser, signUpTestUser } from '../../../test/users.js';
import { authSessions } from '../../db/schema.js';
import { redisKeys } from '../../platform/redis-keys.js';
import { issueAccessToken } from '../auth/jwt.js';
import {
  createGate,
  createRoomKit,
  type LeftPayload,
  ROOM_TIMINGS,
  sleep,
} from './room-test-kit.js';

// A person's sockets coming and going (T5): a reconnect that overtakes the old socket's
// disconnect, and the two ways a connection ends from the server side (token expiry,
// session revocation) while the person is in a room.

// A slow heartbeat: the reconnect test holds a disconnect open on purpose, and a heartbeat
// sync landing in that window would (correctly) report the person absent for a moment.
const kit = createRoomKit({
  ...ROOM_TIMINGS,
  INSTANCE_HEARTBEAT_MS: '10000',
  INSTANCE_TTL_MS: '30000',
});

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

describe('reconnecting', () => {
  it('does not flap the presence when the new socket joins before the old disconnect is processed', async () => {
    const h = kit.harness();
    const presence = h.runtime.roomRealtime.presence;
    const original = presence.leave.bind(presence);
    const gate = createGate();
    const host = await kit.newUser('host');
    const guest = await kit.newUser('guest');
    const roomId = await kit.createRoom(host);
    await kit.joinMembership(guest, roomId);
    const hostSocket = await kit.connect(host);
    await kit.joinOk(hostSocket, roomId);
    const departures = recordEvents<LeftPayload>(hostSocket, 'room:presence:left');
    const arrivals = recordEvents(hostSocket, 'room:presence:joined');
    const oldSocket = await kit.connect(guest);
    await kit.joinOk(oldSocket, roomId);
    await eventually(() => arrivals.length === 1);
    const oldSocketId = String(oldSocket.id);
    // The old socket's disconnect is held right where it would remove its entry.
    vi.spyOn(presence, 'leave').mockImplementationOnce(async (ref) => {
      await gate.wait();
      return original(ref);
    });

    oldSocket.disconnect();
    await gate.arrival;
    const newSocket = await kit.connect(guest);
    await kit.joinOk(newSocket, roomId);
    gate.open();

    // The old disconnect removes only its own entry.
    await eventually(async () => {
      const entries = await kit.redisEntries(roomId, guest.userId);
      return entries.length === 1 && !entries.some((entry) => entry.endsWith(`:${oldSocketId}`));
    });
    expect(await kit.redisEntries(roomId, guest.userId)).toEqual([
      `${h.runtime.instanceId}:${String(newSocket.id)}`,
    ]);
    expect(await h.redis.hexists(redisKeys.roomPresence(roomId), guest.userId)).toBe(1);
    // Control: the person is still announced as present, never as left.
    await sleep(300);
    expect(departures).toEqual([]);
    expect(arrivals).toHaveLength(1);
  });
});

describe('connections that the server ends', () => {
  it('removes a person whose access token expires while they are in a room', async () => {
    const h = kit.harness();
    const host = await kit.newUser('host');
    const guest = await signUpTestUser(h, 'guest');
    const roomId = await kit.createRoom(host);
    await kit.joinMembership(guest, roomId);
    const hostSocket = await kit.connect(host);
    await kit.joinOk(hostSocket, roomId);
    const departures = recordEvents<LeftPayload>(hostSocket, 'room:presence:left');
    const [session] = await h.db
      .select({ id: authSessions.id })
      .from(authSessions)
      .where(eq(authSessions.userId, guest.userId));
    if (session === undefined) {
      throw new Error('the guest has no auth session');
    }
    const { token } = await issueAccessToken(
      { userId: guest.userId, sid: session.id },
      { keys: h.authDeps.jwtKeys, issuer: h.authDeps.jwtIssuer, audience: h.authDeps.jwtAudience },
      2,
    );
    const guestSocket = await connectSocket(h.baseUrl, token);
    await kit.joinOk(guestSocket, roomId);

    expect(await waitForDisconnect(guestSocket, 8_000)).toBe('io server disconnect');

    await eventually(() => departures.length === 1);
    expect(departures[0]).toEqual({ roomId, userId: guest.userId });
    await eventually(async () => (await kit.redisEntries(roomId, guest.userId)).length === 0);
    expect(await h.redis.hexists(redisKeys.roomPresence(roomId), guest.userId)).toBe(0);
  });

  it('removes a person whose session is revoked while they are in a room', async () => {
    const h = kit.harness();
    const host = await kit.newUser('host');
    const guest = await kit.newUser('guest');
    const roomId = await kit.createRoom(host);
    await kit.joinMembership(guest, roomId);
    const hostSocket = await kit.connect(host);
    await kit.joinOk(hostSocket, roomId);
    const departures = recordEvents<LeftPayload>(hostSocket, 'room:presence:left');
    const guestSocket = await kit.connect(guest, kit.second());
    await kit.joinOk(guestSocket, roomId);
    const closed = waitForDisconnect(guestSocket, 8_000);

    await logOutTestUser(h, guest);

    expect(await closed).toBe('io server disconnect');
    await eventually(() => departures.length === 1);
    expect(departures[0]).toEqual({ roomId, userId: guest.userId });
    await eventually(async () => (await kit.redisEntries(roomId, guest.userId)).length === 0);
    expect(await h.redis.hexists(redisKeys.roomPresence(roomId), guest.userId)).toBe(0);
  });
});
