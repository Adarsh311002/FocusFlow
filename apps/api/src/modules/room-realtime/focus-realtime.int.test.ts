import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  authSessionIdSchema,
  type RoomFocusSnapshot,
  roomSnapshotSchema,
  SOCKET_IO_PATH,
  userIdSchema,
} from '@focus-flow/contracts';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import pino from 'pino';
import { Server } from 'socket.io';
import type { Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { closeAllSockets, eventually, openSocket, waitForConnect } from '../../../test/sockets.js';
import { redisTimeMs } from '../../platform/redis.js';
import { redisKeys } from '../../platform/redis-keys.js';
import { createSocketEmitter, socketIoChannelKey } from '../../platform/socket.js';
import { type AppServer, roomRoom } from '../realtime/types.js';
import type { DepartureReason, RoomFocusChange } from '../room-focus/types.js';
import type { RoomTimerService, TimerState } from '../room-timer/types.js';
import { attachFocusAnnouncers } from './focus-announcers.js';
import type { RoomFocusPort } from './focus-hooks.js';
import { createRoomRealtime, type RoomRealtime } from './module.js';
import { type Answer, createRoomKit, sleep } from './room-test-kit.js';

// The room sockets with room focus runs (RF7, RF8, RF12) over real Redis and PostgreSQL,
// with a Socket.IO server built here around the real room realtime module and a recording
// stand-in for the focus service, so that exactly what the socket layer asks of the service
// is observable. Users, rooms and memberships come from the real API through REST.

const kit = createRoomKit(
  { INSTANCE_HEARTBEAT_MS: '200', INSTANCE_TTL_MS: '2000' },
  {
    secondInstance: false,
  },
);

const RUN_ID = '01a0ed0d-55de-7d1b-8495-82fb5050d818';
/** The participant-list version both the fake snapshot and the fake announcer report (G2). */
const STATE_VERSION = 7;
const INSTANCE_ID = `focus-rt-${randomUUID()}`;

const timerState: TimerState = {
  phase: 'focus',
  status: 'idle',
  durationMs: 1_500_000,
  elapsedBeforeMs: 0,
  segmentStartedAtMs: null,
  version: 1,
  focusRunId: RUN_ID,
};

const focusSnapshot = (): RoomFocusSnapshot =>
  ({
    focusRunId: RUN_ID,
    participants: [],
    participantsVersion: STATE_VERSION,
    me: { participation: null },
  }) as unknown as RoomFocusSnapshot;

type Call = { name: string; userId: string; roomId: string; reason?: DepartureReason };

/** A focus service that records what the socket layer asks of it. */
const createRecordingFocus = () => {
  const calls: Call[] = [];
  const listeners: ((change: RoomFocusChange) => void | Promise<void>)[] = [];
  const control = {
    failDepart: false,
    failSnapshot: false,
    /** Runs when `depart` is called, before it answers (to look at Redis at that moment). */
    onDepart: undefined as (() => Promise<void>) | undefined,
  };
  const port: RoomFocusPort = {
    snapshot: (userId, roomId) => {
      calls.push({ name: 'snapshot', userId, roomId });
      return control.failSnapshot
        ? Promise.reject(new Error('focus unavailable'))
        : Promise.resolve(focusSnapshot());
    },
    depart: async (userId, roomId, reason) => {
      calls.push({ name: 'depart', userId, roomId, reason });
      await control.onDepart?.();
      if (control.failDepart) {
        throw new Error('postgres unavailable');
      }
    },
    userLeftRoom: (userId, roomId) => {
      calls.push({ name: 'userLeftRoom', userId, roomId });
      return Promise.resolve();
    },
    userJoinedRoom: (userId, roomId) => {
      calls.push({ name: 'userJoinedRoom', userId, roomId });
      return Promise.resolve();
    },
  };
  return {
    port,
    calls,
    control,
    count: (name: string, userId?: string) =>
      calls.filter((call) => call.name === name && (userId === undefined || call.userId === userId))
        .length,
    names: () => calls.map((call) => call.name),
    announcerService: {
      onChange: (listener: (change: RoomFocusChange) => void | Promise<void>) => {
        listeners.push(listener);
      },
      participants: () =>
        Promise.resolve({
          focusRunId: RUN_ID,
          participants: [],
          participantsVersion: STATE_VERSION,
        }) as ReturnType<Parameters<typeof attachFocusAnnouncers>[0]['participants']>,
    },
    fire: async (change: RoomFocusChange) => {
      for (const listener of listeners) {
        await listener(change);
      }
    },
  };
};

let httpServer: HttpServer;
let io: AppServer;
let realtime: RoomRealtime;
let baseUrl: string;
let connections: Redis[] = [];
const focus = createRecordingFocus();

beforeAll(async () => {
  await kit.start();
  const h = kit.harness();
  const logger = pino({ level: 'silent' });
  const pub = new Redis(h.config.REDIS_URL);
  const sub = new Redis(h.config.REDIS_URL);
  connections = [pub, sub];
  httpServer = createServer();
  io = new Server(httpServer, {
    path: SOCKET_IO_PATH,
    serveClient: false,
    adapter: createAdapter(pub, sub, { key: socketIoChannelKey(h.config) }),
  });
  // Test-only identity: the real handshake is covered elsewhere; here the client names itself.
  io.use((socket, next) => {
    const raw: unknown = socket.handshake.auth.userId;
    if (typeof raw !== 'string') {
      next(new Error('no user'));
      return;
    }
    const userId = userIdSchema.parse(raw);
    socket.data = {
      userId,
      sid: authSessionIdSchema.parse(randomUUID()),
      displayName: `user ${raw.slice(0, 4)}`,
      avatarUrl: null,
      tokenExpiresAtMs: Date.now() + 3_600_000,
      joinedRooms: [],
    };
    void socket.join(`user:${userId}`);
    next();
  });
  const emitter = createSocketEmitter(pub, h.config);
  const timer = {
    get: () => Promise.resolve({ state: timerState, nowMs: 1 }),
  } as unknown as RoomTimerService;
  realtime = createRoomRealtime({
    redis: h.redis,
    db: h.db,
    emitter,
    logger,
    instanceId: INSTANCE_ID,
    instanceTtlMs: 30_000,
    knockTtlMs: 1_000,
    maxPresent: 10,
    timer,
    focus: focus.port,
    checkUser: () => Promise.reject(new Error('not used')),
  });
  io.on('connection', (socket) => {
    realtime.attachSocket(socket);
  });
  attachFocusAnnouncers(focus.announcerService, emitter, logger);
  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${String((httpServer.address() as AddressInfo).port)}`;
  // This instance counts as alive for room presence.
  await h.redis.zadd(redisKeys.instances, await redisTimeMs(h.redis), INSTANCE_ID);
}, 180_000);

afterEach(() => {
  closeAllSockets();
  focus.calls.length = 0;
  focus.control.failDepart = false;
  focus.control.failSnapshot = false;
  focus.control.onDepart = undefined;
});

afterAll(async () => {
  closeAllSockets();
  await io.close();
  for (const connection of connections) {
    connection.disconnect();
  }
  await kit.stop();
}, 60_000);

const connect = async (userId: string): Promise<Socket> => {
  const socket = openSocket(baseUrl, { userId }, { transports: ['websocket'] });
  const outcome = await waitForConnect(socket);
  if (!outcome.connected) {
    throw new Error(`refused: ${outcome.message}`);
  }
  return socket;
};

const joinRoom = (socket: Socket, roomId: string): Promise<Answer> => kit.join(socket, roomId);

const leaveRoom = (socket: Socket, roomId: string): Promise<Answer> =>
  new Promise((resolve, reject) => {
    socket.timeout(5_000).emit('room:leave', { roomId }, (error: Error | null, answer: Answer) => {
      if (error === null) {
        resolve(answer);
      } else {
        reject(error);
      }
    });
  });

/** A room with a member who is present with `tabs` sockets. */
const setup = async (tabs = 1) => {
  const host = await kit.newUser('host');
  const member = await kit.newUser('member');
  const roomId = await kit.createRoom(host);
  await kit.joinMembership(member, roomId);
  const sockets: Socket[] = [];
  for (let index = 0; index < tabs; index += 1) {
    const socket = await connect(member.userId);
    await kit.joinOk(socket, roomId);
    sockets.push(socket);
  }
  return { host, member, roomId, sockets };
};

describe('room:join', () => {
  it('reconnects the participant before the snapshot is read, and only for the first socket', async () => {
    const { member, roomId, sockets } = await setup(2);

    expect(focus.count('userJoinedRoom', member.userId)).toBe(1);
    expect(focus.count('snapshot', member.userId)).toBe(2);
    expect(focus.names().slice(0, 2)).toEqual(['userJoinedRoom', 'snapshot']);

    const again = await joinRoom(sockets[0] as Socket, roomId);
    expect(roomSnapshotSchema.parse(again.snapshot).focus).toEqual(focusSnapshot());
    expect(focus.count('userJoinedRoom', member.userId)).toBe(1);
  });

  it('a snapshot that cannot be built undoes the join', async () => {
    const host = await kit.newUser('host');
    const roomId = await kit.createRoom(host);
    const socket = await connect(host.userId);
    focus.control.failSnapshot = true;

    const answer = await joinRoom(socket, roomId);

    expect(answer).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
    expect(await kit.redisEntries(roomId, host.userId)).toEqual([]);
    expect(await io.in(roomRoom(roomId)).fetchSockets()).toHaveLength(0);
  });
});

describe('closing sockets', () => {
  it('one of two tabs closing is not a disconnect; the last one is', async () => {
    const { member, roomId, sockets } = await setup(2);

    sockets[0]?.disconnect();
    await eventually(async () => (await kit.redisEntries(roomId, member.userId)).length === 1);
    await sleep(150);
    expect(focus.count('userLeftRoom')).toBe(0);

    sockets[1]?.disconnect();
    await eventually(() => focus.count('userLeftRoom', member.userId) === 1);
    expect(focus.calls.find((call) => call.name === 'userLeftRoom')).toMatchObject({
      roomId,
      userId: member.userId,
    });
    expect(await kit.redisEntries(roomId, member.userId)).toEqual([]);
  });

  it('a sync that finds the last socket gone, an eviction and a dead instance all report it', async () => {
    const { member, roomId, sockets } = await setup(1);
    const socketId = String(sockets[0]?.id);

    // Eviction (the membership ended).
    expect(await realtime.presence.evict(roomId, member.userId)).toBe(true);
    await eventually(() => focus.count('userLeftRoom', member.userId) === 1);

    // A socket left its Socket.IO room without the presence being told: the sync finds it.
    const second = await setup(1);
    const secondId = String(second.sockets[0]?.id);
    io.in(secondId).socketsLeave(roomRoom(second.roomId));
    await realtime.syncLocal(io);
    await eventually(() => focus.count('userLeftRoom', second.member.userId) === 1);

    // The instance is declared dead / shut down: its entries go.
    const third = await setup(1);
    await realtime.removeInstance(INSTANCE_ID);
    await eventually(() => focus.count('userLeftRoom', third.member.userId) === 1);
    expect(socketId).not.toBe('');
  });

  it('a socket found in a room without presence makes the user present again', async () => {
    const { member, roomId, sockets } = await setup(1);
    const socketId = String(sockets[0]?.id);
    await realtime.presence.evict(roomId, member.userId);
    await eventually(() => focus.count('userLeftRoom', member.userId) === 1);
    expect(focus.count('userJoinedRoom', member.userId)).toBe(1);

    // The socket is still in the Socket.IO room: the next sync records it and reports it.
    await realtime.syncLocal(io);

    await eventually(() => focus.count('userJoinedRoom', member.userId) === 2);
    expect(await kit.redisEntries(roomId, member.userId)).toEqual([`${INSTANCE_ID}:${socketId}`]);
  });
});

describe('room:leave', () => {
  it('departs on purpose before the presence is removed', async () => {
    const { member, roomId, sockets } = await setup(1);
    const entriesAtDepart: string[][] = [];
    focus.control.onDepart = async () => {
      entriesAtDepart.push(await kit.redisEntries(roomId, member.userId));
    };

    const answer = await leaveRoom(sockets[0] as Socket, roomId);

    expect(answer).toMatchObject({ ok: true });
    expect(focus.calls.filter((call) => call.name === 'depart')).toEqual([
      { name: 'depart', userId: member.userId, roomId, reason: 'left_room' },
    ]);
    expect(entriesAtDepart).toHaveLength(1);
    expect(entriesAtDepart[0]).toHaveLength(1);
    expect(await kit.redisEntries(roomId, member.userId)).toEqual([]);
  });

  it('leaving with one of two tabs does not depart; leaving with the last one does', async () => {
    const { member, roomId, sockets } = await setup(2);

    expect(await leaveRoom(sockets[0] as Socket, roomId)).toMatchObject({ ok: true });
    expect(focus.count('depart')).toBe(0);
    expect(await kit.redisEntries(roomId, member.userId)).toHaveLength(1);

    expect(await leaveRoom(sockets[1] as Socket, roomId)).toMatchObject({ ok: true });
    expect(focus.count('depart', member.userId)).toBe(1);
  });

  it('a departure that fails answers an error and leaves the socket in the room', async () => {
    const { member, roomId, sockets } = await setup(1);
    focus.control.failDepart = true;

    const answer = await leaveRoom(sockets[0] as Socket, roomId);

    expect(answer).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
    expect(await kit.redisEntries(roomId, member.userId)).toHaveLength(1);
    expect(await io.in(roomRoom(roomId)).fetchSockets()).toHaveLength(1);

    focus.control.failDepart = false;
    expect(await leaveRoom(sockets[0] as Socket, roomId)).toMatchObject({ ok: true });
    expect(await kit.redisEntries(roomId, member.userId)).toEqual([]);
  });
});

describe('announcements', () => {
  it('participants go to the room, a session change only to its owner', async () => {
    const { member, host, roomId, sockets } = await setup(1);
    const hostSocket = await connect(host.userId);
    await kit.joinOk(hostSocket, roomId);
    const received: { who: string; event: string; payload: unknown }[] = [];
    for (const [who, socket] of [
      ['member', sockets[0]],
      ['host', hostSocket],
    ] as const) {
      socket?.on('room:focus:participants', (payload: unknown) => {
        received.push({ who, event: 'participants', payload });
      });
      socket?.on('focus:session:updated', (payload: unknown) => {
        received.push({ who, event: 'session', payload });
      });
    }

    await focus.fire({ kind: 'participants', roomId });
    await eventually(() => received.length === 2);
    expect(received.map((entry) => `${entry.who}:${entry.event}`).sort()).toEqual([
      'host:participants',
      'member:participants',
    ]);
    expect(received[0]?.payload).toEqual({
      roomId,
      focusRunId: RUN_ID,
      participants: [],
      participantsVersion: STATE_VERSION,
    });

    received.length = 0;
    const session = { id: randomUUID() } as never;
    await focus.fire({ kind: 'session', userId: member.userId, session });
    await eventually(() => received.length === 1);
    await sleep(150);
    expect(received).toEqual([{ who: 'member', event: 'session', payload: { session } }]);
  });
});
