import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startTestHarness, stopTestHarness, type TestHarness } from '../../../test/harness.js';
import { focusSessions, rooms, users } from '../../db/schema.js';
import { redisTimeMs } from '../../platform/redis.js';
import { redisKeys } from '../../platform/redis-keys.js';
import { createRunLedger } from '../room-focus/ledger.js';
import { recoverRoomFocusAfterRedisLoss } from '../room-focus/recovery.js';
import type {
  LedgerParticipant,
  RoomFocusChange,
  RoomFocusService,
  RunLedger,
} from '../room-focus/types.js';
import { createReconciler } from './reconciler.js';
import { settleUnsettledRuns, sweepRoomSessions } from './room-focus.js';

// Reconciler steps 3, 4 and 7 and the global Redis-loss recovery (RF9, RF10, RF15) against
// real PostgreSQL and Redis. The service and the grace scheduler are recording fakes: what
// is under test is which session gets which decision, exactly once, and that one failure
// never stops the rest. The service's own transitions are tested with the service.

let harness: TestHarness | undefined;

const requireHarness = (): TestHarness => {
  if (harness === undefined) {
    throw new Error('the API harness failed to start');
  }
  return harness;
};
const db = () => requireHarness().db;
const redis = () => requireHarness().redis;
const logger = pino({ level: 'silent' });

beforeAll(async () => {
  // A background reconcile must not decide the sessions these tests seed.
  harness = await startTestHarness({ RECONCILER_INTERVAL_MS: '600000' });
}, 180_000);

afterAll(async () => {
  if (harness !== undefined) {
    await stopTestHarness(harness);
  }
}, 60_000);

beforeEach(async () => {
  await db().delete(focusSessions);
  await redis().del(redisKeys.unsettledRuns);
});

// ---- Fixtures ---------------------------------------------------------------------------

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
let roomSeq = 0;

type Fixture = {
  readonly roomId: string;
  readonly runId: string;
  readonly userId: string;
  readonly sessionId: string;
};

const insertRoom = async (): Promise<{ roomId: string; hostId: string }> => {
  const hostId = uuidv7();
  await db()
    .insert(users)
    .values({
      id: hostId,
      email: `host-${hostId}@example.com`,
      displayName: 'Host',
      passwordHash: 'x',
      emailVerifiedAt: null,
    });
  const roomId = uuidv7();
  const code = `R${CODE_ALPHABET[Math.floor(roomSeq / 31) % 31] ?? 'A'}${CODE_ALPHABET[roomSeq % 31] ?? 'A'}ZZZ`;
  roomSeq += 1;
  await db().insert(rooms).values({ id: roomId, code, name: 'Room', hostId, isPrivate: false });
  return { roomId, hostId };
};

/** A room (or solo) in-progress session for a fresh user, started `ageMs` ago. */
const insertSession = async (options: {
  roomId?: string;
  runId?: string;
  ageMs: number;
}): Promise<Fixture> => {
  const userId = uuidv7();
  await db()
    .insert(users)
    .values({
      id: userId,
      email: `user-${userId}@example.com`,
      displayName: 'User',
      passwordHash: 'x',
      emailVerifiedAt: null,
    });
  const sessionId = uuidv7();
  const runId = options.runId ?? uuidv7();
  const startedAt = new Date(Date.now() - options.ageMs);
  await db()
    .insert(focusSessions)
    .values({
      id: sessionId,
      userId,
      status: 'in_progress',
      plannedSeconds: 1_500,
      focusedSeconds: 0,
      startedAt,
      ...(options.roomId === undefined
        ? { runningSince: startedAt }
        : { roomId: options.roomId, focusRunId: runId }),
    });
  return { roomId: options.roomId ?? '', runId, userId, sessionId };
};

const participantOf = (
  fixture: Fixture,
  overrides: Partial<LedgerParticipant> = {},
): LedgerParticipant => ({
  userId: fixture.userId,
  sessionId: fixture.sessionId,
  optedInAtMs: 1_000,
  elapsedAtOptInMs: 0,
  disconnectedAtMs: null,
  elapsedAtDisconnectMs: null,
  ...overrides,
});

