import { randomUUID } from 'node:crypto';

import {
  FOCUS_SESSION_QUEUE,
  focusSessionIdSchema,
  SOLO_END_JOB,
  SOLO_GRACE_JOB,
  soloEndJobSchema,
  soloGraceJobSchema,
} from '@focus-flow/contracts';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestHarness, stopTestHarness, type TestHarness } from '../../../test/harness.js';
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
import {
  CLOCK_SKEW_TOLERANCE_MS,
  type DisconnectMarker,
  PRESENCE_RECOVERY_MS,
} from './decision.js';
import {
  createFocusSessionQueue,
  createFocusSessionWorker,
  type FocusSessionProcessors,
  soloGraceJobId,
} from './jobs.js';
import {
  type FocusSessionScheduler,
  type LifecycleDeps,
  RetryLaterError,
  runSoloEndJob,
  runSoloGraceJob,
} from './lifecycle.js';
import { createDisconnectMarkerStore, type DisconnectMarkerStore } from './marker-store.js';
import { type FocusSessionsDeps, pauseFocusSession, stopFocusSession } from './service.js';

// The solo end and grace jobs against real PostgreSQL and Redis (decisions E7–E10, E16).
// Presence and the epoch are scripted per test so every branch and race is deterministic;
// the session rows, the marker store and the timing are real.

const GRACE_MS = 60_000;
const MINUTE = 60_000;

let harness: TestHarness | undefined;
const connections: Redis[] = [];
let markers: DisconnectMarkerStore | undefined;

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

type Presence = { online: boolean; checkedAtMs: number } | 'unavailable';

/** One scripted world per test: presence, epoch, scheduled jobs and published changes. */
const world = () => {
  const state: { presence: Presence; epochCreatedAtMs: number | undefined } = {
    presence: 'unavailable',
    epochCreatedAtMs: 0,
  };
  const scheduled: { kind: 'end' | 'grace'; job: object }[] = [];
  const published: FocusSessionChange[] = [];
  const scheduler: FocusSessionScheduler = {
    scheduleEnd: (job) => {
      scheduled.push({ kind: 'end', job });
      return Promise.resolve();
    },
    scheduleGrace: (job) => {
      scheduled.push({ kind: 'grace', job });
      return Promise.resolve();
    },
  };
  const changes = createFocusSessionChanges(pino({ level: 'silent' }));
  changes.subscribe((change) => {
    published.push(change);
  });
  const deps: LifecycleDeps = {
    db: requireHarness().db,
    markers: requireMarkers(),
    checkUser: () =>
      state.presence === 'unavailable'
        ? Promise.reject(new Error('Redis is down'))
        : Promise.resolve({ ...state.presence, epochCreatedAtMs: state.epochCreatedAtMs }),
    presenceRecoveryMs: PRESENCE_RECOVERY_MS,
    graceMs: GRACE_MS,
    scheduler,
    changes,
  };
  return { state, scheduled, published, deps };
};

const nowMs = () => redisTimeMs(requireHarness().redis);

/** A user with a running solo session whose stretch began `ranForMs` ago. */
const runningSession = async (plannedSeconds: number, ranForMs: number) => {
  const h = requireHarness();
  const user = await signUpTestUser(h, 'lifecycle');
  const startedAt = new Date(Math.floor((await nowMs()) - ranForMs));
  const [row] = await h.db
    .insert(focusSessions)
    .values({
      id: randomUUID(),
      userId: user.userId,
      status: 'in_progress',
      plannedSeconds,
      focusedSeconds: 0,
      runningSince: startedAt,
      startedAt,
    })
    .returning();
  if (row === undefined) {
    throw new Error('no session row');
  }
  return {
    userId: user.userId,
    sessionId: row.id,
    runningSinceMs: startedAt.getTime(),
    plannedEndMs: startedAt.getTime() + plannedSeconds * 1_000,
  };
};

const sessionRow = async (sessionId: string) => {
  const [row] = await requireHarness()
    .db.select()
    .from(focusSessions)
    .where(eq(focusSessions.id, sessionId));
  return row;
};

const marker = (
  sessionId: string,
  disconnectedAtMs: number,
  evidence: DisconnectMarker['evidence'],
): DisconnectMarker => ({ sessionId, disconnectedAtMs, evidence });

const endJob = (s: { sessionId: string; userId: string; runningSinceMs: number }) =>
  soloEndJobSchema.parse({
    schemaVersion: 1,
    sessionId: s.sessionId,
    userId: s.userId,
    runningSinceMs: s.runningSinceMs,
  });

