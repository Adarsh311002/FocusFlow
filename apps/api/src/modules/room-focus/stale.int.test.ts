import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startTestHarness, stopTestHarness, type TestHarness } from '../../../test/harness.js';
import { focusSessions, rooms, users } from '../../db/schema.js';
import { redisKeys } from '../../platform/redis-keys.js';
import { createReconciler } from '../reconciler/reconciler.js';
import type { TimerState } from '../room-timer/types.js';
import { createRunLedger } from './ledger.js';
import {
  expireStaleRoomSession,
  listStaleRoomSessions,
  type StaleCleanup,
  type StaleRoomDeps,
  sweepStaleRoomSessions,
} from './stale.js';
import {
  type LedgerParticipant,
  ROOM_STALE_AFTER_MS,
  ROOM_STALE_HARD_MAX_MS,
  type RoomFocusChange,
} from './types.js';

// RF17: stale room focus sessions against real PostgreSQL and Redis. The room timer is a
// fake (`get` returns the state the test sets), the ledger is the real one.

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
const HOUR_MS = 60 * 60 * 1_000;

beforeAll(async () => {
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

const insertRoom = async (): Promise<string> => {
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
  const code = `S${CODE_ALPHABET[Math.floor(roomSeq / 31) % 31] ?? 'A'}${CODE_ALPHABET[roomSeq % 31] ?? 'A'}ZZZ`;
  roomSeq += 1;
  await db().insert(rooms).values({ id: roomId, code, name: 'Room', hostId, isPrivate: false });
  return roomId;
};

const insertSession = async (options: { ageMs: number; solo?: boolean }): Promise<Fixture> => {
  const roomId = options.solo === true ? '' : await insertRoom();
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
  const runId = uuidv7();
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
      ...(options.solo === true ? { runningSince: startedAt } : { roomId, focusRunId: runId }),
    });
  return { roomId, runId, userId, sessionId };
};

const seedRun = async (
  fixture: Fixture,
  options: {
    status?: 'open' | 'closed';
    participant?: Partial<LedgerParticipant> | null;
  } = {},
): Promise<void> => {
  const { roomId, runId, userId, sessionId } = fixture;
  const status = options.status ?? 'open';
  await redis().hset(redisKeys.roomRun(roomId, runId), {
    status,
    openedAtMs: '1000',
    ...(status === 'closed'
      ? { closeReason: 'reset', closedAtMs: '2000', elapsedAtCloseMs: '600000' }
      : {}),
  });
  if (options.participant !== null) {
    const participant: LedgerParticipant = {
      userId,
      sessionId,
      optedInAtMs: 1_000,
      elapsedAtOptInMs: 0,
      disconnectedAtMs: null,
      elapsedAtDisconnectMs: null,
      ...options.participant,
    };
    await redis().hset(redisKeys.roomRunParticipants(roomId, runId), {
      [userId]: JSON.stringify(participant),
    });
  }
};

const sessionRow = async (sessionId: string) => {
  const [row] = await db().select().from(focusSessions).where(eq(focusSessions.id, sessionId));
  if (row === undefined) {
    throw new Error('no such session');
  }
  return row;
};

const ledgerHas = async (fixture: Fixture): Promise<boolean> =>
  (await createRunLedger(redis()).read(fixture.roomId, fixture.runId)).participants.length > 0;

const focusTimer = (fixture: Fixture, overrides: Partial<TimerState> = {}): TimerState => ({
  phase: 'focus',
  status: 'paused',
  durationMs: 1_500_000,
  elapsedBeforeMs: 900_000,
  segmentStartedAtMs: null,
  version: 1,
  focusRunId: fixture.runId,
  ...overrides,
});

type Harnessed = {
  readonly deps: StaleRoomDeps;
  readonly notified: RoomFocusChange[];
};

const setup = (
  timerOf: (roomId: string) => TimerState | undefined,
  options: { ledger?: StaleRoomDeps['ledger'] } = {},
): Harnessed => {
  const notified: RoomFocusChange[] = [];
  return {
    notified,
    deps: {
      db: db(),
      ledger: options.ledger ?? createRunLedger(redis()),
      timer: {
        get: (roomId) => {
          const state = timerOf(roomId);
          return Promise.resolve(state === undefined ? undefined : { state, nowMs: Date.now() });
        },
      },
      notify: (change) => {
        notified.push(change);
      },
      logger,
    },
  };
};

const sweep = (deps: StaleRoomDeps, cleanups: StaleCleanup[] = []) =>
  sweepStaleRoomSessions({ ...deps, cleanups });

// ---- Tests ------------------------------------------------------------------------------

