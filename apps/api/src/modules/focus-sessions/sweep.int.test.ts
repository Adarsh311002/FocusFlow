import { randomUUID } from 'node:crypto';

import { soloEndJobSchema, soloGraceJobSchema } from '@focus-flow/contracts';
import { eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { beginHeldTransaction } from '../../../test/db-locks.js';
import { startTestHarness, stopTestHarness, type TestHarness } from '../../../test/harness.js';
import { scriptedSnapshot } from '../../../test/snapshots.js';
import { signUpTestUser } from '../../../test/users.js';
import { focusSessions } from '../../db/schema.js';
import { parseEpoch } from '../../platform/epoch.js';
import { createRedisClient, redisTimeMs, waitForRedisReady } from '../../platform/redis.js';
import { redisKeys } from '../../platform/redis-keys.js';
import { createReconciler } from '../reconciler/reconciler.js';
import { createFocusSessionChanges, type FocusSessionChange } from './changes.js';
import {
  CLOCK_SKEW_TOLERANCE_MS,
  type DisconnectMarker,
  PRESENCE_RECOVERY_MS,
} from './decision.js';
import {
  type FocusSessionScheduler,
  type LifecycleDeps,
  reconcileRunningSession,
  runSoloEndJob,
  runSoloGraceJob,
} from './lifecycle.js';
import { createDisconnectMarkerStore, type DisconnectMarkerStore } from './marker-store.js';
import { pauseFocusSession, stopFocusSession } from './service.js';
import { SOLO_STALE_AFTER_MS, sweepRunningSessions, sweepStaleSessions } from './sweep.js';

// Reconciler steps 5 and 6 (E2, E17–E19, E22) against real PostgreSQL and Redis. Presence
// and the epoch are scripted per test (per user where needed); the session rows, row locks,
// the marker store and the timing are real. The runtime runs without workers, so only these
// tests decide the sessions; each test settles whatever it left in progress.

const GRACE_MS = 60_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const TIMEOUT_MS = 5_000;

let harness: TestHarness | undefined;
let markers: DisconnectMarkerStore | undefined;
const connections: Redis[] = [];

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
const logger = pino({ level: 'silent' });

type Presence = { readonly online: boolean } | 'unavailable';

/** One scripted world: presence (per user or for everyone), the epoch, jobs and changes. */
const world = () => {
  const state: {
    presence: Presence;
    byUser: Map<string, Presence>;
    epochCreatedAtMs: number | undefined;
    unreadableMarkers: Set<string>;
    schedulerDown: boolean;
  } = {
    presence: { online: true },
    byUser: new Map(),
    epochCreatedAtMs: 0,
    unreadableMarkers: new Set(),
    schedulerDown: false,
  };
  const scheduled: { kind: 'end' | 'grace'; id: string }[] = [];
  const published: FocusSessionChange[] = [];
  const record = (kind: 'end' | 'grace', id: string) => {
    if (state.schedulerDown) {
      return Promise.reject(new Error('Redis is down'));
    }
    scheduled.push({ kind, id });
    return Promise.resolve();
  };
  const scheduler: FocusSessionScheduler = {
    scheduleEnd: (job) => record('end', `${job.sessionId}@${String(job.runningSinceMs)}`),
    scheduleGrace: (job) => record('grace', `${job.sessionId}@${String(job.disconnectedAtMs)}`),
  };
  const changes = createFocusSessionChanges(logger);
  changes.subscribe((change) => {
    published.push(change);
  });
  const store = requireMarkers();
  const markers: DisconnectMarkerStore = {
    ...store,
    read: (userId) =>
      state.unreadableMarkers.has(userId)
        ? Promise.reject(new Error('marker connection lost'))
        : store.read(userId),
  };
  const checkUser = async (userId: string) => {
    const presence = state.byUser.get(userId) ?? state.presence;
    if (presence === 'unavailable') {
      throw new Error('Redis is down');
    }
    return {
      online: presence.online,
      checkedAtMs: await nowMs(),
      epochCreatedAtMs: state.epochCreatedAtMs,
    };
  };
  const deps: LifecycleDeps = {
    db: requireHarness().db,
    markers,
    checkUser,
    snapshotUser: scriptedSnapshot(checkUser, markers),
    presenceRecoveryMs: PRESENCE_RECOVERY_MS,
    graceMs: GRACE_MS,
    scheduler,
    changes,
  };
  return { state, scheduled, published, deps, sweepDeps: { ...deps, logger } };
};

type World = ReturnType<typeof world>;

/** A running session whose stretch began `ranForMs` ago (`startedAgoMs` ago if given). */
const runningSession = async (
  plannedSeconds: number,
  ranForMs: number,
  startedAgoMs = ranForMs,
) => {
  const h = requireHarness();
  const user = await signUpTestUser(h, 'sweep');
  const now = await nowMs();
  const runningSince = new Date(Math.floor(now - ranForMs));
  const startedAt = new Date(Math.floor(now - startedAgoMs));
  const [row] = await h.db
    .insert(focusSessions)
    .values({
      id: randomUUID(),
      userId: user.userId,
      status: 'in_progress',
      plannedSeconds,
      focusedSeconds: 0,
      runningSince,
      startedAt,
    })
    .returning();
  if (row === undefined) {
    throw new Error('no session row');
  }
  return {
    userId: user.userId,
    sessionId: row.id,
    runningSinceMs: runningSince.getTime(),
    plannedEndMs: runningSince.getTime() + plannedSeconds * 1_000,
  };
};

/** A paused session started `startedAgoMs` ago with `focusedSeconds` accumulated. */
const pausedSession = async (startedAgoMs: number, focusedSeconds: number) => {
  const h = requireHarness();
  const user = await signUpTestUser(h, 'paused');
  const [row] = await h.db
    .insert(focusSessions)
    .values({
      id: randomUUID(),
      userId: user.userId,
      status: 'in_progress',
      plannedSeconds: 1_500,
      focusedSeconds,
      runningSince: null,
      startedAt: new Date(Math.floor((await nowMs()) - startedAgoMs)),
    })
    .returning();
  if (row === undefined) {
    throw new Error('no session row');
  }
  return { userId: user.userId, sessionId: row.id };
};

type Session = { readonly userId: string; readonly sessionId: string };
type Running = Awaited<ReturnType<typeof runningSession>>;

const rowOf = async (sessionId: string) => {
  const [row] = await requireHarness()
    .db.select()
    .from(focusSessions)
    .where(eq(focusSessions.id, sessionId));
  return row;
};

const recordMarker = (
  s: Running,
  disconnectedAtMs: number,
  evidence: DisconnectMarker['evidence'],
) =>
  requireMarkers().record(
    s.userId,
    { sessionId: s.sessionId, disconnectedAtMs, evidence },
    s.runningSinceMs,
  );

const reconcile = (w: World, s: Session) =>
  reconcileRunningSession(w.deps, { id: s.sessionId, userId: s.userId }, TIMEOUT_MS);

const transitionsOf = (w: World, s: Session) =>
  w.published.filter((change) => change.session.id === s.sessionId).map((c) => c.transition);

beforeAll(async () => {
  // A fast heartbeat so the runtime re-creates the epoch quickly after a FLUSHALL; the
  // presence-recovery window is then INSTANCE_TTL_MS = 5 s for the real presence check.
  harness = await startTestHarness(
    { ROLE: 'api', INSTANCE_HEARTBEAT_MS: '200', INSTANCE_TTL_MS: '5000' },
    { epochAgeMs: 7 * 24 * HOUR },
  );
  const redis = createRedisClient(harness.config, harness.runtime.logger);
  connections.push(redis);
  await waitForRedisReady(redis, 10_000);
  markers = createDisconnectMarkerStore({ redis });
}, 180_000);

afterEach(async () => {
  // Settle whatever a test left in progress, so later sweeps see only their own sessions.
  await requireHarness().db.execute(sql`
    UPDATE focus_sessions
    SET status = 'abandoned', abandon_reason = 'stopped', running_since = NULL,
        ended_at = GREATEST(started_at, now())
    WHERE status = 'in_progress'`);
});

afterAll(async () => {
  for (const connection of connections) {
    connection.disconnect();
  }
  if (harness !== undefined) {
    await stopTestHarness(harness);
  }
}, 60_000);

describe('step 5: recovery of running sessions', () => {
  it('before T_end, online, no marker: keeps running and ensures the (lost) end job', async () => {
    const w = world();
    const s = await runningSession(1_500, MINUTE);

    expect(await reconcile(w, s)).toEqual({ kind: 'continued' });
    expect(w.scheduled).toEqual([
      { kind: 'end', id: `${s.sessionId}@${String(s.runningSinceMs)}` },
    ]);
    expect((await rowOf(s.sessionId))?.status).toBe('in_progress');
    expect(w.published).toEqual([]);
  });

  it('past T_end, online, no marker: completes at T_end with F = P (D35)', async () => {
    const w = world();
    const s = await runningSession(60, 3 * MINUTE);

    expect(await reconcile(w, s)).toEqual({ kind: 'settled', transition: 'completed' });
    const row = await rowOf(s.sessionId);
    expect(row).toMatchObject({ status: 'completed', focusedSeconds: 60 });
    expect(row?.endedAt?.getTime()).toBe(s.plannedEndMs);
    expect(transitionsOf(w, s)).toEqual(['completed']);
  });

  it('offline with a marker whose grace ran out: grace_expired at d, clamped to T_end', async () => {
    const cases = [
      // Before T_end: the disconnect two minutes ago.
      { planned: 1_500, ranFor: 5 * MINUTE, at: (s: Running) => s.runningSinceMs + 3 * MINUTE },
      // After T_end, the disconnect before it.
      { planned: 60, ranFor: 3 * MINUTE, at: (s: Running) => s.plannedEndMs - 30_000 },
      // A detected disconnect after T_end: d is clamped to T_end.
      { planned: 60, ranFor: 4 * MINUTE, at: (s: Running) => s.plannedEndMs + MINUTE },
    ];
    for (const c of cases) {
      const w = world();
      w.state.presence = { online: false };
      const s = await runningSession(c.planned, c.ranFor);
      const t = c.at(s);
      await recordMarker(s, t, 'detected');

      expect(await reconcile(w, s)).toEqual({ kind: 'settled', transition: 'grace_expired' });
      const row = await rowOf(s.sessionId);
      expect(row?.abandonReason).toBe('grace_expired');
      expect(row?.endedAt?.getTime()).toBe(Math.min(t, s.plannedEndMs));
      expect(transitionsOf(w, s)).toEqual(['grace_expired']);
    }
  });

  it('offline inside the grace with the job lost: ensures the grace job (and the end job)', async () => {
    const w = world();
    w.state.presence = { online: false };
    const s = await runningSession(1_500, 5 * MINUTE);
    const t = (await nowMs()) - 10_000;
    await recordMarker(s, t, 'observed');

    expect(await reconcile(w, s)).toEqual({ kind: 'waiting_for_grace' });
    expect(w.scheduled).toEqual([
      { kind: 'grace', id: `${s.sessionId}@${String(t)}` },
      { kind: 'end', id: `${s.sessionId}@${String(s.runningSinceMs)}` },
    ]);
    expect((await rowOf(s.sessionId))?.status).toBe('in_progress');
  });

  it('offline with no marker and no Redis loss: late grace (H3); a second sweep keeps it', async () => {
    const w = world();
    w.state.presence = { online: false };
    const s = await runningSession(1_500, 5 * MINUTE);

    const before = await nowMs();
    expect(await reconcile(w, s)).toEqual({ kind: 'late_grace' });
    const recorded = await requireMarkers().read(s.userId);
    expect(recorded).toMatchObject({ sessionId: s.sessionId, evidence: 'detected' });
    expect(recorded?.disconnectedAtMs).toBeGreaterThanOrEqual(before);

    expect(await reconcile(w, s)).toEqual({ kind: 'waiting_for_grace' });
    expect(await requireMarkers().read(s.userId)).toEqual(recorded);
    const graceIds = w.scheduled.filter((job) => job.kind === 'grace').map((job) => job.id);
    expect(new Set(graceIds)).toEqual(
      new Set([`${s.sessionId}@${String(recorded?.disconnectedAtMs)}`]),
    );
    expect(w.published).toEqual([]);
  });

  it('after a definite Redis loss: expired offline or online past T_end; continues online before it (E9)', async () => {
    const cases = [
      { online: false, planned: 1_500, expect: 'expired' },
      { online: true, planned: 60, expect: 'expired' },
      { online: true, planned: 1_500, expect: 'continued' },
    ] as const;
    for (const c of cases) {
      const w = world();
      w.state.presence = { online: c.online };
      const s = await runningSession(c.planned, 3 * MINUTE);
      w.state.epochCreatedAtMs = s.runningSinceMs + CLOCK_SKEW_TOLERANCE_MS + 1;

      const outcome = await reconcile(w, s);
      if (c.expect === 'expired') {
        expect(outcome).toEqual({ kind: 'settled', transition: 'expired' });
        expect(await rowOf(s.sessionId)).toMatchObject({
          abandonReason: 'expired',
          focusedSeconds: 0,
        });
      } else {
        expect(outcome).toEqual({ kind: 'continued' });
      }
    }
  });

  it('observed evidence through the end completes with presence and the epoch unknown (E8)', async () => {
    const w = world();
    w.state.presence = 'unavailable';
    w.state.epochCreatedAtMs = undefined;
    const s = await runningSession(60, 3 * MINUTE);
    await recordMarker(s, s.plannedEndMs + 1_000, 'observed');

    expect(await reconcile(w, s)).toEqual({ kind: 'settled', transition: 'completed' });
    expect((await rowOf(s.sessionId))?.endedAt?.getTime()).toBe(s.plannedEndMs);
  });

  it('online with a disconnect recorded past T_end: never completes; hands over to its grace job (E16)', async () => {
    const w = world();
    const s = await runningSession(60, 3 * MINUTE);
    const t = s.plannedEndMs - 30_000;
    await recordMarker(s, t, 'observed');

    expect(await reconcile(w, s)).toEqual({ kind: 'waiting_for_grace' });
    expect(w.scheduled).toEqual([{ kind: 'grace', id: `${s.sessionId}@${String(t)}` }]);
    expect((await rowOf(s.sessionId))?.status).toBe('in_progress');
  });

  it('a marker from before the current stretch is treated as absent and cleared', async () => {
    const w = world();
    const s = await runningSession(1_500, MINUTE, 10 * MINUTE);
    await requireMarkers().record(
      s.userId,
      {
        sessionId: s.sessionId,
        disconnectedAtMs: s.runningSinceMs - 5 * MINUTE,
        evidence: 'observed',
      },
      s.runningSinceMs - 6 * MINUTE,
    );

    expect(await reconcile(w, s)).toEqual({ kind: 'continued' });
    expect(await requireMarkers().read(s.userId)).toBeUndefined();
  });

  it('a follow-up failing after the commit is reported, and the next sweep repairs it', async () => {
    const w = world();
    const s = await runningSession(1_500, MINUTE);
    w.state.schedulerDown = true;

    const failing = await sweepRunningSessions(w.sweepDeps);
    expect(failing).toMatchObject({ outcomes: { continued: 1 }, followUpFailed: 1, failed: 0 });
    expect(w.scheduled).toEqual([]);

    w.state.schedulerDown = false;
    await sweepRunningSessions(w.sweepDeps);
    expect(w.scheduled).toEqual([
      { kind: 'end', id: `${s.sessionId}@${String(s.runningSinceMs)}` },
    ]);
  });
});

describe('step 5: fail-closed (H2, E17, E18)', () => {
  it('defers on unknown presence, an unknown epoch, the recovery window or an unreadable marker', async () => {
    const w = world();
    const unknownPresence = await runningSession(60, 3 * MINUTE);
    const unreadable = await runningSession(60, 3 * MINUTE);
    const healthy = await runningSession(60, 3 * MINUTE);
    w.state.byUser.set(unknownPresence.userId, 'unavailable');
    w.state.unreadableMarkers.add(unreadable.userId);

    const summary = await sweepRunningSessions(w.sweepDeps);
    expect(summary.outcomes).toEqual({
      'deferred:presence_unknown': 1,
      'deferred:marker_unknown': 1,
      'settled:completed': 1,
    });
    for (const s of [unknownPresence, unreadable]) {
      expect(await rowOf(s.sessionId)).toMatchObject({ status: 'in_progress' });
      expect(transitionsOf(w, s)).toEqual([]);
    }
    expect(transitionsOf(w, healthy)).toEqual(['completed']);

    for (const epochCreatedAtMs of [undefined, (await nowMs()) - 10_000]) {
      const v = world();
      v.state.epochCreatedAtMs = epochCreatedAtMs;
      const s = await runningSession(60, 3 * MINUTE);
      expect(await reconcile(v, s)).toEqual({
        kind: 'deferred',
        reason: epochCreatedAtMs === undefined ? 'epoch_unknown' : 'presence_recovering',
      });
      expect((await rowOf(s.sessionId))?.status).toBe('in_progress');
      expect(v.published).toEqual([]);
      expect(v.scheduled).toEqual([]);
    }
  });
});

describe('step 6 and its interaction with step 5 (E2, E19, E22)', () => {
  it('a paused session is untouched before 12 h, and expired at 12 h keeping its time', async () => {
    const w = world();
    const fresh = await pausedSession(11 * HOUR, 300);
    const stale = await pausedSession(SOLO_STALE_AFTER_MS + MINUTE, 300);

    expect((await sweepRunningSessions(w.sweepDeps)).outcomes).toEqual({});
    expect((await sweepStaleSessions(w.sweepDeps)).outcomes).toEqual({ expired: 1 });
    expect(await rowOf(fresh.sessionId)).toMatchObject({
      status: 'in_progress',
      runningSince: null,
    });
    expect(await rowOf(stale.sessionId)).toMatchObject({
      status: 'abandoned',
      abandonReason: 'expired',
      focusedSeconds: 300,
    });
    expect(transitionsOf(w, stale)).toEqual(['expired']);
  });

  it('a stale running session inside the recovery window: step 5 defers, step 6 expires it', async () => {
    const w = world();
    // Started 13 h ago; its stretch began 10 minutes after the start (F kept: 0 here).
    const s = await runningSession(60, 13 * HOUR - 10 * MINUTE, 13 * HOUR);
    w.state.epochCreatedAtMs = (await nowMs()) - 10_000;
    const reconciler = createReconciler({
      redis: requireHarness().redis,
      presence: { removeInstance: () => Promise.resolve() },
      instanceTtlMs: requireHarness().config.INSTANCE_TTL_MS,
      intervalMs: 30_000,
      logger,
      focusSessions: { deps: w.deps },
    });

    const summary = await reconciler.run({
      schemaVersion: 1,
      trigger: 'recovery',
      correlationId: 't',
    });
    expect(summary.runningSessions?.outcomes).toEqual({ 'deferred:presence_recovering': 1 });
    expect(summary.staleSessions?.outcomes).toEqual({ expired: 1 });
    expect(await rowOf(s.sessionId)).toMatchObject({
      status: 'abandoned',
      abandonReason: 'expired',
      focusedSeconds: 0,
    });
    expect(transitionsOf(w, s)).toEqual(['expired']);
  });

  it('qualifying E8 evidence on a stale session inside the window still completes it first', async () => {
    const w = world();
    w.state.epochCreatedAtMs = (await nowMs()) - 10_000;
    const s = await runningSession(60, 13 * HOUR, 13 * HOUR);
    await recordMarker(s, s.plannedEndMs + 1_000, 'observed');

    expect((await sweepRunningSessions(w.sweepDeps)).outcomes).toEqual({ 'settled:completed': 1 });
    expect((await sweepStaleSessions(w.sweepDeps)).outcomes).toEqual({}); // Ended: no longer a candidate.
    expect(transitionsOf(w, s)).toEqual(['completed']);
  });

  it('a stale session whose normal decision is terminal keeps that result', async () => {
    const w = world();
    w.state.presence = { online: false };
    const s = await runningSession(60, 13 * HOUR, 13 * HOUR);
    await recordMarker(s, s.plannedEndMs - 30_000, 'observed');

    expect((await sweepRunningSessions(w.sweepDeps)).outcomes).toEqual({
      'settled:grace_expired': 1,
    });
    expect((await sweepStaleSessions(w.sweepDeps)).outcomes).toEqual({}); // Ended: no longer a candidate.
    expect((await rowOf(s.sessionId))?.abandonReason).toBe('grace_expired');
    expect(transitionsOf(w, s)).toEqual(['grace_expired']);
  });

  it('runs without Redis: commits the expiry and the failed follow-up is only logged', async () => {
    const s = await pausedSession(SOLO_STALE_AFTER_MS + MINUTE, 120);
    const changes = createFocusSessionChanges(logger);
    const seen: string[] = [];
    changes.subscribe((change) => {
      seen.push(change.transition);
      // The marker clear and the event need Redis: they fail.
      throw new Error('Redis is down');
    });

    const summary = await sweepStaleSessions({ db: requireHarness().db, changes, logger });
    expect(summary).toMatchObject({ outcomes: { expired: 1 }, failed: 0 });
    expect(seen).toEqual(['expired']);
    expect(await rowOf(s.sessionId)).toMatchObject({
      abandonReason: 'expired',
      focusedSeconds: 120,
    });
  });
});

describe('concurrency and idempotency', () => {
  it('two sweeps at once over mixed sessions: each settles once, the rest stays consistent', async () => {
    const w = world();
    const kinds = ['complete', 'grace', 'continue', 'late'] as const;
    const sessions: { kind: (typeof kinds)[number]; s: Running; t?: number }[] = [];
    for (let index = 0; index < 20; index += 1) {
      const kind = kinds[index % kinds.length] ?? 'complete';
      const s = await runningSession(
        kind === 'complete' || kind === 'grace' ? 60 : 1_500,
        3 * MINUTE,
      );
      if (kind === 'grace') {
        w.state.byUser.set(s.userId, { online: false });
        const t = s.plannedEndMs - 30_000;
        await recordMarker(s, t, 'observed');
        sessions.push({ kind, s, t });
      } else {
        if (kind === 'late') {
          w.state.byUser.set(s.userId, { online: false });
        }
        sessions.push({ kind, s });
      }
    }

    const [first, second] = await Promise.all([
      sweepRunningSessions(w.sweepDeps),
      sweepRunningSessions(w.sweepDeps),
    ]);
    expect(first.failed + second.failed).toBe(0);
    for (const { kind, s, t } of sessions) {
      const row = await rowOf(s.sessionId);
      if (kind === 'complete') {
        expect(row).toMatchObject({ status: 'completed' });
        expect(transitionsOf(w, s)).toEqual(['completed']);
      } else if (kind === 'grace') {
        expect(row?.abandonReason).toBe('grace_expired');
        expect(row?.endedAt?.getTime()).toBe(t);
        expect(transitionsOf(w, s)).toEqual(['grace_expired']);
      } else {
        expect(row?.status).toBe('in_progress');
        expect(transitionsOf(w, s)).toEqual([]);
      }
      if (kind === 'late') {
        expect((await requireMarkers().read(s.userId))?.evidence).toBe('detected');
      }
    }
  });

  it('three sweeps in a row: no new transitions, jobs or marker changes after the first', async () => {
    const w = world();
    w.state.presence = { online: false };
    const s = await runningSession(1_500, 3 * MINUTE);
    await sweepRunningSessions(w.sweepDeps);
    const marker = await requireMarkers().read(s.userId);
    const jobs = new Set(w.scheduled.map((job) => `${job.kind}:${job.id}`));

    await sweepRunningSessions(w.sweepDeps);
    await sweepRunningSessions(w.sweepDeps);
    expect(await requireMarkers().read(s.userId)).toEqual(marker);
    expect(new Set(w.scheduled.map((job) => `${job.kind}:${job.id}`))).toEqual(jobs);
    expect(w.published).toEqual([]);
  });

  it('skips a row another transaction holds, without waiting; the next sweep settles it', async () => {
    const w = world();
    const s = await runningSession(60, 3 * MINUTE);
    const held = await beginHeldTransaction(requireHarness().pool);
    try {
      await held.client.query('SELECT id FROM focus_sessions WHERE id = $1 FOR UPDATE', [
        s.sessionId,
      ]);
      const startedAt = Date.now();
      expect(await reconcile(w, s)).toEqual({ kind: 'skipped_locked' });
      expect(Date.now() - startedAt).toBeLessThan(TIMEOUT_MS);
    } finally {
      await held.rollback();
    }
    expect(await reconcile(w, s)).toEqual({ kind: 'settled', transition: 'completed' });
  });

  it('processes every session across several batches', async () => {
    const w = world();
    const sessions = [];
    for (let index = 0; index < 7; index += 1) {
      sessions.push(await runningSession(60, 3 * MINUTE));
    }
    const batches: number[] = [];
    const summary = await sweepRunningSessions(w.sweepDeps, {
      batchSize: 3,
      afterBatch: (index) => {
        batches.push(index);
        return Promise.resolve();
      },
    });
    expect(batches).toEqual([0, 1, 2]);
    expect(summary).toMatchObject({ outcomes: { 'settled:completed': 7 }, complete: true });
  });

  it('stops starting sessions when its budget runs out', async () => {
    const w = world();
    for (let index = 0; index < 3; index += 1) {
      await runningSession(60, 3 * MINUTE);
    }
    let allowed = 1;
    const summary = await sweepRunningSessions(w.sweepDeps, {
      batchSize: 10,
      concurrency: 1,
      shouldContinue: () => allowed-- > 0,
    });
    expect(summary.complete).toBe(false);
    expect(summary.outcomes).toEqual({});
  });
});

describe('races with the other deciders: one terminal outcome, one event', () => {
  const serviceDeps = (w: World) => ({
    db: w.deps.db,
    checkUser: w.deps.checkUser,
    snapshotUser: w.deps.snapshotUser,
    presenceRecoveryMs: w.deps.presenceRecoveryMs,
    markers: w.deps.markers,
    graceMs: w.deps.graceMs,
    changes: w.deps.changes,
  });

  const scenarios = {
    // Online past T_end, no marker (D35).
    completed: async () => {
      const s = await runningSession(60, 3 * MINUTE);
      return { s, t: undefined, endedAtMs: s.plannedEndMs };
    },
    // Offline, the disconnect's grace over (377e81b).
    grace_expired: async (w: World) => {
      w.state.presence = { online: false };
      const s = await runningSession(60, 3 * MINUTE);
      const t = s.plannedEndMs - 30_000;
      await recordMarker(s, t, 'observed');
      return { s, t, endedAtMs: t };
    },
    // A definite Redis loss during the stretch, offline, no marker (E9).
    expired: async (w: World) => {
      w.state.presence = { online: false };
      const s = await runningSession(60, 3 * MINUTE);
      w.state.epochCreatedAtMs = s.runningSinceMs + CLOCK_SKEW_TOLERANCE_MS + 1;
      return { s, t: undefined, endedAtMs: undefined };
    },
  } as const;

  for (const [transition, setup] of Object.entries(scenarios)) {
    it(`${transition}: sweep, end job, grace job, pause and stop together, repeatedly`, async () => {
      for (let round = 0; round < 6; round += 1) {
        const w = world();
        const { s, t, endedAtMs } = await setup(w);
        const end = soloEndJobSchema.parse({
          schemaVersion: 1,
          sessionId: s.sessionId,
          userId: s.userId,
          runningSinceMs: s.runningSinceMs,
        });
        const deciders: Promise<unknown>[] = [
          reconcile(w, s),
          reconcile(w, s),
          runSoloEndJob(w.deps, end),
          pauseFocusSession(serviceDeps(w), s.userId, s.sessionId),
          stopFocusSession(serviceDeps(w), s.userId, s.sessionId),
        ];
        if (t !== undefined) {
          deciders.push(
            runSoloGraceJob(
              w.deps,
              soloGraceJobSchema.parse({
                schemaVersion: 1,
                sessionId: s.sessionId,
                userId: s.userId,
                disconnectedAtMs: t,
              }),
            ),
          );
        }
        await Promise.all(deciders);

        const row = await rowOf(s.sessionId);
        expect(row?.status).toBe(transition === 'completed' ? 'completed' : 'abandoned');
        if (transition !== 'completed') {
          expect(row?.abandonReason).toBe(transition);
        }
        if (endedAtMs !== undefined) {
          expect(row?.endedAt?.getTime()).toBe(endedAtMs);
        }
        expect(transitionsOf(w, s)).toEqual([transition]);
      }
    });
  }

  it('a pause before T_end racing the sweep: the pause applies; the sweep leaves the paused row', async () => {
    for (let round = 0; round < 6; round += 1) {
      const w = world();
      const s = await runningSession(1_500, MINUTE);
      const [outcome] = await Promise.all([
        reconcile(w, s),
        pauseFocusSession(serviceDeps(w), s.userId, s.sessionId),
      ]);
      expect(['continued', 'skipped_locked', 'no_op']).toContain(outcome.kind);
      expect(await rowOf(s.sessionId)).toMatchObject({ status: 'in_progress', runningSince: null });
      expect(transitionsOf(w, s)).toEqual(['paused']);
    }
  });
});

describe('a fresh epoch for every decision (E17)', () => {
  it('Redis loses its data between batches: later decisions see the new epoch', async () => {
    const h = requireHarness();
    const w = world();
    // The real presence check: these users have no sockets (offline), and the epoch is
    // read from Redis in the same transaction.
    const deps: LifecycleDeps = {
      ...w.deps,
      checkUser: (userId) => h.runtime.presence.checkUser(userId),
      snapshotUser: h.runtime.focusSessionLifecycle.snapshotUser,
      presenceRecoveryMs: h.config.INSTANCE_TTL_MS,
    };
    const sessions: Running[] = [];
    for (let index = 0; index < 6; index += 1) {
      sessions.push(await runningSession(1_500, 3 * MINUTE));
    }
    const before = parseEpoch(await h.redis.get(redisKeys.epoch))?.createdAtMs;

    const summary = await sweepRunningSessions(
      { ...deps, logger },
      {
        batchSize: 2,
        concurrency: 1,
        afterBatch: async (index) => {
          if (index !== 0) {
            return;
          }
          await h.redis.flushall();
          // The runtime's heartbeat notices the loss and creates the new epoch.
          const deadline = Date.now() + 10_000;
          while ((await h.redis.get(redisKeys.epoch)) === null) {
            if (Date.now() > deadline) {
              throw new Error('no new epoch');
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        },
      },
    );

    const after = parseEpoch(await h.redis.get(redisKeys.epoch))?.createdAtMs;
    expect(before).toBeDefined();
    expect(after ?? 0).toBeGreaterThan(before ?? 0);
    // Batch 1 (old epoch, trusted, offline, no loss): late grace. Batches 2–3: the new
    // epoch's presence-recovery window — deferred, never late grace or expired.
    expect(summary.outcomes).toEqual({ late_grace: 2, 'deferred:presence_recovering': 4 });
    for (const s of sessions) {
      expect((await rowOf(s.sessionId))?.status).toBe('in_progress');
    }
  });
});
