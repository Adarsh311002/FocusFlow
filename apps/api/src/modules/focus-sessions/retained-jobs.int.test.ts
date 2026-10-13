import { randomUUID } from 'node:crypto';

import {
  FOCUS_SESSION_QUEUE,
  SOLO_GRACE_JOB,
  type SoloEndJob,
  type SoloGraceJob,
  soloGraceJobSchema,
} from '@focus-flow/contracts';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { startTestHarness, stopTestHarness, type TestHarness } from '../../../test/harness.js';
import { scriptedSnapshot } from '../../../test/snapshots.js';
import { signUpTestUser } from '../../../test/users.js';
import { focusSessions } from '../../db/schema.js';
import { bullmqPrefix } from '../../platform/queues.js';
import {
  createRedisClient,
  createRedisConnection,
  redisTimeMs,
  waitForRedisReady,
} from '../../platform/redis.js';
import { createFocusSessionChanges, type FocusSessionChange } from './changes.js';
import { PRESENCE_RECOVERY_MS } from './decision.js';
import {
  createFocusSessionScheduler,
  createFocusSessionWorker,
  type FocusSessionJob,
  soloEndJobId,
  soloGraceJobId,
} from './jobs.js';
import { type LifecycleDeps, runSoloEndJob, runSoloGraceJob } from './lifecycle.js';
import { createDisconnectMarkerStore, type DisconnectMarkerStore } from './marker-store.js';

// Retained BullMQ jobs (E20) with a real worker running the real end and grace processors
// against real PostgreSQL and Redis. BullMQ keeps finished jobs (removeOnComplete /
// removeOnFail), and `queue.add` with a retained id is a silent no-op; scheduling therefore
// ensures the job: a retained completed or failed job runs again, its attempts reset.
// Presence and the epoch are scripted; jobs here get 2 attempts so exhaustion is quick.

const GRACE_MS = 60_000;
const MINUTE = 60_000;
const ATTEMPTS = 2;

let harness: TestHarness | undefined;
let markers: DisconnectMarkerStore | undefined;
const connections: Redis[] = [];
const closers: (() => Promise<void>)[] = [];

const requireHarness = (): TestHarness => {
  if (harness === undefined) {
    throw new Error('the harness failed to start');
  }
  return harness;
};

const requireMarkers = (): DisconnectMarkerStore => {
  if (markers === undefined) {
    throw new Error('the marker store failed to start');
  }
  return markers;
};

const nowMs = () => redisTimeMs(requireHarness().redis);

type Presence = { online: boolean } | 'unavailable';

/**
 * A queue (own prefix) with a real worker running the real processors, counting every
 * processor execution. `presenceFor(run)` scripts the presence the n-th run sees.
 */
const rig = (presenceFor: (run: number) => Presence) => {
  const h = requireHarness();
  const config = { ...h.config, REDIS_KEY_PREFIX: `ff-rj-${randomUUID().slice(0, 8)}:` };
  const queueConnection = createRedisConnection(config, h.runtime.logger, 'bullmq');
  const workerConnection = createRedisConnection(config, h.runtime.logger, 'bullmq');
  connections.push(queueConnection, workerConnection);
  const queue = new Queue<FocusSessionJob>(FOCUS_SESSION_QUEUE, {
    connection: queueConnection,
    prefix: bullmqPrefix(config),
    defaultJobOptions: {
      attempts: ATTEMPTS,
      backoff: { type: 'fixed', delay: 20 },
      removeOnComplete: 1_000,
      removeOnFail: 1_000,
    },
  });
  const scheduler = createFocusSessionScheduler({
    queue,
    graceMs: GRACE_MS,
    redisNowMs: nowMs,
  });
  const published: FocusSessionChange[] = [];
  const changes = createFocusSessionChanges(pino({ level: 'silent' }));
  changes.subscribe((change) => {
    published.push(change);
  });
  let runs = 0;
  let current: Presence = 'unavailable';
  const checkUser = async () => {
    if (current === 'unavailable') {
      throw new Error('Redis is down');
    }
    return { online: current.online, checkedAtMs: await nowMs(), epochCreatedAtMs: 0 };
  };
  const deps: LifecycleDeps = {
    db: h.db,
    markers: requireMarkers(),
    checkUser,
    snapshotUser: scriptedSnapshot(checkUser, requireMarkers()),
    presenceRecoveryMs: PRESENCE_RECOVERY_MS,
    graceMs: GRACE_MS,
    scheduler,
    changes,
  };
  const counted =
    <J>(processor: (deps: LifecycleDeps, job: J) => ReturnType<typeof runSoloEndJob>) =>
    (job: J) => {
      runs += 1;
      current = presenceFor(runs);
      return processor(deps, job);
    };
  const worker = createFocusSessionWorker({
    connection: workerConnection,
    config,
    logger: pino({ level: 'silent' }),
    processors: {
      end: counted<SoloEndJob>(runSoloEndJob),
      grace: counted<SoloGraceJob>(runSoloGraceJob),
    },
  });
  void worker.run();
  closers.push(async () => {
    await worker.close();
    await queue.close();
  });
  return { queue, scheduler, published, runs: () => runs };
};