const graceJob = (s: { sessionId: string; userId: string }, disconnectedAtMs: number) =>
  soloGraceJobSchema.parse({
    schemaVersion: 1,
    sessionId: s.sessionId,
    userId: s.userId,
    disconnectedAtMs,
  });

beforeAll(async () => {
  harness = await startTestHarness();
  const redis = createRedisClient(harness.config, harness.runtime.logger);
  connections.push(redis);
  await waitForRedisReady(redis, 10_000);
  markers = createDisconnectMarkerStore({ redis });
}, 180_000);

afterAll(async () => {
  for (const connection of connections) {
    connection.disconnect();
  }
  if (harness !== undefined) {
    await stopTestHarness(harness);
  }
}, 60_000);

describe('solo end job', () => {
  it('does nothing for a missing, paused, ended or re-stretched session', async () => {
    const { deps } = world();
    const s = await runningSession(60, 5 * MINUTE);

    expect(
      await runSoloEndJob(deps, { ...endJob(s), runningSinceMs: s.runningSinceMs + 1 }),
    ).toEqual({ kind: 'no_op', reason: 'stretch_changed' });
    expect(
      await runSoloEndJob(deps, {
        ...endJob(s),
        sessionId: focusSessionIdSchema.parse(randomUUID()),
      }),
    ).toEqual({
      kind: 'no_op',
      reason: 'session_gone',
    });
    await requireHarness()
      .db.update(focusSessions)
      .set({ runningSince: null, focusedSeconds: 30 })
      .where(eq(focusSessions.id, s.sessionId));
    expect(await runSoloEndJob(deps, endJob(s))).toEqual({ kind: 'no_op', reason: 'not_running' });
  });

  it('goes back to sleep until T_end when it runs early', async () => {
    const { deps } = world();
    const s = await runningSession(1_500, MINUTE);
    const outcome = await runSoloEndJob(deps, endJob(s));
    expect(outcome.kind).toBe('wake_later');
    if (outcome.kind === 'wake_later') {
      expect(outcome.delayMs).toBeGreaterThan(23 * MINUTE);
      expect(outcome.delayMs).toBeLessThanOrEqual(24 * MINUTE);
    }
    expect((await sessionRow(s.sessionId))?.status).toBe('in_progress');
  });

  it('online at the end with no recorded disconnect: completes at T_end, F = P', async () => {
    const { deps, state, published } = world();
    const s = await runningSession(60, 3 * MINUTE);
    state.presence = { online: true, checkedAtMs: await nowMs() };

    expect(await runSoloEndJob(deps, endJob(s))).toEqual({
      kind: 'settled',
      transition: 'completed',
    });
    const row = await sessionRow(s.sessionId);
    expect(row).toMatchObject({ status: 'completed', focusedSeconds: 60, runningSince: null });
    expect(row?.endedAt?.getTime()).toBe(s.plannedEndMs);
    expect(published.map((change) => change.transition)).toEqual(['completed']);

    // Run twice: the second run finds nothing to do.
    expect(await runSoloEndJob(deps, endJob(s))).toEqual({ kind: 'no_op', reason: 'not_running' });
    expect(published).toHaveLength(1);
  });

  it('an observed disconnect at or after T_end proves presence through the end (E8)', async () => {
    const { deps, state } = world();
    const s = await runningSession(60, 3 * MINUTE);
    await requireMarkers().record(
      s.userId,
      marker(s.sessionId, s.plannedEndMs - CLOCK_SKEW_TOLERANCE_MS, 'observed'),
      s.runningSinceMs,
    );
    state.presence = { online: false, checkedAtMs: await nowMs() };

    expect(await runSoloEndJob(deps, endJob(s))).toEqual({
      kind: 'settled',
      transition: 'completed',
    });
  });

  it('a detected disconnect after T_end never completes: it hands over to the grace (E10)', async () => {
    const { deps, state, scheduled } = world();
    const s = await runningSession(60, 3 * MINUTE);
    const detectedAt = s.plannedEndMs + 30_000;
    await requireMarkers().record(
      s.userId,
      marker(s.sessionId, detectedAt, 'detected'),
      s.runningSinceMs,
    );
    state.presence = { online: false, checkedAtMs: detectedAt + 10_000 };

    expect(await runSoloEndJob(deps, endJob(s))).toEqual({ kind: 'waiting_for_grace' });
    expect((await sessionRow(s.sessionId))?.status).toBe('in_progress');
    expect(scheduled).toEqual([
      {
        kind: 'grace',
        job: { sessionId: s.sessionId, userId: s.userId, disconnectedAtMs: detectedAt },
      },
    ]);
  });

  it('offline with no marker: late grace with a detected marker at the check time (H3)', async () => {
    const { deps, state, scheduled } = world();
    const s = await runningSession(60, 3 * MINUTE);
    const checkedAtMs = await nowMs();
    state.presence = { online: false, checkedAtMs };

    expect(await runSoloEndJob(deps, endJob(s))).toEqual({ kind: 'late_grace' });
    expect(await requireMarkers().read(s.userId)).toEqual(
      marker(s.sessionId, checkedAtMs, 'detected'),
    );
    expect(scheduled).toEqual([
      {
        kind: 'grace',
        job: { sessionId: s.sessionId, userId: s.userId, disconnectedAtMs: checkedAtMs },
      },
    ]);
    expect((await sessionRow(s.sessionId))?.status).toBe('in_progress');
  });

  it('offline with no marker after a definite Redis loss: expired, keeping the time before the stretch (E9)', async () => {
    const { deps, state } = world();
    const s = await runningSession(60, 3 * MINUTE);
    state.presence = { online: false, checkedAtMs: await nowMs() };
    state.epochCreatedAtMs = s.runningSinceMs + CLOCK_SKEW_TOLERANCE_MS + 1;

    expect(await runSoloEndJob(deps, endJob(s))).toEqual({
      kind: 'settled',
      transition: 'expired',
    });
    expect(await sessionRow(s.sessionId)).toMatchObject({
      status: 'abandoned',
      abandonReason: 'expired',
      focusedSeconds: 0,
    });
  });

  it('online with a disconnect still recorded: never completes, hands over to its grace job (E8, E16)', async () => {
    const { deps, state, scheduled, published } = world();
    const s = await runningSession(60, 10 * MINUTE);
    const t = s.plannedEndMs - 30_000; // left before the end; the online hint was lost
    await requireMarkers().record(s.userId, marker(s.sessionId, t, 'detected'), s.runningSinceMs);
    state.presence = { online: true, checkedAtMs: await nowMs() };

    expect(await runSoloEndJob(deps, endJob(s))).toEqual({ kind: 'waiting_for_grace' });
    expect(await sessionRow(s.sessionId)).toMatchObject({ status: 'in_progress' });
    expect(published).toEqual([]);
    // The marker stays for the grace job of exactly that disconnect, which applies E16.
    expect(await requireMarkers().read(s.userId)).toEqual(marker(s.sessionId, t, 'detected'));
    expect(scheduled).toEqual([
      { kind: 'grace', job: { sessionId: s.sessionId, userId: s.userId, disconnectedAtMs: t } },
    ]);
    expect(await runSoloGraceJob(deps, graceJob(s, t))).toEqual({
      kind: 'settled',
      transition: 'completed',
    });
    const row = await sessionRow(s.sessionId);
    expect(row).toMatchObject({ status: 'completed', focusedSeconds: 60 });
    expect(row?.endedAt?.getTime()).toBe(s.plannedEndMs);
  });

  it('online with no marker after a definite Redis loss: expired, never completed (E9)', async () => {
    const { deps, state } = world();
    const s = await runningSession(60, 3 * MINUTE);
    state.presence = { online: true, checkedAtMs: await nowMs() };
    state.epochCreatedAtMs = s.runningSinceMs + CLOCK_SKEW_TOLERANCE_MS + 1;

    expect(await runSoloEndJob(deps, endJob(s))).toEqual({
      kind: 'settled',
      transition: 'expired',
    });
    expect(await sessionRow(s.sessionId)).toMatchObject({
      status: 'abandoned',
      abandonReason: 'expired',
      focusedSeconds: 0,
    });
  });

  it('online with no marker and an unknown epoch: decides nothing (H2)', async () => {
    const { deps, state } = world();
    const s = await runningSession(60, 3 * MINUTE);
    state.presence = { online: true, checkedAtMs: await nowMs() };
    state.epochCreatedAtMs = undefined;

    await expect(runSoloEndJob(deps, endJob(s))).rejects.toBeInstanceOf(RetryLaterError);
    expect(await sessionRow(s.sessionId)).toMatchObject({ status: 'in_progress' });
  });

  it('decides nothing when presence or the epoch is unknown, and writes nothing', async () => {
    const { deps, state } = world();
    const s = await runningSession(60, 3 * MINUTE);
    state.presence = 'unavailable';
    await expect(runSoloEndJob(deps, endJob(s))).rejects.toBeInstanceOf(RetryLaterError);

    state.presence = { online: false, checkedAtMs: await nowMs() };
    state.epochCreatedAtMs = undefined;
    await expect(runSoloEndJob(deps, endJob(s))).rejects.toBeInstanceOf(RetryLaterError);
    expect((await sessionRow(s.sessionId))?.status).toBe('in_progress');
    expect(await requireMarkers().read(s.userId)).toBeUndefined();
  });

  it('settles an expired grace from the current marker, clamped to T_end', async () => {
    const { deps, state } = world();
    const s = await runningSession(1_500, 30 * MINUTE);
    const disconnectedAt = s.runningSinceMs + 10 * MINUTE + 700;
    await requireMarkers().record(
      s.userId,
      marker(s.sessionId, disconnectedAt, 'observed'),
      s.runningSinceMs,
    );
    state.presence = { online: false, checkedAtMs: disconnectedAt + GRACE_MS + 1 };

    expect(await runSoloEndJob(deps, endJob(s))).toEqual({
      kind: 'settled',
      transition: 'grace_expired',
    });
    const row = await sessionRow(s.sessionId);
    expect(row).toMatchObject({ abandonReason: 'grace_expired', focusedSeconds: 600 });
    expect(row?.endedAt?.getTime()).toBe(disconnectedAt);
  });

  it('treats a marker from before the current stretch as absent, and clears it', async () => {
    const { deps, state } = world();
    const s = await runningSession(60, 3 * MINUTE);
    // Recorded for this session with an older stretch, then left behind.
    await requireMarkers().record(
      s.userId,
      marker(s.sessionId, s.runningSinceMs - 10_000, 'observed'),
      s.runningSinceMs - 60_000,
    );
    state.presence = { online: true, checkedAtMs: await nowMs() };

    expect(await runSoloEndJob(deps, endJob(s))).toEqual({
      kind: 'settled',
      transition: 'completed',
    });
    expect(await requireMarkers().read(s.userId)).toBeUndefined();
  });
});

