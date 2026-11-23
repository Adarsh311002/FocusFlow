import { randomUUID } from 'node:crypto';

import { phaseEndJobId } from '@focus-flow/contracts';
import type { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  craftRunning,
  currentTimer,
  probeRoom,
  timerCommand,
  type TimerEvent,
} from '../../../test/room-timer.js';
import { closeAllSockets, eventually, recordEvents } from '../../../test/sockets.js';
import { createRedisConnection } from '../../platform/redis.js';
import { createRoomKit } from '../room-realtime/room-test-kit.js';
import { createRoomTimerQueue, createRoomTimerScheduler, createRoomTimerWorker } from './jobs.js';
import type { PhaseEndOutcome, RoomTimerService } from './types.js';

// Phase-end jobs and the reconciler's repairs against real PostgreSQL, Redis, BullMQ and
// sockets (RT4, RT12, RT13). A phase end is made near by writing the timer through the
// store with a short `durationMs` (the shortest real phase is 60 s); the real worker fires.

const kit = createRoomKit();
const connections: Redis[] = [];
const closers: (() => Promise<void>)[] = [];

beforeAll(async () => {
  await kit.start();
}, 180_000);

afterEach(async () => {
  closeAllSockets();
  for (const close of closers.splice(0)) {
    await close();
  }
  for (const connection of connections.splice(0)) {
    connection.disconnect();
  }
});

afterAll(async () => {
  await kit.stop();
}, 60_000);

const runtime = () => kit.harness().runtime;

const setup = async () => {
  const host = await kit.newUser('host');
  const guest = await kit.newUser('guest');
  const roomId = await kit.createRoom(host);
  await kit.joinMembership(guest, roomId);
  const hostSocket = await kit.connect(host);
  const guestSocket = await kit.connect(guest, kit.second());
  await kit.joinOk(hostSocket, roomId);
  await kit.joinOk(guestSocket, roomId);
  const hostEvents = recordEvents<TimerEvent>(hostSocket, 'room:timer:state');
  const guestEvents = recordEvents<TimerEvent>(guestSocket, 'room:timer:state');
  return { roomId, hostSocket, guestSocket, hostEvents, guestEvents };
};

/** Crafts a running timer and ensures its job like the change listener would. */
const craftWithJob = async (roomId: string, durationMs: number, endsInMs: number) => {
  const crafted = await craftRunning(runtime(), roomId, { durationMs, endsInMs });
  await runtime().roomTimer.scheduler.ensurePhaseEnd(
    roomId,
    crafted.state.version,
    crafted.endsAtMs,
    crafted.nowMs,
  );
  return crafted;
};

const jobState = (roomId: string, version: number) =>
  runtime().roomTimer.queue.getJobState(phaseEndJobId(roomId, version));