/** Polls the job's state until it is one of `states` (BullMQ moves jobs asynchronously). */
const settledState = async (
  queue: Queue<FocusSessionJob>,
  jobId: string,
  states: readonly string[] = ['completed', 'failed'],
): Promise<string> => {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const state = await queue.getJobState(jobId);
    if (states.includes(state)) {
      return state;
    }
    if (Date.now() > deadline) {
      throw new Error(`job ${jobId} stayed ${state}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** A user's 60-second session whose stretch began 3 minutes ago (T_end 2 minutes ago). */
const pastEndSession = async () => {
  const h = requireHarness();
  const user = await signUpTestUser(h, 'retained');
  const startedAt = new Date((await nowMs()) - 3 * MINUTE);
  const [row] = await h.db
    .insert(focusSessions)
    .values({
      id: randomUUID(),
      userId: user.userId,
      status: 'in_progress',
      plannedSeconds: 60,
      focusedSeconds: 0,
      runningSince: startedAt,
      startedAt,
    })
    .returning();
  if (row === undefined) {
    throw new Error('no session row');
  }
  const runningSinceMs = startedAt.getTime();
  return {
    userId: user.userId,
    sessionId: row.id,
    runningSinceMs,
    plannedEndMs: runningSinceMs + 60_000,
  };
};

type Session = Awaited<ReturnType<typeof pastEndSession>>;

/** Records an observed disconnect 30 s before T_end (no E8 proof); its grace is long over. */
const disconnectBeforeEnd = async (s: Session): Promise<number> => {
  const t = s.plannedEndMs - 30_000;
  await requireMarkers().record(
    s.userId,
    { sessionId: s.sessionId, disconnectedAtMs: t, evidence: 'observed' },
    s.runningSinceMs,
  );
  return t;
};

const rowOf = async (sessionId: string) => {
  const [row] = await requireHarness()
    .db.select()
    .from(focusSessions)
    .where(eq(focusSessions.id, sessionId));
  return row;
};

/** Schedules the grace job and lets it exhaust its attempts while presence is unavailable. */
const exhaustedGraceJob = async (r: ReturnType<typeof rig>, s: Session, t: number) => {
  await r.scheduler.scheduleGrace({
    sessionId: s.sessionId,
    userId: s.userId,
    disconnectedAtMs: t,
  });
  const jobId = soloGraceJobId(s.sessionId, t);
  expect(await settledState(r.queue, jobId)).toBe('failed');
  expect((await r.queue.getJob(jobId))?.attemptsMade).toBe(ATTEMPTS);
  expect(r.runs()).toBe(ATTEMPTS);
  return jobId;
};

beforeAll(async () => {
  // No workers: the runtime's own reconciler would otherwise also decide these sessions.
  harness = await startTestHarness({ ROLE: 'api' });
  const redis = createRedisClient(harness.config, harness.runtime.logger);
  connections.push(redis);
  await waitForRedisReady(redis, 10_000);
  markers = createDisconnectMarkerStore({ redis });
}, 180_000);

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close();
  }
});

afterAll(async () => {
  for (const connection of connections) {
    connection.disconnect();
  }
  if (harness !== undefined) {
    await stopTestHarness(harness);
  }
}, 60_000);

describe('a retained failed job whose attempts are exhausted', () => {
  it('a plain add is a no-op; ensuring it runs the processor again and settles grace_expired', async () => {
    const r = rig((run) => (run <= ATTEMPTS ? 'unavailable' : { online: false }));
    const s = await pastEndSession();
    const t = await disconnectBeforeEnd(s);
    const jobId = await exhaustedGraceJob(r, s, t);

    // The silent no-op this decision fixes.
    await r.queue.add(
      SOLO_GRACE_JOB,
      soloGraceJobSchema.parse({
        schemaVersion: 1,
        sessionId: s.sessionId,
        userId: s.userId,
        disconnectedAtMs: t,
      }),
      { jobId },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await r.queue.getJobState(jobId)).toBe('failed');
    expect(r.runs()).toBe(ATTEMPTS);

    await r.scheduler.scheduleGrace({
      sessionId: s.sessionId,
      userId: s.userId,
      disconnectedAtMs: t,
    });
    expect(await settledState(r.queue, jobId)).toBe('completed');
    expect(r.runs()).toBe(ATTEMPTS + 1);
    expect((await r.queue.getJob(jobId))?.returnvalue).toEqual({
      kind: 'settled',
      transition: 'grace_expired',
    });
    const row = await rowOf(s.sessionId);
    expect(row).toMatchObject({ status: 'abandoned', abandonReason: 'grace_expired' });
    expect(row?.endedAt?.getTime()).toBe(t);
    expect(r.published.map((change) => change.transition)).toEqual(['grace_expired']);
  });

  it('online again: the re-run grace job applies E16 and completes at T_end', async () => {
    const r = rig((run) => (run <= ATTEMPTS ? 'unavailable' : { online: true }));
    const s = await pastEndSession();
    const t = await disconnectBeforeEnd(s);
    const jobId = await exhaustedGraceJob(r, s, t);

    await r.scheduler.scheduleGrace({
      sessionId: s.sessionId,
      userId: s.userId,
      disconnectedAtMs: t,
    });
    expect(await settledState(r.queue, jobId)).toBe('completed');
    expect(r.runs()).toBe(ATTEMPTS + 1);
    const row = await rowOf(s.sessionId);
    expect(row).toMatchObject({ status: 'completed', focusedSeconds: 60 });
    expect(row?.endedAt?.getTime()).toBe(s.plannedEndMs);
    expect(r.published.map((change) => change.transition)).toEqual(['completed']);
  });

  it('gets all its attempts back: a failure right after the re-run is retried again', async () => {
    // Runs 1–2 exhaust the job; run 3 (the re-run) fails too; run 4 can decide. Without
    // the reset, run 3 would have been its last attempt.
    const r = rig((run) => (run <= ATTEMPTS + 1 ? 'unavailable' : { online: false }));
    const s = await pastEndSession();
    const t = await disconnectBeforeEnd(s);
    const jobId = await exhaustedGraceJob(r, s, t);

    await r.scheduler.scheduleGrace({
      sessionId: s.sessionId,
      userId: s.userId,
      disconnectedAtMs: t,
    });
    expect(await settledState(r.queue, jobId)).toBe('completed');
    expect(r.runs()).toBe(ATTEMPTS + 2);
    expect((await r.queue.getJob(jobId))?.attemptsMade).toBe(2);
    expect((await rowOf(s.sessionId))?.abandonReason).toBe('grace_expired');
  });

  it('an exhausted end job runs again when ensured and completes an online user at T_end', async () => {
    const r = rig((run) => (run <= ATTEMPTS ? 'unavailable' : { online: true }));
    const s = await pastEndSession();
    const end = { sessionId: s.sessionId, userId: s.userId, runningSinceMs: s.runningSinceMs };
    await r.scheduler.scheduleEnd({ ...end, plannedEndMs: s.plannedEndMs });
    const jobId = soloEndJobId(s.sessionId, s.runningSinceMs);
    expect(await settledState(r.queue, jobId)).toBe('failed');

    await r.scheduler.scheduleEnd({ ...end, plannedEndMs: s.plannedEndMs });
    expect(await settledState(r.queue, jobId)).toBe('completed');
    expect(r.runs()).toBe(ATTEMPTS + 1);
    expect(await rowOf(s.sessionId)).toMatchObject({ status: 'completed', focusedSeconds: 60 });
    expect(r.published.map((change) => change.transition)).toEqual(['completed']);
  });
});

describe('a retained completed job', () => {
  it('runs again when its disconnect is recorded again, and settles', async () => {
    const r = rig(() => ({ online: false }));
    const s = await pastEndSession();
    const t = s.plannedEndMs - 30_000;
    // The grace job ran while no marker held its disconnect: a no-op, retained as completed.
    await r.scheduler.scheduleGrace({
      sessionId: s.sessionId,
      userId: s.userId,
      disconnectedAtMs: t,
    });
    const jobId = soloGraceJobId(s.sessionId, t);
    expect(await settledState(r.queue, jobId)).toBe('completed');
    expect((await r.queue.getJob(jobId))?.returnvalue).toEqual({
      kind: 'no_op',
      reason: 'marker_changed',
    });

    // The same disconnect is recorded again (for example a replayed instance_dead hint).
    await disconnectBeforeEnd(s);
    await r.scheduler.scheduleGrace({
      sessionId: s.sessionId,
      userId: s.userId,
      disconnectedAtMs: t,
    });
    // The ensure moved it back to wait before returning; this is the re-run finishing.
    expect(await settledState(r.queue, jobId)).toBe('completed');
    expect(r.runs()).toBe(2);
    expect((await rowOf(s.sessionId))?.abandonReason).toBe('grace_expired');
    expect(r.published.map((change) => change.transition)).toEqual(['grace_expired']);
  });
});

describe('concurrent ensures', () => {
  it('re-run a retained failed job exactly once and settle it once', async () => {
    const r = rig((run) => (run <= ATTEMPTS ? 'unavailable' : { online: false }));
    const s = await pastEndSession();
    const t = await disconnectBeforeEnd(s);
    const jobId = await exhaustedGraceJob(r, s, t);

    await Promise.all(
      Array.from({ length: 5 }, () =>
        r.scheduler.scheduleGrace({
          sessionId: s.sessionId,
          userId: s.userId,
          disconnectedAtMs: t,
        }),
      ),
    );
    expect(await settledState(r.queue, jobId)).toBe('completed');
    // Give any duplicate execution time to show up.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(r.runs()).toBe(ATTEMPTS + 1);
    expect(r.published.map((change) => change.transition)).toEqual(['grace_expired']);
  });
});

describe('jobs that will still run, and trimmed jobs', () => {
  it('leaves a delayed job alone and adds a job whose record was trimmed', async () => {
    const r = rig(() => ({ online: false }));
    const s = await pastEndSession();
    // A disconnect a moment ago: its grace job waits about a minute.
    const t = await nowMs();
    await r.scheduler.scheduleGrace({
      sessionId: s.sessionId,
      userId: s.userId,
      disconnectedAtMs: t,
    });
    const jobId = soloGraceJobId(s.sessionId, t);
    expect(await r.queue.getJobState(jobId)).toBe('delayed');
    await r.scheduler.scheduleGrace({
      sessionId: s.sessionId,
      userId: s.userId,
      disconnectedAtMs: t,
    });
    expect(await r.queue.getJobState(jobId)).toBe('delayed');
    expect(await r.queue.getJobCounts('delayed', 'waiting', 'completed', 'failed')).toEqual({
      delayed: 1,
      waiting: 0,
      completed: 0,
      failed: 0,
    });
    expect(r.runs()).toBe(0);

    // A finished job trimmed from the retained set is simply added again.
    await (await r.queue.getJob(jobId))?.remove();
    expect(await r.queue.getJobState(jobId)).toBe('unknown');
    await r.scheduler.scheduleGrace({
      sessionId: s.sessionId,
      userId: s.userId,
      disconnectedAtMs: t,
    });
    expect(await r.queue.getJobState(jobId)).toBe('delayed');
  });
});