describe('solo grace job', () => {
  it('does nothing unless the marker still holds exactly its session and disconnect', async () => {
    const { deps, state } = world();
    const s = await runningSession(1_500, MINUTE);
    const t = (await nowMs()) - 1_000;
    state.presence = { online: false, checkedAtMs: t + GRACE_MS + 1 };

    expect(await runSoloGraceJob(deps, graceJob(s, t))).toEqual({
      kind: 'no_op',
      reason: 'marker_changed',
    });
    await requireMarkers().record(
      s.userId,
      marker(s.sessionId, t + 5, 'detected'),
      s.runningSinceMs,
    );
    expect(await runSoloGraceJob(deps, graceJob(s, t))).toEqual({
      kind: 'no_op',
      reason: 'marker_changed',
    });
    expect((await sessionRow(s.sessionId))?.status).toBe('in_progress');
  });

  it('a stale job for an ended session does nothing to the next session’s marker', async () => {
    const { deps, state } = world();
    const first = await runningSession(1_500, MINUTE);
    const t = (await nowMs()) - 1_000;
    await requireHarness()
      .db.update(focusSessions)
      .set({
        status: 'abandoned',
        abandonReason: 'stopped',
        runningSince: null,
        endedAt: new Date(),
      })
      .where(eq(focusSessions.id, first.sessionId));
    // The same user's next session now owns the marker.
    const nextId = randomUUID();
    await requireHarness()
      .db.insert(focusSessions)
      .values({
        id: nextId,
        userId: first.userId,
        status: 'in_progress',
        plannedSeconds: 1_500,
        focusedSeconds: 0,
        runningSince: new Date(t - 500),
        startedAt: new Date(t - 500),
      });
    await requireMarkers().record(first.userId, marker(nextId, t, 'observed'), t - 500);
    state.presence = { online: false, checkedAtMs: t + GRACE_MS + 1 };

    expect(await runSoloGraceJob(deps, graceJob(first, t))).toEqual({
      kind: 'no_op',
      reason: 'not_running',
    });
    expect(await requireMarkers().read(first.userId)).toEqual(marker(nextId, t, 'observed'));
    expect((await sessionRow(nextId))?.status).toBe('in_progress');
  });

  it('online before T_end: a reconnect within grace — clears the marker and keeps running', async () => {
    const { deps, state, published } = world();
    const s = await runningSession(1_500, MINUTE);
    const t = (await nowMs()) - 5_000;
    await requireMarkers().record(s.userId, marker(s.sessionId, t, 'observed'), s.runningSinceMs);
    state.presence = { online: true, checkedAtMs: t + 3_000 };

    expect(await runSoloGraceJob(deps, graceJob(s, t))).toEqual({ kind: 'continued' });
    expect(await requireMarkers().read(s.userId)).toBeUndefined();
    expect((await sessionRow(s.sessionId))?.status).toBe('in_progress');
    expect(published).toEqual([]);
  });

  it('a late grace job finding the user online after T_end completes at T_end (E16)', async () => {
    const { deps, state } = world();
    const s = await runningSession(60, 10 * MINUTE);
    const t = s.plannedEndMs - 30_000; // left before the end; reconnect time unknown
    await requireMarkers().record(s.userId, marker(s.sessionId, t, 'detected'), s.runningSinceMs);
    state.presence = { online: true, checkedAtMs: t + 5 * MINUTE };

    expect(await runSoloGraceJob(deps, graceJob(s, t))).toEqual({
      kind: 'settled',
      transition: 'completed',
    });
    const row = await sessionRow(s.sessionId);
    expect(row?.endedAt?.getTime()).toBe(s.plannedEndMs);
  });

  it('E16 is no evidence about a Redis loss: the late grace job then expires the session (E9)', async () => {
    const { deps, state } = world();
    const s = await runningSession(60, 10 * MINUTE);
    const t = s.plannedEndMs - 30_000;
    await requireMarkers().record(s.userId, marker(s.sessionId, t, 'detected'), s.runningSinceMs);
    state.presence = { online: true, checkedAtMs: await nowMs() };
    state.epochCreatedAtMs = s.runningSinceMs + CLOCK_SKEW_TOLERANCE_MS + 1;

    expect(await runSoloGraceJob(deps, graceJob(s, t))).toEqual({
      kind: 'settled',
      transition: 'expired',
    });
  });

  it('offline inside the grace: sleeps until the grace ends (Redis TIME)', async () => {
    const { deps, state } = world();
    const s = await runningSession(1_500, MINUTE);
    const t = (await nowMs()) - 5_000;
    await requireMarkers().record(s.userId, marker(s.sessionId, t, 'observed'), s.runningSinceMs);
    state.presence = { online: false, checkedAtMs: t + 20_000 };

    expect(await runSoloGraceJob(deps, graceJob(s, t))).toEqual({
      kind: 'wake_later',
      delayMs: 40_000,
    });
    expect((await sessionRow(s.sessionId))?.status).toBe('in_progress');
  });

  it('offline when the grace ends: abandoned(grace_expired) at the disconnect; then idempotent', async () => {
    const { deps, state, published } = world();
    const s = await runningSession(1_500, 5 * MINUTE);
    const t = s.runningSinceMs + 2 * MINUTE + 999;
    await requireMarkers().record(s.userId, marker(s.sessionId, t, 'observed'), s.runningSinceMs);
    state.presence = { online: false, checkedAtMs: t + GRACE_MS };

    expect(await runSoloGraceJob(deps, graceJob(s, t))).toEqual({
      kind: 'settled',
      transition: 'grace_expired',
    });
    const row = await sessionRow(s.sessionId);
    expect(row).toMatchObject({ abandonReason: 'grace_expired', focusedSeconds: 120 });
    expect(row?.endedAt?.getTime()).toBe(t);
    expect(await runSoloGraceJob(deps, graceJob(s, t))).toEqual({
      kind: 'no_op',
      reason: 'not_running',
    });
    expect(published.map((change) => change.transition)).toEqual(['grace_expired']);
  });
});

