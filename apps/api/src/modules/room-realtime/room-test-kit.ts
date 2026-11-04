import { API_BASE_PATH, roomIdSchema } from '@focus-flow/contracts';
import type { Socket } from 'socket.io-client';
import { expect } from 'vitest';

import {
  startInstance,
  startTestHarness,
  stopTestHarness,
  type TestHarness,
  type TestInstance,
} from '../../../test/harness.js';
import { closeAllSockets, connectSocket, emitWithAck } from '../../../test/sockets.js';
import { signUpTestUser, type TestUser } from '../../../test/users.js';
import { redisKeys } from '../../platform/redis-keys.js';

// Shared by the room integration test files (one container pair per file): a harness with
// two API instances, REST and socket helpers, and the answer shapes.

export const ROOM_TIMINGS = {
  INSTANCE_HEARTBEAT_MS: '200',
  INSTANCE_TTL_MS: '2000',
  KNOCK_TTL_MS: '1500',
  ROOM_MAX_PRESENT: '3',
};

export type Answer = {
  ok: boolean;
  error?: { code: string };
  snapshot?: unknown;
  expiresAtMs?: number;
  messageId?: string;
  sentAtMs?: number;
};

export type PresentPayload = { roomId: string; user: { userId: string } };
export type LeftPayload = { roomId: string; userId: string };

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export type RoomKit = ReturnType<typeof createRoomKit>;

export const createRoomKit = (
  timings: Record<string, string> = ROOM_TIMINGS,
  options: { readonly secondInstance?: boolean } = {},
) => {
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
    return {
      status: response.status,
      json: text === '' ? undefined : (JSON.parse(text) as unknown),
    };
  };

  const newUser = (label: string): Promise<TestUser> => signUpTestUser(requireHarness(), label);

  const createRoom = async (host: TestUser, isPrivate = false): Promise<string> => {
    const { status, json } = await rest(host, 'POST', '/rooms', { name: 'Test room', isPrivate });
    expect(status).toBe(201);
    return roomIdSchema.parse((json as { room: { id: string } }).room.id);
  };

  const joinMembership = async (user: TestUser, roomId: string): Promise<void> => {
    const { status } = await rest(user, 'POST', `/rooms/${roomId}/membership`);
    expect([200, 201]).toContain(status);
  };

  const connect = (
    user: TestUser,
    instance: { baseUrl: string } = requireHarness(),
  ): Promise<Socket> => connectSocket(instance.baseUrl, user.accessToken);

  const join = (socket: Socket, roomId: string): Promise<Answer> =>
    emitWithAck<Answer>(socket, 'room:join', { roomId });

  const joinOk = async (socket: Socket, roomId: string): Promise<Answer> => {
    const answer = await join(socket, roomId);
    expect(answer).toMatchObject({ ok: true });
    return answer;
  };

  const knock = (socket: Socket, roomId: string): Promise<Answer> =>
    emitWithAck<Answer>(socket, 'room:knock', { roomId });

  const send = (
    socket: Socket,
    roomId: string,
    body: string,
    clientMessageId: string = crypto.randomUUID(),
  ): Promise<Answer> =>
    emitWithAck<Answer>(socket, 'room:chat:send', { roomId, clientMessageId, body });

  const redisEntries = (roomId: string, userId: string): Promise<string[]> =>
    requireHarness().redis.smembers(redisKeys.roomPresenceSockets(roomId, userId));

  /** Users with a profile in the room's presence hash (live or not). */
  const presenceHashSize = (roomId: string): Promise<number> =>
    requireHarness().redis.hlen(redisKeys.roomPresence(roomId));

  return {
    harness: requireHarness,
    second: requireSecond,
    rest,
    newUser,
    createRoom,
    joinMembership,
    connect,
    join,
    joinOk,
    knock,
    send,
    redisEntries,
    presenceHashSize,
    start: async (): Promise<void> => {
      harness = await startTestHarness(timings);
      if (options.secondInstance !== false) {
        second = await startInstance(harness, timings);
      }
    },
    stop: async (): Promise<void> => {
      closeAllSockets();
      if (harness !== undefined) {
        await stopTestHarness(harness);
        harness = undefined;
      }
    },
  };
};

/** The error code of a REST error body. */
export const codeOf = (json: unknown): string | undefined =>
  (json as { error?: { code?: string } } | undefined)?.error?.code;

/** A latch: `wait()` announces arrival and blocks until `open()`; `arrival` resolves on arrival. */
export const createGate = () => {
  let release: () => void = () => undefined;
  let arrived: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  const arrival = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  return {
    arrival,
    open: release,
    wait: async (): Promise<void> => {
      arrived();
      await opened;
    },
  };
};
