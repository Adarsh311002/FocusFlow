import { roomIdSchema } from '@focus-flow/contracts';
import { describe, expect, it } from 'vitest';

import { createClock } from '../../lib/time-sync';
import { createRealtimeClient, type RealtimeSocket, type SocketFactory } from './realtime-client';
import {
  parseRoomServerEvent,
  type RoomClientEventName,
  type RoomServerEvent,
} from './room-events';

const ROOM_ID = '0191a3b2-7c4d-7e5f-8a9b-0c1d2e3f4a5b';
const ROOM = roomIdSchema.parse(ROOM_ID);
const USER_ID = '3f1c4b0a-5b6d-4e2f-9a8b-7c6d5e4f3a2b';

type Sent = { event: RoomClientEventName; payload: unknown };

function setup(answer: (sent: Sent) => Promise<unknown> = () => Promise.resolve({ ok: true })) {
  const sent: Sent[] = [];
  const roomListeners: Array<(name: string, payload: unknown) => void> = [];
  const connectListeners: Array<() => void> = [];
  let connected = false;
  const socket: RealtimeSocket = {
    get connected() {
      return connected;
    },
    active: false,
    connect: () => undefined,
    disconnect: () => {
      connected = false;
    },
    onConnect: (listener) => connectListeners.push(listener),
    onDisconnect: () => undefined,
    onConnectError: () => undefined,
    onFocusSessionUpdated: () => undefined,
    onRoomEvent: (listener) => roomListeners.push(listener),
    timeSync: () => Promise.resolve({ ok: true, serverNowMs: 1 }),
    emitWithAck: (event, payload) => {
      sent.push({ event, payload });
      return answer({ event, payload });
    },
  };
  const factory: SocketFactory = () => socket;
  const client = createRealtimeClient({
    createSocket: factory,
    getToken: () => 'token',
    refreshSession: () => Promise.resolve({ status: 'refreshed', accessToken: 'token' }),
    endSession: () => undefined,
    clock: createClock(() => 0),
    syncSamples: 1,
  });
  client.connect();
  return {
    client,
    sent,
    serverConnects: () => {
      connected = true;
      connectListeners.forEach((listener) => {
        listener();
      });
    },
    serverSends: (name: string, payload: unknown) => {
      roomListeners.forEach((listener) => {
        listener(name, payload);
      });
    },
  };
}

describe('room requests', () => {
  it('sends nothing while the socket is not connected', async () => {
    const { client, sent } = setup();
    const ack = await client.joinRoom(ROOM);
    expect(ack).toEqual({
      ok: false,
      error: { code: 'OFFLINE', message: 'The live connection is down.' },
    });
    expect(sent).toHaveLength(0);
  });

  it('sends each event with only the ids the contract allows and validates the acknowledgement', async () => {
    const { client, sent, serverConnects } = setup(({ event }) =>
      Promise.resolve(
        event === 'room:knock'
          ? { ok: true, expiresAtMs: 123 }
          : event === 'room:chat:send'
            ? { ok: true, messageId: '0191a3b2-7c4d-7e5f-8a9b-0c1d2e3f4a5c', sentAtMs: 5 }
            : { ok: true },
      ),
    );
    serverConnects();

    expect(await client.leaveRoom(ROOM)).toEqual({ ok: true });
    expect(await client.cancelKnock(ROOM)).toEqual({ ok: true });
    expect(await client.knockRoom(ROOM)).toEqual({ ok: true, expiresAtMs: 123 });
    const chat = await client.sendChat(ROOM, '0191a3b2-7c4d-7e5f-8a9b-0c1d2e3f4a5d', 'hi');
    expect(chat).toMatchObject({ ok: true, sentAtMs: 5 });
    expect(sent).toEqual([
      { event: 'room:leave', payload: { roomId: ROOM_ID } },
      { event: 'room:knock:cancel', payload: { roomId: ROOM_ID } },
      { event: 'room:knock', payload: { roomId: ROOM_ID } },
      {
        event: 'room:chat:send',
        payload: {
          roomId: ROOM_ID,
          clientMessageId: '0191a3b2-7c4d-7e5f-8a9b-0c1d2e3f4a5d',
          body: 'hi',
        },
      },
    ]);
  });

  it('passes a server refusal through with its code', async () => {
    const { client, serverConnects } = setup(() =>
      Promise.resolve({ ok: false, error: { code: 'NOT_A_MEMBER', message: 'No.' } }),
    );
    serverConnects();
    expect(await client.joinRoom(ROOM)).toEqual({
      ok: false,
      error: { code: 'NOT_A_MEMBER', message: 'No.' },
    });
  });

  it('reports a timeout and a malformed answer instead of throwing', async () => {
    const timeout = setup(() => Promise.reject(new Error('operation has timed out')));
    timeout.serverConnects();
    expect(await timeout.client.joinRoom(ROOM)).toMatchObject({
      ok: false,
      error: { code: 'TIMEOUT' },
    });

    const malformed = setup(() => Promise.resolve({ ok: true, snapshot: 'nonsense' }));
    malformed.serverConnects();
    expect(await malformed.client.joinRoom(ROOM)).toMatchObject({
      ok: false,
      error: { code: 'MALFORMED_RESPONSE' },
    });
  });
});