/** Writes the run record and the participant straight into the ledger's keys. */
const seedRun = async (
  fixture: Fixture,
  options: {
    status?: 'open' | 'closed';
    participant?: Partial<LedgerParticipant> | null;
    unsettled?: boolean;
  } = {},
): Promise<void> => {
  const { roomId, runId, userId } = fixture;
  const status = options.status ?? 'open';
  await redis().hset(redisKeys.roomRun(roomId, runId), {
    status,
    openedAtMs: '1000',
    ...(status === 'closed'
      ? { closeReason: 'completed', closedAtMs: '2000', elapsedAtCloseMs: '1500000' }
      : {}),
  });
  if (options.participant !== null) {
    await redis().hset(redisKeys.roomRunParticipants(roomId, runId), {
      [userId]: JSON.stringify(participantOf(fixture, options.participant)),
    });
  }
  if (options.unsettled === true) {
    await redis().zadd(redisKeys.unsettledRuns, 2000, `${roomId}:${runId}`);
  }
};

const sessionRow = async (sessionId: string) => {
  const [row] = await db().select().from(focusSessions).where(eq(focusSessions.id, sessionId));
  if (row === undefined) {
    throw new Error('no such session');
  }
  return row;
};

type Calls = {
  settleRun: [string, string][];
  graceExpired: [string, string, string, number][];
  userLeftRoom: [string, string][];
  ensureGrace: { job: { userId: string; disconnectedAtMs: number }; delayMs: number }[];
  notified: RoomFocusChange[];
};

const fakes = (
  options: {
    present?: ReadonlySet<string>;
    settleRun?: (roomId: string, runId: string) => Promise<'settled' | 'pending_grace' | 'gone'>;
  } = {},
) => {
  const calls: Calls = {
    settleRun: [],
    graceExpired: [],
    userLeftRoom: [],
    ensureGrace: [],
    notified: [],
  };
  const service: Pick<RoomFocusService, 'settleRun' | 'graceExpired' | 'userLeftRoom'> = {
    settleRun: (roomId, runId) => {
      calls.settleRun.push([roomId, runId]);
      return options.settleRun?.(roomId, runId) ?? Promise.resolve('settled');
    },
    graceExpired: (roomId, runId, userId, disconnectedAtMs) => {
      calls.graceExpired.push([roomId, runId, userId, disconnectedAtMs]);
      return Promise.resolve('abandoned');
    },
    userLeftRoom: (userId, roomId) => {
      calls.userLeftRoom.push([userId, roomId]);
      return Promise.resolve();
    },
  };
  const deps = {
    db: db(),
    ledger: createRunLedger(redis()),
    service,
    scheduler: {
      ensureGrace: (job: { userId: string; disconnectedAtMs: number }, delayMs: number) => {
        calls.ensureGrace.push({ job, delayMs });
        return Promise.resolve();
      },
    },
    isPresent: (_roomId: string, userId: string) =>
      Promise.resolve(options.present?.has(userId) ?? true),
    notify: (change: RoomFocusChange) => {
      calls.notified.push(change);
    },
    logger,
  };
  return { calls, deps };
};

// ---- Steps 4 and 7: the PostgreSQL-driven sweep -----------------------------------------

