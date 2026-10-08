import { SOLO_END_JOB, SOLO_GRACE_JOB } from '@focus-flow/contracts';
import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';

import {
  createFocusSessionScheduler,
  type FocusSessionProcessors,
  type FocusSessionQueue,
  processFocusSessionJob,
  soloEndJobId,
  soloGraceJobId,
} from './jobs.js';

// Job identity, payload validation and wake-up delays, without Redis.

const SESSION = '01a0ed0d-55de-7d1b-8495-82fb5050d815';
const USER = '01a0ed0d-55de-7d1b-8495-82fb5050d816';

type Added = { name: string; data: unknown; opts: { jobId?: string; delay?: number } };

const fakeQueue = () => {
  const added: Added[] = [];
  const queue = {
    add: (name: string, data: unknown, opts: Added['opts']) => {
      added.push({ name, data, opts });
      return Promise.resolve({});
    },
  } as unknown as FocusSessionQueue;
  return { queue, added };
};

describe('job ids', () => {
  it('derive from the stretch or the disconnect and never contain ":"', () => {
    for (const id of [
      soloEndJobId(SESSION, 1_791_000_000_000),
      soloEndJobId(SESSION, 1_791_000_000_000, 1_791_000_100_000),
      soloGraceJobId(SESSION, 1_791_000_000_000),
    ]) {
      expect(id).not.toContain(':');
    }
    expect(soloEndJobId(SESSION, 1)).toBe(soloEndJobId(SESSION, 1));
    expect(soloEndJobId(SESSION, 1)).not.toBe(soloEndJobId(SESSION, 2));
    expect(soloEndJobId(SESSION, 1, 5)).not.toBe(soloEndJobId(SESSION, 1));
    expect(soloGraceJobId(SESSION, 1)).not.toBe(soloGraceJobId(SESSION, 2));
  });
});

describe('scheduler', () => {
  it('wakes the end job at T_end by the host clock, and a reconnect re-decision at once', async () => {
    const { queue, added } = fakeQueue();
    const scheduler = createFocusSessionScheduler({
      queue,
      graceMs: 60_000,
      redisNowMs: () => Promise.resolve(0),
      hostNowMs: () => 1_000_000,
    });
    await scheduler.scheduleEnd({
      sessionId: SESSION,
      userId: USER,
      runningSinceMs: 900_000,
      plannedEndMs: 1_250_000,
    });
    await scheduler.scheduleEnd({
      sessionId: SESSION,
      userId: USER,
      runningSinceMs: 900_000,
      plannedEndMs: 1_250_000,
      reconnectAtMs: 1_000_500,
    });
    expect(added).toEqual([
      {
        name: SOLO_END_JOB,
        data: { schemaVersion: 1, sessionId: SESSION, userId: USER, runningSinceMs: 900_000 },
        opts: { jobId: soloEndJobId(SESSION, 900_000), delay: 250_000 },
      },
      {
        name: SOLO_END_JOB,
        data: { schemaVersion: 1, sessionId: SESSION, userId: USER, runningSinceMs: 900_000 },
        opts: { jobId: soloEndJobId(SESSION, 900_000, 1_000_500), delay: 0 },
      },
    ]);
  });

  it('wakes the grace job when the grace ends by Redis TIME (never a negative delay)', async () => {
    const { queue, added } = fakeQueue();
    let redisNow = 5_000;
    const scheduler = createFocusSessionScheduler({
      queue,
      graceMs: 60_000,
      redisNowMs: () => Promise.resolve(redisNow),
    });
    await scheduler.scheduleGrace({ sessionId: SESSION, userId: USER, disconnectedAtMs: 4_000 });
    redisNow = 100_000;
    await scheduler.scheduleGrace({ sessionId: SESSION, userId: USER, disconnectedAtMs: 4_000 });
    expect(added.map((entry) => entry.opts)).toEqual([
      { jobId: soloGraceJobId(SESSION, 4_000), delay: 59_000 },
      { jobId: soloGraceJobId(SESSION, 4_000), delay: 0 },
    ]);
    expect(added[0]?.name).toBe(SOLO_GRACE_JOB);
  });
});

describe('processFocusSessionJob', () => {
  const processors: FocusSessionProcessors = {
    end: () => Promise.resolve({ kind: 'continued' }),
    grace: () => Promise.resolve({ kind: 'late_grace' }),
  };

  it('dispatches valid payloads by job name', async () => {
    expect(
      await processFocusSessionJob(processors, SOLO_END_JOB, {
        schemaVersion: 1,
        sessionId: SESSION,
        userId: USER,
        runningSinceMs: 1,
      }),
    ).toEqual({ kind: 'continued' });
    expect(
      await processFocusSessionJob(processors, SOLO_GRACE_JOB, {
        schemaVersion: 1,
        sessionId: SESSION,
        userId: USER,
        disconnectedAtMs: 1,
      }),
    ).toEqual({ kind: 'late_grace' });
  });

  it('fails an unknown job or an invalid payload without retries', async () => {
    await expect(processFocusSessionJob(processors, 'solo-start', {})).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    await expect(
      processFocusSessionJob(processors, SOLO_END_JOB, { schemaVersion: 2 }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(
      processFocusSessionJob(processors, SOLO_GRACE_JOB, {
        schemaVersion: 1,
        sessionId: SESSION,
        userId: USER,
        runningSinceMs: 1,
      }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });
});