describe('room events', () => {
  it('delivers validated events and drops malformed or unknown ones', () => {
    const { client, serverSends } = setup();
    const seen: RoomServerEvent[] = [];
    const off = client.onRoomEvent((event) => seen.push(event));

    serverSends('room:presence:left', { roomId: ROOM_ID, userId: USER_ID });
    serverSends('room:presence:left', { roomId: 'not-a-uuid', userId: USER_ID });
    serverSends('room:presence:left', { roomId: ROOM_ID });
    serverSends('room:unknown', { roomId: ROOM_ID });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ name: 'room:presence:left' });

    off();
    serverSends('room:presence:left', { roomId: ROOM_ID, userId: USER_ID });
    expect(seen).toHaveLength(1);
  });

  it('parses by name', () => {
    expect(parseRoomServerEvent('room:resync', { roomId: ROOM_ID })).toMatchObject({
      name: 'room:resync',
    });
    expect(parseRoomServerEvent('focus:session:updated', {})).toBeNull();
  });
});

describe('timer commands', () => {
  const timer = {
    roomId: ROOM_ID,
    phase: 'focus',
    status: 'running',
    durationMs: 1_500_000,
    elapsedBeforeMs: 0,
    segmentStartedAtMs: 1_000,
    endsAtMs: 1_501_000,
    version: 1_001,
  };

  it('sends only the room and the command, and validates an accepted answer', async () => {
    const { client, sent, serverConnects } = setup(() =>
      Promise.resolve({ ok: true, timer, serverNowMs: 2_000 }),
    );
    serverConnects();
    const ack = await client.sendTimerCommand(ROOM, { type: 'reset', expectedVersion: 1_000 });
    expect(ack).toMatchObject({ ok: true, timer: { version: 1_001 }, serverNowMs: 2_000 });
    expect(sent).toEqual([
      {
        event: 'room:timer:command',
        payload: { roomId: ROOM_ID, command: { type: 'reset', expectedVersion: 1_000 } },
      },
    ]);
  });

  it('keeps the details of a rejection so the caller can catch up', async () => {
    const details = { timer, serverNowMs: 2_000 };
    const { client, serverConnects } = setup(() =>
      Promise.resolve({
        ok: false,
        error: { code: 'VERSION_CONFLICT', message: 'Changed.', details },
      }),
    );
    serverConnects();
    expect(await client.sendTimerCommand(ROOM, { type: 'start' })).toEqual({
      ok: false,
      error: { code: 'VERSION_CONFLICT', message: 'Changed.', details },
    });
  });

  it('answers MALFORMED_RESPONSE for an accepted answer without a valid timer', async () => {
    const { client, serverConnects } = setup(() =>
      Promise.resolve({ ok: true, timer: { ...timer, status: 'exploding' }, serverNowMs: 1 }),
    );
    serverConnects();
    expect(await client.sendTimerCommand(ROOM, { type: 'pause' })).toMatchObject({
      ok: false,
      error: { code: 'MALFORMED_RESPONSE' },
    });
  });

  it('answers OFFLINE without sending while disconnected, and TIMEOUT when unanswered', async () => {
    const offline = setup();
    expect(await offline.client.sendTimerCommand(ROOM, { type: 'start' })).toMatchObject({
      ok: false,
      error: { code: 'OFFLINE' },
    });
    expect(offline.sent).toHaveLength(0);

    const slow = setup(() => Promise.reject(new Error('operation has timed out')));
    slow.serverConnects();
    expect(await slow.client.sendTimerCommand(ROOM, { type: 'start' })).toMatchObject({
      ok: false,
      error: { code: 'TIMEOUT' },
    });
  });

  it('delivers validated room:timer:state events and drops malformed ones', () => {
    const { client, serverSends } = setup();
    const seen: RoomServerEvent[] = [];
    client.onRoomEvent((event) => seen.push(event));
    serverSends('room:timer:state', { roomId: ROOM_ID, timer, serverNowMs: 5 });
    serverSends('room:timer:state', {
      roomId: ROOM_ID,
      timer: { ...timer, version: -1 },
      serverNowMs: 5,
    });
    serverSends('room:timer:state', { roomId: ROOM_ID, timer });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ name: 'room:timer:state' });
  });
});