describe('room session sweep', () => {
  it('abandons an orphan older than 2 minutes as timer_lost, once, and announces it', async () => {
    const { roomId } = await insertRoom();
    const orphan = await insertSession({ roomId, ageMs: 3 * 60_000 });
    const { calls, deps } = fakes();

    const first = await sweepRoomSessions(deps);
    expect(first.outcomes).toEqual({ timer_lost: 1 });
    const row = await sessionRow(orphan.sessionId);
    expect(row).toMatchObject({
      status: 'abandoned',
      abandonReason: 'timer_lost',
      focusedSeconds: 0,
      runningSince: null,
    });
    expect(row.endedAt).not.toBeNull();
    expect(calls.notified.map((change) => change.kind)).toEqual(['session', 'participants']);
    const sessionChange = calls.notified[0];
    expect(sessionChange).toMatchObject({ kind: 'session', userId: orphan.userId });
    expect(sessionChange?.kind === 'session' ? sessionChange.session : undefined).toMatchObject({
      status: 'abandoned',
      abandonReason: 'timer_lost',
      context: { kind: 'room', roomId, focusRunId: orphan.runId },
    });

    // The second run finds nothing in progress: no repeat, no second announcement.
    const second = await sweepRoomSessions(deps);
    expect(second.outcomes).toEqual({});
    expect(calls.notified).toHaveLength(2);
  });

  it('leaves a young orphan alone (an opt-in may still be writing its ledger entry)', async () => {
    const { roomId } = await insertRoom();
    const young = await insertSession({ roomId, ageMs: 10_000 });
    const { calls, deps } = fakes();
    const summary = await sweepRoomSessions(deps);
    expect(summary.outcomes).toEqual({ orphan_too_young: 1 });
    expect((await sessionRow(young.sessionId)).status).toBe('in_progress');
    expect(calls.notified).toEqual([]);
  });

  it('reports a young orphan as too young even while another transaction holds its row', async () => {
    const { roomId } = await insertRoom();
    const young = await insertSession({ roomId, ageMs: 10_000 });
    const { deps } = fakes();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = db().transaction(async (tx) => {
      await tx
        .select()
        .from(focusSessions)
        .where(eq(focusSessions.id, young.sessionId))
        .for('update');
      locked();
      await held;
    });
    await lockTaken;
    try {
      expect((await sweepRoomSessions(deps)).outcomes).toEqual({ orphan_too_young: 1 });
    } finally {
      release();
      await holder;
    }
  });

  it('settles a closed run with several participants once per sweep', async () => {
    const { roomId } = await insertRoom();
    const runId = uuidv7();
    for (let index = 0; index < 3; index += 1) {
      const member = await insertSession({ roomId, runId, ageMs: 5 * 60_000 });
      await seedRun(member, { status: 'closed' });
    }
    const { calls, deps } = fakes();
    const summary = await sweepRoomSessions({ ...deps, batchSize: 2 });
    expect(summary.outcomes).toEqual({ run_settled: 3 });
    expect(calls.settleRun).toEqual([[roomId, runId]]);
  });

  it('resumes where a sweep stopped on its budget, so high user ids are not starved', async () => {
    const { roomId } = await insertRoom();
    const sessions = [];
    for (let index = 0; index < 4; index += 1) {
      sessions.push(await insertSession({ roomId, ageMs: 5 * 60_000 }));
    }
    const order = sessions.map((session) => session.userId).sort();
    const { calls, deps } = fakes();
    const cursor: { afterUserId: string | null } = { afterUserId: null };
    const sweepDeps = { ...deps, batchSize: 2, concurrency: 1, cursor };
    // A budget of one loop check plus the two sessions of the first batch (concurrency 1).
    let checks = 0;
    const first = await sweepRoomSessions(sweepDeps, () => checks++ < 3);
    expect(first.complete).toBe(false);
    expect(first.outcomes).toEqual({ timer_lost: 2 });
    expect(cursor.afterUserId).toBe(order[1]);
    // The next sweep starts after them and finishes, then resets the cursor.
    const second = await sweepRoomSessions(sweepDeps);
    expect(second.complete).toBe(true);
    expect(second.outcomes).toEqual({ timer_lost: 2 });
    expect(cursor.afterUserId).toBeNull();
    expect(calls.notified.filter((change) => change.kind === 'session')).toHaveLength(4);
  });

  it('treats a ledger entry of another session as no entry', async () => {
    const { roomId } = await insertRoom();
    const orphan = await insertSession({ roomId, ageMs: 5 * 60_000 });
    await seedRun(orphan, { participant: { sessionId: uuidv7() } });
    const { deps } = fakes();
    expect((await sweepRoomSessions(deps)).outcomes).toEqual({ timer_lost: 1 });
  });

  it('never touches solo sessions', async () => {
    const solo = await insertSession({ ageMs: 5 * 60_000 });
    const { calls, deps } = fakes();
    expect((await sweepRoomSessions(deps)).outcomes).toEqual({});
    expect((await sessionRow(solo.sessionId)).status).toBe('in_progress');
    expect(calls.notified).toEqual([]);
  });

  it('applies grace_expired through the service once the grace is over', async () => {
    const { roomId } = await insertRoom();
    const gone = await insertSession({ roomId, ageMs: 5 * 60_000 });
    const disconnectedAtMs = (await redisTimeMs(redis())) - 70_000;
    await seedRun(gone, {
      participant: { disconnectedAtMs, elapsedAtDisconnectMs: 30_000 },
    });
    const { calls, deps } = fakes();
    expect((await sweepRoomSessions(deps)).outcomes).toEqual({ grace_abandoned: 1 });
    expect(calls.graceExpired).toEqual([[roomId, gone.runId, gone.userId, disconnectedAtMs]]);
    expect(calls.ensureGrace).toEqual([]);
  });

  it('ensures the grace job with the remaining grace while the grace runs', async () => {
    const { roomId } = await insertRoom();
    const away = await insertSession({ roomId, ageMs: 5 * 60_000 });
    const disconnectedAtMs = (await redisTimeMs(redis())) - 20_000;
    await seedRun(away, { participant: { disconnectedAtMs, elapsedAtDisconnectMs: 30_000 } });
    const { calls, deps } = fakes();
    expect((await sweepRoomSessions(deps)).outcomes).toEqual({ grace_ensured: 1 });
    expect(calls.graceExpired).toEqual([]);
    expect(calls.ensureGrace).toHaveLength(1);
    expect(calls.ensureGrace[0]?.job).toEqual(
      expect.objectContaining({ userId: away.userId, disconnectedAtMs }),
    );
    const delay = calls.ensureGrace[0]?.delayMs ?? -1;
    expect(delay).toBeGreaterThan(30_000);
    expect(delay).toBeLessThanOrEqual(40_000);
  });

  it('records a missed disconnect late; a connected, present participant is left alone', async () => {
    const { roomId } = await insertRoom();
    const absent = await insertSession({ roomId, ageMs: 5 * 60_000 });
    const here = await insertSession({ roomId, ageMs: 5 * 60_000 });
    await seedRun(absent);
    await seedRun(here);
    const { calls, deps } = fakes({ present: new Set([here.userId]) });
    expect((await sweepRoomSessions(deps)).outcomes).toEqual({ late_grace: 1, connected: 1 });
    expect(calls.userLeftRoom).toEqual([[absent.userId, roomId]]);
  });

  it('settles a closed run through the service, and ensures the grace of a waiting participant', async () => {
    const { roomId } = await insertRoom();
    const connected = await insertSession({ roomId, ageMs: 5 * 60_000 });
    await seedRun(connected, { status: 'closed' });
    const waiting = await insertSession({ roomId, ageMs: 5 * 60_000 });
    const disconnectedAtMs = (await redisTimeMs(redis())) - 10_000;
    await seedRun(waiting, {
      status: 'closed',
      participant: { disconnectedAtMs, elapsedAtDisconnectMs: 100_000 },
    });
    const { calls, deps } = fakes({
      settleRun: (_roomId, runId) =>
        Promise.resolve(runId === waiting.runId ? 'pending_grace' : 'settled'),
    });
    const summary = await sweepRoomSessions(deps);
    expect(summary.outcomes).toEqual({ run_settled: 1, run_pending_grace: 1 });
    expect(calls.settleRun).toHaveLength(2);
    expect(calls.ensureGrace).toHaveLength(1);
    expect(calls.ensureGrace[0]?.job.userId).toBe(waiting.userId);
    expect(calls.ensureGrace[0]?.job.disconnectedAtMs).toBe(disconnectedAtMs);
  });

  it('counts one session failure and still decides the others', async () => {
    const { roomId } = await insertRoom();
    const healthy = await insertSession({ roomId, ageMs: 5 * 60_000 });
    const broken = await insertSession({ roomId, ageMs: 5 * 60_000 });
    await seedRun(healthy);
    await seedRun(broken);
    const { deps } = fakes();
    const failing = {
      ...deps,
      isPresent: (_room: string, userId: string) =>
        userId === broken.userId
          ? Promise.reject(new Error('redis hiccup'))
          : Promise.resolve(true),
    };
    const summary = await sweepRoomSessions(failing);
    expect(summary).toMatchObject({ failed: 1, complete: true, outcomes: { connected: 1 } });
  });

  it('stops starting sessions when told to, and reports the sweep incomplete', async () => {
    const { roomId } = await insertRoom();
    await insertSession({ roomId, ageMs: 5 * 60_000 });
    const { deps } = fakes();
    const summary = await sweepRoomSessions(deps, () => false);
    expect(summary).toEqual({ outcomes: {}, failed: 0, complete: false });
  });

  it('walks several batches', async () => {
    const { roomId } = await insertRoom();
    const sessions = [];
    for (let index = 0; index < 5; index += 1) {
      sessions.push(await insertSession({ roomId, ageMs: 5 * 60_000 }));
    }
    const { deps } = fakes();
    const summary = await sweepRoomSessions({ ...deps, batchSize: 2, concurrency: 2 });
    expect(summary.outcomes).toEqual({ timer_lost: 5 });
  });

  it('abandons an orphan exactly once when two sweeps race', async () => {
    const { roomId } = await insertRoom();
    const orphan = await insertSession({ roomId, ageMs: 5 * 60_000 });
    const first = fakes();
    const second = fakes();
    await Promise.all([sweepRoomSessions(first.deps), sweepRoomSessions(second.deps)]);
    expect((await sessionRow(orphan.sessionId)).abandonReason).toBe('timer_lost');
    const announced = [...first.calls.notified, ...second.calls.notified].filter(
      (change) => change.kind === 'session',
    );
    expect(announced).toHaveLength(1);
  });
});

