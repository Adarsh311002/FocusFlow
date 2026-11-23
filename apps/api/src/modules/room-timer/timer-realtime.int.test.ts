import { roomSnapshotSchema } from '@focus-flow/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  currentTimer,
  probeRoom,
  timerCommand,
  type TimerEvent,
} from '../../../test/room-timer.js';
import { closeAllSockets, eventually, recordEvents } from '../../../test/sockets.js';
import { createRoomKit } from '../room-realtime/room-test-kit.js';

// The host's timer commands over real sockets and Redis (RT5, RT6, RT13): who may command,
// stale commands, isolation between rooms, and that every client sees the same versions.

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

/** A room with its host and one member, both joined, on different API instances. */
const setup = async () => {
  const host = await kit.newUser('host');
  const guest = await kit.newUser('guest');
  const roomId = await kit.createRoom(host);
  await kit.joinMembership(guest, roomId);
  const hostSocket = await kit.connect(host);
  const guestSocket = await kit.connect(guest, kit.second());
  const hostAnswer = await kit.joinOk(hostSocket, roomId);
  await kit.joinOk(guestSocket, roomId);
  return { host, guest, roomId, hostSocket, guestSocket, hostAnswer };
};

describe('join snapshot', () => {
  it('carries the idle focus timer created at first access, and the latest state later', async () => {
    const { roomId, hostSocket, guestSocket, hostAnswer } = await setup();
    const first = roomSnapshotSchema.parse(hostAnswer.snapshot);
    expect(first.timer).toMatchObject({
      roomId,
      phase: 'focus',
      status: 'idle',
      durationMs: 1_500_000,
      elapsedBeforeMs: 0,
      segmentStartedAtMs: null,
      endsAtMs: null,
    });

    expect(await timerCommand(hostSocket, roomId, { type: 'start' })).toMatchObject({ ok: true });
    const again = roomSnapshotSchema.parse((await kit.joinOk(guestSocket, roomId)).snapshot);
    expect(again.timer.status).toBe('running');
    expect(again.timer.version).toBe(first.timer.version + 1);
  });
});

describe('host commands', () => {
  it('start reaches every client with the same version as the acknowledgement', async () => {
    const { roomId, hostSocket, guestSocket } = await setup();
    const hostEvents = recordEvents<TimerEvent>(hostSocket, 'room:timer:state');
    const guestEvents = recordEvents<TimerEvent>(guestSocket, 'room:timer:state');

    const answer = await timerCommand(hostSocket, roomId, { type: 'start' });

    expect(answer).toMatchObject({ ok: true, timer: { status: 'running', roomId } });
    await eventually(() => hostEvents.length >= 1 && guestEvents.length >= 1);
    expect(hostEvents).toHaveLength(1);
    expect(guestEvents).toHaveLength(1);
    expect(hostEvents[0]?.timer.version).toBe(answer.timer?.version);
    expect(guestEvents[0]?.timer).toEqual(hostEvents[0]?.timer);
    expect(guestEvents[0]?.timer.endsAtMs).toBe(
      (guestEvents[0]?.timer.segmentStartedAtMs ?? 0) + 1_500_000,
    );
  });

  it('a stale reset gets VERSION_CONFLICT with the current timer and changes nothing', async () => {
    const { roomId, hostSocket, guestSocket } = await setup();
    const guestEvents = recordEvents<TimerEvent>(guestSocket, 'room:timer:state');
    const started = await timerCommand(hostSocket, roomId, { type: 'start' });
    const staleVersion = (started.timer?.version ?? 0) - 1;
    await eventually(() => guestEvents.length === 1);
    const runtime = kit.harness().runtime;

    const answer = await timerCommand(hostSocket, roomId, {
      type: 'reset',
      expectedVersion: staleVersion,
    });

    expect(answer.ok).toBe(false);
    expect(answer.error?.code).toBe('VERSION_CONFLICT');
    expect(answer.error?.details?.timer).toEqual(started.timer);
    expect(typeof answer.error?.details?.serverNowMs).toBe('number');
    expect(await currentTimer(runtime, roomId)).toMatchObject({
      status: 'running',
      version: started.timer?.version,
    });
    await probeRoom((body) => kit.send(hostSocket, roomId, body), guestSocket);
    expect(guestEvents).toHaveLength(1);
  });

  it('an invalid transition says why and carries the current timer', async () => {
    const { roomId, hostSocket } = await setup();
    const started = await timerCommand(hostSocket, roomId, { type: 'start' });

    const answer = await timerCommand(hostSocket, roomId, { type: 'start' });

    expect(answer.error?.code).toBe('INVALID_TRANSITION');
    expect(answer.error?.details?.timer).toEqual(started.timer);
  });

  it('a repeated pause is a successful no-op: no new version, no new event', async () => {
    const { roomId, hostSocket, guestSocket } = await setup();
    const guestEvents = recordEvents<TimerEvent>(guestSocket, 'room:timer:state');
    await timerCommand(hostSocket, roomId, { type: 'start' });
    const paused = await timerCommand(hostSocket, roomId, { type: 'pause' });
    await eventually(() => guestEvents.length === 2);

    const again = await timerCommand(hostSocket, roomId, { type: 'pause' });

    expect(again.ok).toBe(true);
    expect(again.timer?.version).toBe(paused.timer?.version);
    await probeRoom((body) => kit.send(hostSocket, roomId, body), guestSocket);
    expect(guestEvents).toHaveLength(2);
  });

  it('rejects a malformed command or payload', async () => {
    const { roomId, hostSocket } = await setup();
    for (const payload of [
      { roomId, command: { type: 'explode' } },
      { roomId, command: { type: 'start', extra: 1 } },
      { roomId, command: { type: 'reset' } },
      { roomId: 'nope', command: { type: 'start' } },
      { roomId },
      'start',
    ]) {
      const answer = await new Promise<{ ok: boolean; error?: { code: string } }>((resolve) => {
        hostSocket.emit('room:timer:command', payload, resolve);
      });
      expect(answer.error?.code).toBe('VALIDATION_FAILED');
    }
    expect((await currentTimer(kit.harness().runtime, roomId)).status).toBe('idle');
  });

  it('limits a user to 20 commands per 10 seconds', async () => {
    const { roomId, hostSocket } = await setup();
    const codes: (string | undefined)[] = [];
    for (let attempt = 0; attempt < 21; attempt += 1) {
      const answer = await timerCommand(hostSocket, roomId, { type: 'start' });
      codes.push(answer.ok ? 'ok' : answer.error?.code);
    }
    expect(codes[0]).toBe('ok');
    expect(codes.slice(1, 20).every((code) => code === 'INVALID_TRANSITION')).toBe(true);
    expect(codes[20]).toBe('RATE_LIMITED');
  });
});