describe('races', () => {
  it('an end job and a grace job racing settle the session exactly once', async () => {
    for (let round = 0; round < 10; round += 1) {
      const { deps, state, published } = world();
      const s = await runningSession(60, 5 * MINUTE);
      const t = s.plannedEndMs - 30_000;
      await requireMarkers().record(s.userId, marker(s.sessionId, t, 'observed'), s.runningSinceMs);
      state.presence = { online: false, checkedAtMs: t + GRACE_MS + 1 };

      const outcomes = await Promise.all([
        runSoloEndJob(deps, endJob(s)),
        runSoloGraceJob(deps, graceJob(s, t)),
      ]);
      expect(outcomes.filter((outcome) => outcome.kind === 'settled')).toHaveLength(1);
      expect(published).toHaveLength(1);
      expect((await sessionRow(s.sessionId))?.abandonReason).toBe('grace_expired');
    }
  });

  it('duplicate grace jobs settle once', async () => {
    const { deps, state, published } = world();
    const s = await runningSession(1_500, 5 * MINUTE);
    const t = s.runningSinceMs + MINUTE;
    await requireMarkers().record(s.userId, marker(s.sessionId, t, 'observed'), s.runningSinceMs);
    state.presence = { online: false, checkedAtMs: t + GRACE_MS };

    await Promise.all(Array.from({ length: 5 }, () => runSoloGraceJob(deps, graceJob(s, t))));
    expect(published).toHaveLength(1);
  });
});