// ---- Step 3: closed runs in the unsettled set -------------------------------------------

describe('unsettled runs', () => {
  it('settles every closed run; a waiting run is asked once per run; a failure never stops the rest', async () => {
    const { roomId } = await insertRoom();
    const runs = [uuidv7(), uuidv7(), uuidv7(), uuidv7()];
    for (const [index, runId] of runs.entries()) {
      await redis().zadd(redisKeys.unsettledRuns, 1000 + index, `${roomId}:${runId}`);
    }
    const answers: Record<string, 'settled' | 'pending_grace' | 'gone'> = {
      [runs[0] ?? '']: 'pending_grace',
      [runs[2] ?? '']: 'gone',
      [runs[3] ?? '']: 'settled',
    };
    const { calls, deps } = fakes({
      settleRun: (_room, runId) =>
        runId === runs[1]
          ? Promise.reject(new Error('boom'))
          : Promise.resolve(answers[runId] ?? 'settled'),
    });
    const summary = await settleUnsettledRuns({ ...deps, batchSize: 2 });
    expect(summary).toEqual({ settled: 1, pendingGrace: 1, gone: 1, failed: 1 });
    expect(calls.settleRun.map(([, runId]) => runId).sort()).toEqual([...runs].sort());
  });

  it('does nothing when there is nothing to settle', async () => {
    const { deps } = fakes();
    expect(await settleUnsettledRuns(deps)).toEqual({
      settled: 0,
      pendingGrace: 0,
      gone: 0,
      failed: 0,
    });
  });
});