describe('who may command', () => {
  it('a member who is not the host gets NOT_HOST and nothing changes or leaks', async () => {
    const { roomId, guestSocket, hostSocket } = await setup();
    const hostEvents = recordEvents<TimerEvent>(hostSocket, 'room:timer:state');

    const answer = await timerCommand(guestSocket, roomId, { type: 'start' });

    expect(answer).toEqual({
      ok: false,
      error: { code: 'NOT_HOST', message: expect.any(String) as string },
    });
    expect((await currentTimer(kit.harness().runtime, roomId)).status).toBe('idle');
    await probeRoom((body) => kit.send(guestSocket, roomId, body), hostSocket);
    expect(hostEvents).toEqual([]);
  });

  it('a socket that has not joined the room gets NOT_JOINED, even the host’s own user', async () => {
    const { host, roomId } = await setup();
    const loose = await kit.connect(host);

    const answer = await timerCommand(loose, roomId, { type: 'start' });

    expect(answer.error?.code).toBe('NOT_JOINED');
    expect((await currentTimer(kit.harness().runtime, roomId)).status).toBe('idle');
  });

  it('a stranger who is no member gets NOT_JOINED and learns nothing about the timer', async () => {
    const { roomId } = await setup();
    const stranger = await kit.newUser('stranger');
    const socket = await kit.connect(stranger);

    const answer = await timerCommand(socket, roomId, { type: 'start' });

    expect(answer).toEqual({
      ok: false,
      error: { code: 'NOT_JOINED', message: expect.any(String) as string },
    });
    // And a join is refused as well.
    expect((await kit.join(socket, roomId)).error?.code).toBe('NOT_A_MEMBER');
  });

  it('a command for another room than the one the socket joined is NOT_JOINED', async () => {
    const { host, roomId: roomA } = await setup();
    const hostSocket = await kit.connect(host);
    await kit.joinOk(hostSocket, roomA);
    // The same user hosts a second room but this socket only joined the first.
    const roomB = await kit.createRoom(host);

    const answer = await timerCommand(hostSocket, roomB, { type: 'start' });

    expect(answer.error?.code).toBe('NOT_JOINED');
    expect((await currentTimer(kit.harness().runtime, roomB)).status).toBe('idle');
  });

  it('the host of room B cannot command room A even when joined to both', async () => {
    const a = await setup();
    const hostB = await kit.newUser('host-b');
    const roomB = await kit.createRoom(hostB);
    await kit.joinMembership(hostB, a.roomId);
    const socket = await kit.connect(hostB);
    await kit.joinOk(socket, a.roomId);
    await kit.joinOk(socket, roomB);

    expect((await timerCommand(socket, a.roomId, { type: 'start' })).error?.code).toBe('NOT_HOST');
    expect(await timerCommand(socket, roomB, { type: 'start' })).toMatchObject({ ok: true });
    expect((await currentTimer(kit.harness().runtime, a.roomId)).status).toBe('idle');
  });

  it('events of one room never reach the members of another', async () => {
    const a = await setup();
    const b = await setup();
    const aEvents = recordEvents<TimerEvent>(a.guestSocket, 'room:timer:state');
    const bEvents = recordEvents<TimerEvent>(b.guestSocket, 'room:timer:state');
    const bHostEvents = recordEvents<TimerEvent>(b.hostSocket, 'room:timer:state');

    await timerCommand(a.hostSocket, a.roomId, { type: 'start' });
    await eventually(() => aEvents.length === 1);
    await probeRoom((body) => kit.send(b.hostSocket, b.roomId, body), b.guestSocket);

    expect(aEvents[0]?.roomId).toBe(a.roomId);
    expect(bEvents).toEqual([]);
    expect(bHostEvents).toEqual([]);
  });

  it('a host who leaves the room stops being able to command it', async () => {
    const { roomId, hostSocket } = await setup();
    expect(await timerCommand(hostSocket, roomId, { type: 'start' })).toMatchObject({ ok: true });
    await new Promise((resolve) => hostSocket.emit('room:leave', { roomId }, resolve));

    expect((await timerCommand(hostSocket, roomId, { type: 'pause' })).error?.code).toBe(
      'NOT_JOINED',
    );
    expect((await currentTimer(kit.harness().runtime, roomId)).status).toBe('running');
  });
});

