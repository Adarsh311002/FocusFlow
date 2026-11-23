import { PHASE_END_JOB, phaseEndJobId } from '@focus-flow/contracts';
import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';

import { createRoomTimerScheduler, processRoomTimerJob, type SchedulableQueue } from './jobs.js';
import type { PhaseEndOutcome } from './types.js';

// Job identity, scheduling delay, ensure semantics and payload validation, without Redis.

const ROOM = '01a0ed0d-55de-7d1b-8495-82fb5050d815';

type Added = { name: string; data: unknown; options: { jobId: string; delay: number } };

const fakeQueue = (states: string[] = ['unknown']) => {
  const added: Added[] = [];
  const retries: { state: string; opts: unknown }[] = [];
  const queue: SchedulableQueue = {
    getJobState: () => Promise.resolve(states.shift() ?? 'unknown'),
    getJob: () =>
      Promise.resolve({
        retry: (state, opts) => {
          retries.push({ state, opts });
          return Promise.resolve();
        },
      }),
    add: (name, data, options) => {
      added.push({ name, data, options });
      return Promise.resolve({});
    },
  };
  return { queue, added, retries };
};

describe('phase-end job id', () => {
  it('derives from room and version and never contains ":"', () => {
    expect(phaseEndJobId(ROOM, 7)).not.toContain(':');
    expect(phaseEndJobId(ROOM, 7)).toBe(phaseEndJobId(ROOM, 7));
    expect(phaseEndJobId(ROOM, 7)).not.toBe(phaseEndJobId(ROOM, 8));
  });
});

describe('scheduler', () => {
  it('adds the job delayed to endsAtMs minus the Redis time of the change', async () => {
    const { queue, added } = fakeQueue();
    const outcome = await createRoomTimerScheduler(queue).ensurePhaseEnd(
      ROOM,
      12,
      1_000_000 + 25 * 60_000,
      1_000_000,
    );
    expect(outcome).toBe('added');
    expect(added).toEqual([
      {
        name: PHASE_END_JOB,
        data: { schemaVersion: 1, roomId: ROOM, version: 12 },
        options: { jobId: phaseEndJobId(ROOM, 12), delay: 25 * 60_000 },
      },
    ]);
  });

  it('never uses a negative delay', async () => {
    const { queue, added } = fakeQueue();
    await createRoomTimerScheduler(queue).ensurePhaseEnd(ROOM, 1, 500, 1_000);
    expect(added[0]?.options.delay).toBe(0);
  });

  it('leaves a pending job alone', async () => {
    for (const state of ['waiting', 'delayed', 'active']) {
      const { queue, added, retries } = fakeQueue([state]);
      expect(await createRoomTimerScheduler(queue).ensurePhaseEnd(ROOM, 1, 10, 0)).toBe('pending');
      expect(added).toEqual([]);
      expect(retries).toEqual([]);
    }
  });

  it('re-runs a retained finished job with its attempts reset', async () => {
    for (const state of ['completed', 'failed']) {
      const { queue, added, retries } = fakeQueue([state]);
      expect(await createRoomTimerScheduler(queue).ensurePhaseEnd(ROOM, 1, 10, 0)).toBe('retried');
      expect(added).toEqual([]);
      expect(retries).toEqual([
        { state, opts: { resetAttemptsMade: true, resetAttemptsStarted: true } },
      ]);
    }
  });
});

describe('processRoomTimerJob', () => {
  const outcome: PhaseEndOutcome = { result: 'noop' };

  it('asks the service with the payload version and returns its outcome', async () => {
    const calls: [string, number][] = [];
    const result = await processRoomTimerJob(
      {
        completePhase: (roomId, version) => {
          calls.push([roomId, version]);
          return Promise.resolve(outcome);
        },
      },
      PHASE_END_JOB,
      { schemaVersion: 1, roomId: ROOM, version: 9 },
    );
    expect(result).toBe(outcome);
    expect(calls).toEqual([[ROOM, 9]]);
  });

  it('discards a malformed payload or an unknown job without retries', async () => {
    const service = { completePhase: () => Promise.resolve(outcome) };
    for (const data of [
      undefined,
      {},
      { schemaVersion: 2, roomId: ROOM, version: 1 },
      { schemaVersion: 1, roomId: 'nope', version: 1 },
      { schemaVersion: 1, roomId: ROOM, version: -1 },
      { schemaVersion: 1, roomId: ROOM, version: 1, extra: true },
    ]) {
      await expect(processRoomTimerJob(service, PHASE_END_JOB, data)).rejects.toBeInstanceOf(
        UnrecoverableError,
      );
    }
    await expect(
      processRoomTimerJob(service, 'other', { schemaVersion: 1, roomId: ROOM, version: 1 }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('lets a service failure through so BullMQ retries with backoff', async () => {
    await expect(
      processRoomTimerJob(
        { completePhase: () => Promise.reject(new Error('redis down')) },
        PHASE_END_JOB,
        { schemaVersion: 1, roomId: ROOM, version: 1 },
      ),
    ).rejects.toThrow('redis down');
  });
});