describe('stale room sessions (RF17)', () => {
  it('lists only room sessions of 12 hours or more, never a solo one', async () => {
    const young = await insertSession({ ageMs: ROOM_STALE_AFTER_MS - 60_000 });
    const old = await insertSession({ ageMs: ROOM_STALE_AFTER_MS + 1_000 });
    const solo = await insertSession({ ageMs: 20 * HOUR_MS, solo: true });
    const keys = await listStaleRoomSessions(db(), {
      afterUserId: null,
      limit: 100,
      staleAfterMs: ROOM_STALE_AFTER_MS,
    });
    const ids = keys.map((key) => key.id);
    expect(ids).toContain(old.sessionId);
    expect(ids).not.toContain(young.sessionId);
    expect(ids).not.toContain(solo.sessionId);
  });

  it('expires a paused session with the focused time the timer proves, and cleans the ledger', async () => {
    const f = await insertSession({ ageMs: 13 * HOUR_MS });
    await seedRun(f);
    const { deps, notified } = setup(() => focusTimer(f));
    const summary = await sweep(deps);
    expect(summary.outcomes).toEqual({ expired: 1 });
    const row = await sessionRow(f.sessionId);
    expect(row.status).toBe('abandoned');
    expect(row.abandonReason).toBe('expired');
    expect(row.focusedSeconds).toBe(900);
    expect(row.endedAt).not.toBeNull();
    expect(await ledgerHas(f)).toBe(false);
    expect(notified.map((change) => change.kind).sort()).toEqual(['participants', 'session']);
  });

  it('counts only up to a recorded disconnect', async () => {
    const f = await insertSession({ ageMs: 13 * HOUR_MS });
    await seedRun(f, {
      participant: { disconnectedAtMs: 5_000, elapsedAtDisconnectMs: 300_000 },
    });
    const { deps } = setup(() => focusTimer(f));
    await sweep(deps);
    expect((await sessionRow(f.sessionId)).focusedSeconds).toBe(300);
  });

  it('counts 0 s without a ledger entry (nothing can be proven)', async () => {
    const f = await insertSession({ ageMs: 13 * HOUR_MS });
    await seedRun(f, { participant: null });
    const { deps } = setup(() => focusTimer(f));
    await sweep(deps);
    const row = await sessionRow(f.sessionId);
    expect(row.abandonReason).toBe('expired');
    expect(row.focusedSeconds).toBe(0);
  });

  it('expires a session of an idle run', async () => {
    const f = await insertSession({ ageMs: 13 * HOUR_MS });
    await seedRun(f);
    const { deps } = setup(() => focusTimer(f, { status: 'idle', elapsedBeforeMs: 0 }));
    await sweep(deps);
    const row = await sessionRow(f.sessionId);
    expect(row.abandonReason).toBe('expired');
    expect(row.focusedSeconds).toBe(0);
  });

  it('lets a running phase finish before the 16 h maximum, and expires it after', async () => {
    const f = await insertSession({ ageMs: 13 * HOUR_MS });
    await seedRun(f);
    const running = focusTimer(f, {
      status: 'running',
      segmentStartedAtMs: Date.now() - 60_000,
      elapsedBeforeMs: 0,
    });
    const first = await sweep(setup(() => running).deps);
    expect(first.outcomes).toEqual({ running: 1 });
    expect((await sessionRow(f.sessionId)).status).toBe('in_progress');

    const g = await insertSession({ ageMs: ROOM_STALE_HARD_MAX_MS + 1_000 });
    await seedRun(g);
    const second = await sweep(
      setup(() =>
        focusTimer(g, {
          status: 'running',
          segmentStartedAtMs: Date.now() - 60_000,
          elapsedBeforeMs: 0,
        }),
      ).deps,
    );
    expect(second.outcomes.expired).toBeGreaterThanOrEqual(1);
    expect((await sessionRow(g.sessionId)).abandonReason).toBe('expired');
  });

  it('leaves a closed, unsettled run to its settlement until the maximum, then expires it with the frozen time', async () => {
    const f = await insertSession({ ageMs: 13 * HOUR_MS });
    await seedRun(f, { status: 'closed' });
    const first = await sweep(setup(() => undefined).deps);
    expect(first.outcomes).toEqual({ closed_run: 1 });
    expect((await sessionRow(f.sessionId)).status).toBe('in_progress');

    const g = await insertSession({ ageMs: ROOM_STALE_HARD_MAX_MS + 1_000 });
    await seedRun(g, { status: 'closed' });
    await sweep(setup(() => undefined).deps);
    const row = await sessionRow(g.sessionId);
    expect(row.abandonReason).toBe('expired');
    expect(row.focusedSeconds).toBe(600);
  });

  it('defers everything while Redis cannot answer, and discards no focused time', async () => {
    const f = await insertSession({ ageMs: ROOM_STALE_HARD_MAX_MS + HOUR_MS });
    await seedRun(f);
    const broken = createRunLedger(redis());
    const { deps } = setup(() => focusTimer(f), {
      ledger: {
        ...broken,
        read: () => Promise.reject(new Error('redis is down')),
      },
    });
    const summary = await sweep(deps);
    expect(summary.outcomes).toEqual({ redis_unavailable: 1 });
    expect((await sessionRow(f.sessionId)).status).toBe('in_progress');

    // Redis is back: the next sweep expires it with the proven time.
    await sweep(setup(() => focusTimer(f)).deps);
    const row = await sessionRow(f.sessionId);
    expect(row.abandonReason).toBe('expired');
    expect(row.focusedSeconds).toBe(900);
  });

  it('keeps a failed ledger cleanup and retries it on the next sweep', async () => {
    const f = await insertSession({ ageMs: 13 * HOUR_MS });
    await seedRun(f);
    const real = createRunLedger(redis());
    let failing = true;
    const { deps, notified } = setup(() => focusTimer(f), {
      ledger: {
        ...real,
        removeParticipant: (...args) =>
          failing ? Promise.reject(new Error('redis is down')) : real.removeParticipant(...args),
      },
    });
    const cleanups: StaleCleanup[] = [];
    const first = await sweep(deps, cleanups);
    expect(first.outcomes).toEqual({ expired: 1 });
    expect(first.cleanupsPending).toBe(1);
    expect((await sessionRow(f.sessionId)).abandonReason).toBe('expired');
    expect(await ledgerHas(f)).toBe(true);
    expect(notified.map((change) => change.kind)).toEqual(['session']);

    failing = false;
    const second = await sweepStaleRoomSessions({ ...deps, cleanups });
    expect(second.cleanupsPending).toBe(0);
    expect(await ledgerHas(f)).toBe(false);
    expect(notified.map((change) => change.kind)).toEqual(['session', 'participants']);
  });

  it('is idempotent: repeated and concurrent sweeps expire and announce once', async () => {
    const f = await insertSession({ ageMs: 13 * HOUR_MS });
    await seedRun(f);
    const { deps, notified } = setup(() => focusTimer(f));
    await Promise.all([sweep(deps), sweep(deps), sweep(deps)]);
    const again = await sweep(deps);
    expect(again.outcomes).toEqual({});
    expect(notified.filter((change) => change.kind === 'session')).toHaveLength(1);
    expect((await sessionRow(f.sessionId)).abandonReason).toBe('expired');
  });

  it('re-checks the age under the lock: a session that is not stale is left alone', async () => {
    const f = await insertSession({ ageMs: ROOM_STALE_AFTER_MS - 5_000 });
    await seedRun(f);
    const { deps } = setup(() => focusTimer(f));
    const outcome = await expireStaleRoomSession(
      deps,
      {
        id: f.sessionId,
        userId: f.userId,
        roomId: f.roomId,
        focusRunId: f.runId,
        ageMs: ROOM_STALE_AFTER_MS + 1_000,
      },
      [],
    );
    expect(outcome).toBe('not_stale');
    expect((await sessionRow(f.sessionId)).status).toBe('in_progress');
  });

  it('never touches a solo session, however old', async () => {
    const solo = await insertSession({ ageMs: 30 * HOUR_MS, solo: true });
    const { deps } = setup(() => undefined);
    const summary = await sweep(deps);
    expect(summary.outcomes).toEqual({});
    expect((await sessionRow(solo.sessionId)).status).toBe('in_progress');
  });

  it('runs as reconciler step 6b', async () => {
    const f = await insertSession({ ageMs: 13 * HOUR_MS });
    await seedRun(f);
    const { deps, notified } = setup(() => focusTimer(f));
    const reconciler = createReconciler({
      redis: redis(),
      presence: { removeInstance: () => Promise.resolve() },
      instanceTtlMs: 30_000,
      intervalMs: 30_000,
      logger,
      roomFocus: {
        db: db(),
        ledger: createRunLedger(redis()),
        service: {
          settleRun: () => Promise.resolve('gone'),
          graceExpired: () => Promise.resolve('stale'),
          userLeftRoom: () => Promise.resolve(),
        },
        scheduler: { ensureGrace: () => Promise.resolve() },
        isPresent: () => Promise.resolve(true),
        timer: deps.timer,
        notify: deps.notify,
      },
    });
    const summary = await reconciler.run({
      schemaVersion: 1,
      trigger: 'schedule',
      correlationId: 'stale-test',
    });
    expect(summary.staleRoomSessions?.outcomes).toEqual({ expired: 1 });
    expect((await sessionRow(f.sessionId)).abandonReason).toBe('expired');
    expect(notified.some((change) => change.kind === 'session')).toBe(true);
  });
});