describe('phase end by the worker', () => {
  it('advances to an idle break, broadcasts it to every client, and schedules nothing more', async () => {
    const { roomId, hostEvents, guestEvents } = await setup();
    const crafted = await craftWithJob(roomId, 1_500, 1_500);

    await eventually(() => hostEvents.length >= 1 && guestEvents.length >= 1, 15_000);

    for (const events of [hostEvents, guestEvents]) {
      expect(events).toHaveLength(1);
      expect(events[0]?.timer).toMatchObject({
        phase: 'short_break',
        status: 'idle',
        durationMs: 300_000,
        elapsedBeforeMs: 0,
        segmentStartedAtMs: null,
        endsAtMs: null,
        version: crafted.state.version + 1,
      });
    }
    expect(guestEvents[0]?.timer).toEqual(hostEvents[0]?.timer);
    expect(await currentTimer(runtime(), roomId)).toMatchObject({
      phase: 'short_break',
      status: 'idle',
      version: crafted.state.version + 1,
    });
    expect(await runtime().redis.zscore('rooms:timers:running', roomId)).toBeNull();
  });

  it('advances the same version exactly once when two deliveries race', async () => {
    const { roomId, guestEvents, hostSocket, guestSocket } = await setup();
    const crafted = await craftRunning(runtime(), roomId, { durationMs: 1_000, endsInMs: -2_000 });
    const { service } = runtime().roomTimer;

    const outcomes = await Promise.all([
      service.completePhase(roomId, crafted.state.version),
      service.completePhase(roomId, crafted.state.version),
      service.completePhase(roomId, crafted.state.version),
    ]);

    expect(outcomes.filter((outcome) => outcome.result === 'advanced')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.result === 'noop')).toHaveLength(2);
    expect(await currentTimer(runtime(), roomId)).toMatchObject({
      phase: 'short_break',
      version: crafted.state.version + 1,
    });
    await eventually(() => guestEvents.length >= 1);
    await probeRoom((body) => kit.send(hostSocket, roomId, body), guestSocket);
    expect(guestEvents).toHaveLength(1);
  });

  it('a job for an older version does nothing after pause, resume or reset', async () => {
    const { roomId, hostSocket } = await setup();
    const crafted = await craftWithJob(roomId, 1_500, 1_500);
    // The host pauses before zero: the job of the running version is now stale.
    const paused = await timerCommand(hostSocket, roomId, { type: 'pause' });
    expect(paused.ok).toBe(true);

    // The stale job runs when its time comes and finishes without effect.
    await eventually(
      async () => (await jobState(roomId, crafted.state.version)) === 'completed',
      20_000,
    );

    expect(await currentTimer(runtime(), roomId)).toMatchObject({
      phase: 'focus',
      status: 'paused',
      version: paused.timer?.version,
    });
    expect(await runtime().roomTimer.service.completePhase(roomId, crafted.state.version)).toEqual({
      result: 'noop',
    });
  });

  it('a job that fires early goes back to sleep and ends the phase on time', async () => {
    const { roomId, guestEvents } = await setup();
    // The job is told 0.3 s but the phase really ends in 8 s.
    const crafted = await craftRunning(runtime(), roomId, { durationMs: 8_000, endsInMs: 8_000 });
    await runtime().roomTimer.scheduler.ensurePhaseEnd(
      roomId,
      crafted.state.version,
      crafted.nowMs + 300,
      crafted.nowMs,
    );

    // The job ran early (it was processed) and went back to the delayed set; the phase is
    // still running and nothing was announced.
    await eventually(async () => {
      const job = await runtime().roomTimer.queue.getJob(
        phaseEndJobId(roomId, crafted.state.version),
      );
      return (
        job?.processedOn !== undefined &&
        (await jobState(roomId, crafted.state.version)) === 'delayed'
      );
    }, 15_000);
    expect(await currentTimer(runtime(), roomId)).toMatchObject({
      status: 'running',
      version: crafted.state.version,
    });

    await eventually(() => guestEvents.length === 1, 30_000);
    expect(guestEvents[0]?.timer).toMatchObject({
      phase: 'short_break',
      version: crafted.state.version + 1,
    });
  });

  it('re-delivering a retained finished job runs it again (E20) without effect on a settled timer', async () => {
    const { roomId } = await setup();
    const crafted = await craftWithJob(roomId, 1_000, 1_000);
    await eventually(
      async () => (await jobState(roomId, crafted.state.version)) === 'completed',
      15_000,
    );

    const outcome = await runtime().roomTimer.scheduler.ensurePhaseEnd(
      roomId,
      crafted.state.version,
      crafted.endsAtMs,
      crafted.nowMs,
    );

    expect(outcome).toBe('retried');
    await eventually(async () => (await jobState(roomId, crafted.state.version)) === 'completed');
    expect(await currentTimer(runtime(), roomId)).toMatchObject({
      phase: 'short_break',
      version: crafted.state.version + 1,
    });
  });

  it('retries with backoff after a transient failure and still ends the phase once', async () => {
    const { roomId, guestEvents } = await setup();
    // A queue and worker of their own (own key prefix), so the runtime's worker is not involved.
    const config = {
      ...kit.harness().config,
      REDIS_KEY_PREFIX: `ff-rt-${randomUUID().slice(0, 8)}:`,
    };
    const queueConnection = createRedisConnection(config, runtime().logger, 'bullmq');
    const workerConnection = createRedisConnection(config, runtime().logger, 'bullmq');
    connections.push(queueConnection, workerConnection);
    const queue = createRoomTimerQueue(queueConnection, config);
    const real = runtime().roomTimer.service;
    let calls = 0;
    const flaky: Pick<RoomTimerService, 'completePhase'> = {
      completePhase: (id, version): Promise<PhaseEndOutcome> => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error('transient Redis failure'))
          : real.completePhase(id, version);
      },
    };
    const worker = createRoomTimerWorker({
      connection: workerConnection,
      config,
      logger: runtime().logger,
      service: flaky,
    });
    closers.push(async () => {
      await worker.close();
      await queue.close();
    });
    void worker.run();
    const crafted = await craftRunning(runtime(), roomId, { durationMs: 1_000, endsInMs: 500 });

    await createRoomTimerScheduler(queue).ensurePhaseEnd(
      roomId,
      crafted.state.version,
      crafted.endsAtMs,
      crafted.nowMs,
    );

    await eventually(() => guestEvents.length === 1, 20_000);
    expect(calls).toBe(2);
    expect(guestEvents[0]?.timer.version).toBe(crafted.state.version + 1);
  });
});