describe('pause or stop against the end job (E7, E9)', () => {
  /** The REST service on the same scripted world as the jobs. */
  const serviceDeps = ({ deps }: ReturnType<typeof world>): FocusSessionsDeps => ({
    db: deps.db,
    checkUser: deps.checkUser,
    presenceRecoveryMs: deps.presenceRecoveryMs,
    markers: deps.markers,
    graceMs: deps.graceMs,
    changes: deps.changes,
  });

  const request = (
    w: ReturnType<typeof world>,
    verb: 'pause' | 'stop',
    s: { sessionId: string; userId: string },
  ) =>
    (verb === 'pause' ? pauseFocusSession : stopFocusSession)(
      serviceDeps(w),
      s.userId,
      s.sessionId,
    );

  /** A session past T_end whose stretch began before the current epoch: a definite loss. */
  const afterRedisLoss = async (w: ReturnType<typeof world>, online: boolean) => {
    const s = await runningSession(60, 3 * MINUTE);
    w.state.presence = { online, checkedAtMs: await nowMs() };
    w.state.epochCreatedAtMs = s.runningSinceMs + CLOCK_SKEW_TOLERANCE_MS + 1;
    return s;
  };

  const expectExpiredOnce = async (
    w: ReturnType<typeof world>,
    s: { sessionId: string },
  ): Promise<void> => {
    expect(await sessionRow(s.sessionId)).toMatchObject({
      status: 'abandoned',
      abandonReason: 'expired',
      focusedSeconds: 0,
    });
    expect(w.published.map((change) => change.transition)).toEqual(['expired']);
  };

  it('after a definite Redis loss, the request expires the session as the end job would', async () => {
    for (const verb of ['pause', 'stop'] as const) {
      for (const online of [true, false]) {
        const w = world();
        const s = await afterRedisLoss(w, online);

        const view = await request(w, verb, s);
        expect(view).toMatchObject({ status: 'abandoned', abandonReason: 'expired' });
        await expectExpiredOnce(w, s);
        // The end job that comes second finds nothing left to decide.
        expect(await runSoloEndJob(w.deps, endJob(s))).toMatchObject({ kind: 'no_op' });
      }
    }
  });

  it('after the end job expired it, the request answers the ended session unchanged (E11)', async () => {
    for (const verb of ['pause', 'stop'] as const) {
      const w = world();
      const s = await afterRedisLoss(w, true);

      expect(await runSoloEndJob(w.deps, endJob(s))).toEqual({
        kind: 'settled',
        transition: 'expired',
      });
      const view = await request(w, verb, s);
      expect(view).toMatchObject({ status: 'abandoned', abandonReason: 'expired' });
      await expectExpiredOnce(w, s);
    }
  });

  it('racing, whichever takes the row lock first, the outcome is abandoned(expired) exactly once', async () => {
    for (let round = 0; round < 12; round += 1) {
      const verb = round % 2 === 0 ? 'stop' : 'pause';
      const w = world();
      const s = await afterRedisLoss(w, round % 4 < 2);

      const [job, view] = await Promise.all([
        runSoloEndJob(w.deps, endJob(s)),
        request(w, verb, s),
      ]);
      expect(view).toMatchObject({ status: 'abandoned', abandonReason: 'expired' });
      expect(['settled', 'no_op']).toContain(job.kind);
      await expectExpiredOnce(w, s);
    }
  });

  it('an unknown epoch fails the request with 503 and changes nothing (H2)', async () => {
    for (const verb of ['pause', 'stop'] as const) {
      const w = world();
      const s = await runningSession(60, 3 * MINUTE);
      w.state.presence = { online: true, checkedAtMs: await nowMs() };
      w.state.epochCreatedAtMs = undefined;

      await expect(request(w, verb, s)).rejects.toMatchObject({ status: 503 });
      expect(await sessionRow(s.sessionId)).toMatchObject({
        status: 'in_progress',
        runningSince: new Date(s.runningSinceMs),
      });
      expect(w.published).toEqual([]);
    }
  });

  it('observed evidence through the end completes without presence or the epoch (E8)', async () => {
    for (const verb of ['pause', 'stop'] as const) {
      const w = world();
      const s = await runningSession(60, 3 * MINUTE);
      await requireMarkers().record(
        s.userId,
        marker(s.sessionId, s.plannedEndMs + 1_000, 'observed'),
        s.runningSinceMs,
      );
      w.state.presence = 'unavailable';
      w.state.epochCreatedAtMs = undefined;

      expect(await request(w, verb, s)).toMatchObject({ status: 'completed', focusedSeconds: 60 });
      expect((await sessionRow(s.sessionId))?.endedAt?.getTime()).toBe(s.plannedEndMs);
    }
  });
});