describe('host disconnect', () => {
  it('a running timer keeps running and a rejoin sees it (D10)', async () => {
    const { host, roomId, hostSocket, guestSocket } = await setup();
    const started = await timerCommand(hostSocket, roomId, { type: 'start' });
    hostSocket.disconnect();
    await eventually(async () => (await kit.redisEntries(roomId, host.userId)).length === 0);

    const snapshot = roomSnapshotSchema.parse((await kit.joinOk(guestSocket, roomId)).snapshot);
    expect(snapshot.timer).toEqual(started.timer);
    const back = await kit.connect(host);
    expect(roomSnapshotSchema.parse((await kit.joinOk(back, roomId)).snapshot).timer).toEqual(
      started.timer,
    );
  });
});

describe('failures while joining', () => {
  it('a failed timer read leaves no half-joined socket, and a retry succeeds', async () => {
    const guest = await kit.newUser('guest');
    const host = await kit.newUser('host');
    const roomId = await kit.createRoom(host);
    await kit.joinMembership(guest, roomId);
    const socket = await kit.connect(guest);
    const { service } = kit.harness().runtime.roomTimer;
    const mutable = service as { get: typeof service.get };
    const original = mutable.get;
    mutable.get = () => Promise.reject(new Error('Redis blip'));
    try {
      const answer = await kit.join(socket, roomId);
      expect(answer.ok).toBe(false);
      expect(answer.error?.code).toBe('INTERNAL');
    } finally {
      mutable.get = original;
    }

    const instance = kit.harness().runtime;
    expect(instance.io.of('/').adapter.rooms.get(`room:${roomId}`)?.size ?? 0).toBe(0);
    await eventually(async () => (await kit.redisEntries(roomId, guest.userId)).length === 0);

    expect(await kit.join(socket, roomId)).toMatchObject({ ok: true });
    await eventually(async () => (await kit.redisEntries(roomId, guest.userId)).length === 1);
  });
});

describe('a hanging scheduler', () => {
  it('delays the event and the acknowledgement by at most the bound, then emits', async () => {
    const { roomId, hostSocket, guestSocket } = await setup();
    const guestEvents = recordEvents<TimerEvent>(guestSocket, 'room:timer:state');
    const { scheduler } = kit.harness().runtime.roomTimer;
    const mutable = scheduler as { ensurePhaseEnd: typeof scheduler.ensurePhaseEnd };
    const original = mutable.ensurePhaseEnd;
    mutable.ensurePhaseEnd = () => new Promise(() => undefined);
    try {
      const startedAt = Date.now();
      const answer = await timerCommand(hostSocket, roomId, { type: 'start' });
      expect(answer.ok).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(3_500);
      await eventually(() => guestEvents.length === 1);
    } finally {
      mutable.ensurePhaseEnd = original;
    }
  });
});