describe('change listener', () => {
  it('schedules the phase-end job of a started timer before the acknowledgement', async () => {
    const { roomId, hostSocket } = await setup();

    const started = await timerCommand(hostSocket, roomId, { type: 'start' });

    const version = started.timer?.version ?? -1;
    expect(['delayed', 'waiting', 'active']).toContain(await jobState(roomId, version));
    const job = await runtime().roomTimer.queue.getJob(phaseEndJobId(roomId, version));
    expect(job?.data).toEqual({ schemaVersion: 1, roomId, version });
    // About 25 minutes by the Redis clock of the change.
    expect(job?.opts.delay).toBeGreaterThan(1_499_000);
    expect(job?.opts.delay).toBeLessThanOrEqual(1_500_000);
  });
});

describe('a failing scheduler', () => {
  it('does not fail the command or the event, and the reconciler recreates the job', async () => {
    const { roomId, hostSocket, guestEvents } = await setup();
    const { scheduler } = runtime().roomTimer;
    const mutable = scheduler as { ensurePhaseEnd: typeof scheduler.ensurePhaseEnd };
    const original = mutable.ensurePhaseEnd;
    mutable.ensurePhaseEnd = () => Promise.reject(new Error('Redis blip'));
    let started: Awaited<ReturnType<typeof timerCommand>>;
    try {
      started = await timerCommand(hostSocket, roomId, { type: 'start' });
    } finally {
      mutable.ensurePhaseEnd = original;
    }
    const version = started.timer?.version ?? -1;

    expect(started).toMatchObject({ ok: true, timer: { status: 'running' } });
    await eventually(() => guestEvents.length === 1);
    expect(guestEvents[0]?.timer.version).toBe(version);
    expect(await jobState(roomId, version)).toBe('unknown');

    const summary = await runtime().reconciler.run({
      schemaVersion: 1,
      trigger: 'startup',
      correlationId: 'test',
    });

    expect(summary.roomTimers?.jobsRepaired).toBeGreaterThanOrEqual(1);
    expect(await jobState(roomId, version)).toBe('delayed');
  });
});

describe('reconciler step 2', () => {
  const reconcile = () =>
    runtime().reconciler.run({ schemaVersion: 1, trigger: 'startup', correlationId: 'test' });

  it('advances a running timer past its end whose job is gone', async () => {
    const { roomId, guestEvents } = await setup();
    const crafted = await craftRunning(runtime(), roomId, { durationMs: 1_000, endsInMs: -5_000 });
    expect(await jobState(roomId, crafted.state.version)).toBe('unknown');

    const summary = await reconcile();

    expect(summary.roomTimers?.advanced).toBeGreaterThanOrEqual(1);
    expect(await currentTimer(runtime(), roomId)).toMatchObject({
      phase: 'short_break',
      status: 'idle',
      version: crafted.state.version + 1,
    });
    await eventually(() => guestEvents.length === 1);
    expect(guestEvents[0]?.timer.version).toBe(crafted.state.version + 1);
  });

  it('recreates the missing job of a running timer', async () => {
    const { roomId, hostSocket } = await setup();
    const started = await timerCommand(hostSocket, roomId, { type: 'start' });
    const version = started.timer?.version ?? -1;
    await runtime().roomTimer.queue.remove(phaseEndJobId(roomId, version));
    expect(await jobState(roomId, version)).toBe('unknown');

    const summary = await reconcile();

    expect(summary.roomTimers?.jobsRepaired).toBeGreaterThanOrEqual(1);
    expect(await jobState(roomId, version)).toBe('delayed');
    expect((await currentTimer(runtime(), roomId)).status).toBe('running');
  });

  it('leaves a healthy running timer and its pending job alone', async () => {
    const { roomId, hostSocket } = await setup();
    const started = await timerCommand(hostSocket, roomId, { type: 'start' });
    const version = started.timer?.version ?? -1;

    const summary = await reconcile();

    expect(summary.roomTimers?.failed).toBe(0);
    expect(await jobState(roomId, version)).toBe('delayed');
    expect(await currentTimer(runtime(), roomId)).toMatchObject({ status: 'running', version });
  });

  it('stale members of the running index do not starve a due timer (one run)', async () => {
    const { roomId, guestEvents } = await setup();
    const stale = Array.from({ length: 120 }, () => randomUUID());
    // Scores far in the past: they sort before every real timer, and their hashes are absent.
    await runtime().redis.zadd(
      'rooms:timers:running',
      ...stale.flatMap((id, index) => [String(1 + index), id]),
    );
    const crafted = await craftRunning(runtime(), roomId, { durationMs: 1_000, endsInMs: -5_000 });

    const summary = await reconcile();

    expect(summary.roomTimers?.advanced).toBeGreaterThanOrEqual(1);
    expect(await currentTimer(runtime(), roomId)).toMatchObject({
      phase: 'short_break',
      version: crafted.state.version + 1,
    });
    await eventually(() => guestEvents.length === 1);
    // The poisoned entries were cleared, not just skipped.
    for (const id of stale) {
      expect(await runtime().redis.zscore('rooms:timers:running', id)).toBeNull();
    }
  });
});