// ---- The reconciler runs the steps -------------------------------------------------------

describe('reconciler wiring', () => {
  const reconcilerWith = (deps: ReturnType<typeof fakes>['deps']) =>
    createReconciler({
      redis: redis(),
      presence: { removeInstance: () => Promise.resolve() },
      instanceTtlMs: 30_000,
      intervalMs: 30_000,
      logger,
      roomFocus: deps,
    });

  it('runs steps 3, 4 and 7 in a full run and reports them', async () => {
    const { roomId } = await insertRoom();
    const orphan = await insertSession({ roomId, ageMs: 5 * 60_000 });
    const closedRun = uuidv7();
    await redis().zadd(redisKeys.unsettledRuns, 1000, `${roomId}:${closedRun}`);
    const { calls, deps } = fakes();
    const summary = await reconcilerWith(deps).run({
      schemaVersion: 1,
      trigger: 'schedule',
      correlationId: 'test',
    });
    expect(summary.unsettledRuns).toEqual({ settled: 1, pendingGrace: 0, gone: 0, failed: 0 });
    expect(summary.roomSessions?.outcomes).toEqual({ timer_lost: 1 });
    expect((await sessionRow(orphan.sessionId)).abandonReason).toBe('timer_lost');
    expect(calls.settleRun).toEqual([[roomId, closedRun]]);
  });

  it('a failing step 3 does not stop step 4 and 7, and the run still reports the failure', async () => {
    const { roomId } = await insertRoom();
    const orphan = await insertSession({ roomId, ageMs: 5 * 60_000 });
    const { deps } = fakes();
    const brokenLedger: RunLedger = {
      ...createRunLedger(redis()),
      unsettled: () => Promise.reject(new Error('ledger read failed')),
    };
    await expect(
      reconcilerWith({ ...deps, ledger: brokenLedger }).run({
        schemaVersion: 1,
        trigger: 'schedule',
        correlationId: 'test',
      }),
    ).rejects.toThrow('ledger read failed');
    expect((await sessionRow(orphan.sessionId)).abandonReason).toBe('timer_lost');
  });
});