describe('BullMQ worker', () => {
  it('puts a job that ran early back to sleep without spending an attempt, then completes it', async () => {
    const h = requireHarness();
    const prefixConfig = { ...h.config, REDIS_KEY_PREFIX: `ff-w-${randomUUID().slice(0, 8)}:` };
    const queueConnection = createRedisConnection(prefixConfig, h.runtime.logger, 'bullmq');
    const workerConnection = createRedisConnection(prefixConfig, h.runtime.logger, 'bullmq');
    connections.push(queueConnection, workerConnection);
    const queue = createFocusSessionQueue(queueConnection, prefixConfig);
    let graceRuns = 0;
    const processors: FocusSessionProcessors = {
      end: () => Promise.resolve({ kind: 'continued' }),
      grace: () => {
        graceRuns += 1;
        return Promise.resolve(
          graceRuns === 1 ? { kind: 'wake_later', delayMs: 300 } : { kind: 'late_grace' },
        );
      },
    };
    const worker = createFocusSessionWorker({
      connection: workerConnection,
      config: prefixConfig,
      logger: h.runtime.logger,
      processors,
    });
    // An untyped handle on the same queue: the only way to enqueue an invalid payload.
    const rawQueue = new Queue<unknown>(FOCUS_SESSION_QUEUE, {
      connection: queueConnection,
      prefix: bullmqPrefix(prefixConfig),
    });
    try {
      void worker.run();
      const job = graceJob({ sessionId: randomUUID(), userId: randomUUID() }, 1);
      const sessionId = job.sessionId;
      await queue.add(SOLO_GRACE_JOB, job, { jobId: soloGraceJobId(sessionId, 1) });
      await rawQueue.add(SOLO_END_JOB, { schemaVersion: 2 }, { jobId: 'invalid-end' });

      const deadline = Date.now() + 15_000;
      while ((await queue.getJobState(soloGraceJobId(sessionId, 1))) !== 'completed') {
        if (Date.now() > deadline) {
          throw new Error('the grace job did not complete');
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(graceRuns).toBe(2);
      const graceJobState = await queue.getJob(soloGraceJobId(sessionId, 1));
      expect(graceJobState?.attemptsMade).toBeLessThanOrEqual(1);

      while ((await queue.getJobState('invalid-end')) !== 'failed') {
        if (Date.now() > deadline) {
          throw new Error('the invalid job did not fail');
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect((await queue.getJob('invalid-end'))?.attemptsMade).toBe(1);
      expect(FOCUS_SESSION_QUEUE).toBe(queue.name);
    } finally {
      await worker.close();
      await queue.close();
      await rawQueue.close();
    }
  });
});

describe('expired grace at or after T_end is one outcome for every caller', () => {
  const serviceDeps = ({ deps }: ReturnType<typeof world>): FocusSessionsDeps => ({
    db: deps.db,
    checkUser: deps.checkUser,
    presenceRecoveryMs: deps.presenceRecoveryMs,
    markers: deps.markers,
    graceMs: deps.graceMs,
    changes: deps.changes,
  });

  const request = (
    w: ReturnType<typeof world>,
    verb: 'pause' | 'stop',
    s: { sessionId: string; userId: string },
  ) =>
    (verb === 'pause' ? pauseFocusSession : stopFocusSession)(
      serviceDeps(w),
      s.userId,
      s.sessionId,
    );

  /**
   * A session past T_end, offline, whose recorded disconnect (30 s before T_end, so no E8
   * proof) is more than the grace old.
   */
  const withExpiredGrace = async (
    evidence: DisconnectMarker['evidence'] = 'observed',
    w = world(),
  ) => {
    const s = await runningSession(60, 3 * MINUTE);
    const t = s.plannedEndMs - 30_000;
    await requireMarkers().record(s.userId, marker(s.sessionId, t, evidence), s.runningSinceMs);
    w.state.presence = { online: false, checkedAtMs: t + GRACE_MS };
    return { w, s, t };
  };

  const expectGraceExpiredOnce = async (
    w: ReturnType<typeof world>,
    s: { sessionId: string },
    t: number,
  ): Promise<void> => {
    const row = await sessionRow(s.sessionId);
    expect(row).toMatchObject({
      status: 'abandoned',
      abandonReason: 'grace_expired',
      focusedSeconds: 30,
    });
    expect(row?.endedAt?.getTime()).toBe(t);
    expect(w.published.map((change) => change.transition)).toEqual(['grace_expired']);
  };

  it('a pause or stop that wins the row lock settles abandoned(grace_expired)', async () => {
    for (const verb of ['pause', 'stop'] as const) {
      const { w, s, t } = await withExpiredGrace();

      const view = await request(w, verb, s);
      expect(view).toMatchObject({ status: 'abandoned', abandonReason: 'grace_expired' });
      await expectGraceExpiredOnce(w, s, t);
      // The jobs that come second find nothing left to decide.
      expect(await runSoloEndJob(w.deps, endJob(s))).toMatchObject({ kind: 'no_op' });
      expect(await runSoloGraceJob(w.deps, graceJob(s, t))).toMatchObject({ kind: 'no_op' });
      expect(w.published).toHaveLength(1);
    }
  });

  it('a detected disconnect with an expired grace settles the same way', async () => {
    for (const verb of ['pause', 'stop'] as const) {
      const { w, s, t } = await withExpiredGrace('detected');
      expect(await request(w, verb, s)).toMatchObject({ abandonReason: 'grace_expired' });
      await expectGraceExpiredOnce(w, s, t);
    }
  });

  it('after the end or grace job settled it, a pause or stop answers unchanged (E11)', async () => {
    for (const verb of ['pause', 'stop'] as const) {
      for (const first of ['end', 'grace'] as const) {
        const { w, s, t } = await withExpiredGrace();

        expect(
          await (first === 'end'
            ? runSoloEndJob(w.deps, endJob(s))
            : runSoloGraceJob(w.deps, graceJob(s, t))),
        ).toEqual({ kind: 'settled', transition: 'grace_expired' });
        expect(await request(w, verb, s)).toMatchObject({
          status: 'abandoned',
          abandonReason: 'grace_expired',
        });
        await expectGraceExpiredOnce(w, s, t);
      }
    }
  });

  it('racing, every order yields abandoned(grace_expired) exactly once', async () => {
    for (let round = 0; round < 16; round += 1) {
      const verb = round % 2 === 0 ? 'stop' : 'pause';
      const { w, s, t } = await withExpiredGrace();

      const racers: Promise<unknown>[] = [request(w, verb, s)];
      if (round % 4 < 2) {
        racers.push(runSoloEndJob(w.deps, endJob(s)));
      }
      if (round % 4 !== 1) {
        racers.push(runSoloGraceJob(w.deps, graceJob(s, t)));
      }
      const [view] = (await Promise.all(racers)) as [{ status: string; abandonReason: string }];
      expect(view).toMatchObject({ status: 'abandoned', abandonReason: 'grace_expired' });
      await expectGraceExpiredOnce(w, s, t);
    }
  });

  it('keeps E8, E9, E16 and the unknown-state rules unchanged', async () => {
    for (const verb of ['pause', 'stop'] as const) {
      // E8: observed evidence through the end completes, even with an old marker's grace over.
      const observed = world();
      const a = await runningSession(60, 3 * MINUTE);
      await requireMarkers().record(
        a.userId,
        marker(a.sessionId, a.plannedEndMs + 1_000, 'observed'),
        a.runningSinceMs,
      );
      observed.state.presence = { online: false, checkedAtMs: a.plannedEndMs + 1_000 + GRACE_MS };
      expect(await request(observed, verb, a)).toMatchObject({ status: 'completed' });

      // E16: a request never treats "online again" as a reconnect; the recorded disconnect's
      // grace job owns it, so the pause or stop applies.
      const online = world();
      const b = await runningSession(60, 3 * MINUTE);
      await requireMarkers().record(
        b.userId,
        marker(b.sessionId, b.plannedEndMs - 30_000, 'observed'),
        b.runningSinceMs,
      );
      online.state.presence = { online: true, checkedAtMs: await nowMs() };
      expect(await request(online, verb, b)).toMatchObject(
        verb === 'stop'
          ? { status: 'abandoned', abandonReason: 'stopped' }
          : { status: 'in_progress', focusedSeconds: 60 },
      );

      // E9: with no marker, a definite Redis loss still expires.
      const lost = world();
      const c = await runningSession(60, 3 * MINUTE);
      lost.state.presence = { online: false, checkedAtMs: await nowMs() };
      lost.state.epochCreatedAtMs = c.runningSinceMs + CLOCK_SKEW_TOLERANCE_MS + 1;
      expect(await request(lost, verb, c)).toMatchObject({ abandonReason: 'expired' });

      // H2: unknown presence with a marker (no observed proof) decides nothing.
      const unknown = world();
      const d = await runningSession(60, 3 * MINUTE);
      await requireMarkers().record(
        d.userId,
        marker(d.sessionId, d.plannedEndMs - 30_000, 'detected'),
        d.runningSinceMs,
      );
      unknown.state.presence = 'unavailable';
      await expect(request(unknown, verb, d)).rejects.toMatchObject({ status: 503 });
      expect((await sessionRow(d.sessionId))?.status).toBe('in_progress');
      expect(unknown.published).toEqual([]);
    }
  });
});
