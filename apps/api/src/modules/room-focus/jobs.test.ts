import { ROOM_GRACE_JOB, roomGraceJobId, roomGraceJobSchema } from '@focus-flow/contracts';
import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';

import { processFocusSessionJob } from '../focus-sessions/jobs.js';
import { createRoomGraceProcessor, createRoomGraceScheduler, type RoomGraceQueue } from './jobs.js';
import type { RoomFocusService } from './types.js';

// Room grace job identity, ensure semantics, dispatch and outcome mapping, without Redis.

const ROOM = '01a0ed0d-55de-7d1b-8495-82fb5050d801';
const RUN = '01a0ed0d-55de-7d1b-8495-82fb5050d802';
const USER = '01a0ed0d-55de-7d1b-8495-82fb5050d803';
const PAYLOAD = roomGraceJobSchema.parse({
  schemaVersion: 1,
  roomId: ROOM,
  focusRunId: RUN,
  userId: USER,
  disconnectedAtMs: 1_791_000_000_000,
});
const JOB = {
  roomId: PAYLOAD.roomId,
  focusRunId: PAYLOAD.focusRunId,
  userId: PAYLOAD.userId,
  disconnectedAtMs: PAYLOAD.disconnectedAtMs,
};

type Added = { name: string; data: unknown; opts: { jobId: string; delay: number } };

const fakeQueue = (state: string = 'unknown') => {
  const added: Added[] = [];
  const retried: { state: string; options: unknown }[] = [];
  const queue: RoomGraceQueue = {
    getJobState: () => Promise.resolve(state),
    getJob: () =>
      Promise.resolve({
        retry: (retryState, options) => {
          retried.push({ state: retryState, options });
          return Promise.resolve();
        },
      }),
    add: (name, data, opts) => {
      added.push({ name, data, opts });
      return Promise.resolve({});
    },
  };
  return { queue, added, retried };
};

describe('room grace scheduler', () => {
  it('adds a deterministic job with the remaining grace as its delay', async () => {
    const { queue, added } = fakeQueue();
    await createRoomGraceScheduler(queue).ensureGrace(JOB, 42_000);
    const jobId = `room-grace_${ROOM}_${RUN}_${USER}_1791000000000`;
    expect(jobId).toBe(roomGraceJobId({ schemaVersion: 1, ...JOB }));
    expect(jobId).not.toContain(':');
    expect(added).toEqual([
      {
        name: ROOM_GRACE_JOB,
        data: { schemaVersion: 1, ...JOB },
        opts: { jobId, delay: 42_000 },
      },
    ]);
  });

  it('never uses a negative or fractional delay', async () => {
    const { queue, added } = fakeQueue();
    const scheduler = createRoomGraceScheduler(queue);
    await scheduler.ensureGrace(JOB, -5);
    await scheduler.ensureGrace(JOB, 1_000.2);
    expect(added.map((job) => job.opts.delay)).toEqual([0, 1_001]);
  });

  it('leaves a pending job alone and re-runs a retained finished one (E20)', async () => {
    for (const pending of ['waiting', 'delayed', 'active']) {
      const { queue, added, retried } = fakeQueue(pending);
      await createRoomGraceScheduler(queue).ensureGrace(JOB, 1_000);
      expect(added).toEqual([]);
      expect(retried).toEqual([]);
    }
    for (const finished of ['completed', 'failed']) {
      const { queue, added, retried } = fakeQueue(finished);
      await createRoomGraceScheduler(queue).ensureGrace(JOB, 1_000);
      expect(added).toEqual([]);
      expect(retried).toEqual([
        { state: finished, options: { resetAttemptsMade: true, resetAttemptsStarted: true } },
      ]);
    }
  });

  it('rejects a payload that is not a room grace job', async () => {
    const { queue } = fakeQueue();
    await expect(
      createRoomGraceScheduler(queue).ensureGrace({ ...JOB, userId: 'not-a-uuid' }, 0),
    ).rejects.toThrow();
  });
});

const serviceReturning = (result: string, calls: unknown[][] = []) =>
  ({
    graceExpired: (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve(result);
    },
  }) as unknown as Pick<RoomFocusService, 'graceExpired'>;

describe('room grace processor', () => {
  it('asks the service about exactly the job it was given and maps the answer', async () => {
    const expected = {
      abandoned: { kind: 'settled', transition: 'grace_expired' },
      completed: { kind: 'settled', transition: 'completed' },
      reconnected: { kind: 'continued' },
      stale: { kind: 'no_op', reason: 'marker_changed' },
    } as const;
    for (const [answer, outcome] of Object.entries(expected)) {
      const calls: unknown[][] = [];
      const process = createRoomGraceProcessor(serviceReturning(answer, calls));
      expect(await process({ schemaVersion: 1, ...JOB })).toEqual(outcome);
      expect(calls).toEqual([[ROOM, RUN, USER, JOB.disconnectedAtMs]]);
    }
  });

  it('lets a service failure fail the job so BullMQ retries it', async () => {
    const process = createRoomGraceProcessor({
      graceExpired: () => Promise.reject(new Error('postgres down')),
    });
    await expect(process({ schemaVersion: 1, ...JOB })).rejects.toThrow('postgres down');
  });
});

describe('focus-session worker dispatch', () => {
  const processors = (roomGrace?: Parameters<typeof processFocusSessionJob>[0]['roomGrace']) => ({
    end: () => Promise.reject(new Error('unexpected solo-end')),
    grace: () => Promise.reject(new Error('unexpected solo-grace')),
    ...(roomGrace === undefined ? {} : { roomGrace }),
  });

  it('sends room-grace jobs to the room processor', async () => {
    const seen: unknown[] = [];
    const outcome = await processFocusSessionJob(
      processors((job) => {
        seen.push(job);
        return Promise.resolve({ kind: 'continued' });
      }),
      ROOM_GRACE_JOB,
      { schemaVersion: 1, ...JOB },
    );
    expect(outcome).toEqual({ kind: 'continued' });
    expect(seen).toEqual([{ schemaVersion: 1, ...JOB }]);
  });

  it('fails an invalid payload once, without retries', async () => {
    await expect(
      processFocusSessionJob(
        processors(() => Promise.resolve({ kind: 'continued' })),
        ROOM_GRACE_JOB,
        {
          schemaVersion: 1,
          roomId: ROOM,
        },
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('fails once when this process has no room processor', async () => {
    await expect(
      processFocusSessionJob(processors(), ROOM_GRACE_JOB, { schemaVersion: 1, ...JOB }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });
});