// ---- Global recovery ---------------------------------------------------------------------

describe('global recovery after a Redis data loss', () => {
  it('abandons every room session the new ledger does not know, never a solo session', async () => {
    const { roomId } = await insertRoom();
    const lostA = await insertSession({ roomId, ageMs: 30 * 60_000 });
    const lostB = await insertSession({ roomId, ageMs: 60_000 });
    const solo = await insertSession({ ageMs: 30 * 60_000 });
    const { calls, deps } = fakes();

    const summary = await recoverRoomFocusAfterRedisLoss(deps);
    expect(summary).toEqual({ scanned: 2, abandoned: 2, skipped: 0, failed: 0 });
    for (const lost of [lostA, lostB]) {
      expect(await sessionRow(lost.sessionId)).toMatchObject({
        status: 'abandoned',
        abandonReason: 'timer_lost',
        focusedSeconds: 0,
      });
    }
    expect((await sessionRow(solo.sessionId)).status).toBe('in_progress');
    expect(calls.notified.filter((change) => change.kind === 'session')).toHaveLength(2);
    expect(calls.notified.filter((change) => change.kind === 'participants')).toEqual([
      { kind: 'participants', roomId },
    ]);
  });

  it('runs exactly once: a repeated or concurrent run abandons and announces nothing twice', async () => {
    const { roomId } = await insertRoom();
    for (let index = 0; index < 4; index += 1) {
      await insertSession({ roomId, ageMs: 30 * 60_000 });
    }
    const a = fakes();
    const b = fakes();
    await Promise.all([
      recoverRoomFocusAfterRedisLoss({ ...a.deps, batchSize: 2 }),
      recoverRoomFocusAfterRedisLoss({ ...b.deps, batchSize: 2 }),
    ]);
    const announced = [...a.calls.notified, ...b.calls.notified].filter(
      (change) => change.kind === 'session',
    );
    expect(announced).toHaveLength(4);
    const again = fakes();
    expect(await recoverRoomFocusAfterRedisLoss(again.deps)).toMatchObject({
      scanned: 0,
      abandoned: 0,
    });
    expect(again.calls.notified).toEqual([]);
  });

  it('keeps a session that opted in after the loss (it has a ledger entry) and a brand-new one', async () => {
    const { roomId } = await insertRoom();
    const kept = await insertSession({ roomId, ageMs: 60_000 });
    await seedRun(kept);
    const fresh = await insertSession({ roomId, ageMs: 1_000 });
    const { calls, deps } = fakes();
    expect(await recoverRoomFocusAfterRedisLoss(deps)).toEqual({
      scanned: 2,
      abandoned: 0,
      skipped: 2,
      failed: 0,
    });
    expect((await sessionRow(kept.sessionId)).status).toBe('in_progress');
    expect((await sessionRow(fresh.sessionId)).status).toBe('in_progress');
    expect(calls.notified).toEqual([]);
  });

  it('commits the abandonment even when the announcement fails', async () => {
    const { roomId } = await insertRoom();
    const lost = await insertSession({ roomId, ageMs: 30 * 60_000 });
    const { deps } = fakes();
    const summary = await recoverRoomFocusAfterRedisLoss({
      ...deps,
      notify: () => Promise.reject(new Error('socket emitter down')),
    });
    expect(summary.abandoned).toBe(1);
    expect((await sessionRow(lost.sessionId)).abandonReason).toBe('timer_lost');
  });
});
