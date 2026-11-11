import { fileURLToPath } from 'node:url';

import type { TimerCommand } from '@focus-flow/contracts';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Redis } from 'ioredis';
import pg from 'pg';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createStubLogger } from '../../../test/rooms.js';
import { createDb, type Db } from '../../db/client.js';
import { rooms, users } from '../../db/schema.js';
import { redisTimeMs } from '../../platform/redis.js';
import { redisKeys } from '../../platform/redis-keys.js';
import { createRoomTimerService } from './service.js';
import { createTimerSettingsReader } from './settings.js';
import { createRoomTimerStore } from './store.js';
import type { RoomTimerService, RoomTimerStore, TimerChange, TimerState } from './types.js';

// The timer service on real PostgreSQL (saved durations) and Redis (state, TIME, the
// version-checked write). No API runtime is started, so nothing else touches the timers.
// The shortest allowed phase is 60 s: due and early cases are crafted through the store
// with chosen timestamps instead of waiting.

let postgres: StartedPostgreSqlContainer;
let redisContainer: StartedRedisContainer;
let pool: pg.Pool;
let db: Db;
let redis: Redis;
let store: RoomTimerStore;
let hostId: string;

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:18').start();
  redisContainer = await new RedisContainer('redis:7.4-alpine').start();
  pool = new pg.Pool({ connectionString: postgres.getConnectionUri() });
  await migrate(drizzle(pool), {
    migrationsFolder: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
  });
  db = createDb(pool);
  redis = new Redis(redisContainer.getConnectionUrl(), { keyPrefix: 'ff-test:' });
  store = createRoomTimerStore(redis);
  hostId = uuidv7();
  await db.insert(users).values({ id: hostId, email: 'host@example.test', displayName: 'Host' });
}, 240_000);

afterAll(async () => {
  redis.disconnect();
  await pool.end();
  await redisContainer.stop();
  await postgres.stop();
}, 60_000);

beforeEach(async () => {
  await redis.flushall();
});

type Harness = {
  readonly roomId: string;
  readonly service: RoomTimerService;
  readonly changes: TimerChange[];
  readonly errors: ReturnType<typeof createStubLogger>['spies'];
};

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
let codeCounter = 0;
/** A unique six-character room code from the allowed alphabet (M2). */
const nextCode = (): string => {
  codeCounter += 1;
  let rest = codeCounter;
  let code = '';
  for (let index = 0; index < 6; index += 1) {
    code += CODE_ALPHABET.charAt(rest % CODE_ALPHABET.length);
    rest = Math.floor(rest / CODE_ALPHABET.length);
  }
  return code;
};

const newRoom = async (
  settings: { focusSeconds?: number; shortBreakSeconds?: number; longBreakSeconds?: number } = {},
): Promise<Harness> => {
  const roomId = uuidv7();
  await db.insert(rooms).values({
    id: roomId,
    code: nextCode(),
    name: 'Timer room',
    hostId,
    isPrivate: false,
    ...settings,
  });
  const { logger, spies } = createStubLogger();
  const service = createRoomTimerService({
    store,
    readSettings: createTimerSettingsReader(db),
    logger,
  });
  const changes: TimerChange[] = [];
  service.onChange((change) => {
    changes.push(change);
  });
  return { roomId, service, changes, errors: spies };
};

const must = <T>(value: T | null | undefined): T => {
  if (value === undefined || value === null) {
    throw new Error('expected a value');
  }
  return value;
};

const okState = async (service: RoomTimerService, roomId: string, command: TimerCommand) => {
  const outcome = await service.command(roomId, command);
  if (!outcome.ok) {
    throw new Error(`command ${command.type} was rejected: ${outcome.code}`);
  }
  return outcome;
};

const versionsOf = (changes: readonly TimerChange[]): number[] =>
  changes.map((change) => change.state.version);

describe('get', () => {
  it('creates the timer once from the saved durations, however many callers race', async () => {
    const { roomId, service, changes } = await newRoom({ focusSeconds: 600 });
    const before = await redisTimeMs(redis);
    const results = await Promise.all(Array.from({ length: 20 }, () => service.get(roomId)));
    const after = await redisTimeMs(redis);

    const first = must(results[0]);
    expect(first.state).toMatchObject({
      phase: 'focus',
      status: 'idle',
      durationMs: 600_000,
      elapsedBeforeMs: 0,
      segmentStartedAtMs: null,
    });
    // RT2: the version starts at the Redis TIME in milliseconds.
    expect(first.state.version).toBeGreaterThanOrEqual(before);
    expect(first.state.version).toBeLessThanOrEqual(after);
    for (const result of results) {
      expect(result?.state).toEqual(first.state);
    }
    expect(changes.map((change) => change.cause)).toEqual(['created']);
    expect(changes[0]?.state).toEqual(first.state);
    expect((await store.read(roomId)).state).toEqual(first.state);
  });

  it('answers undefined for a room that does not exist and writes nothing', async () => {
    const { service } = await newRoom();
    const unknown = uuidv7();
    expect(await service.get(unknown)).toBeUndefined();
    expect((await store.read(unknown)).state).toBeUndefined();
    expect(await redis.exists(redisKeys.roomTimer(unknown))).toBe(0);
  });

  it('surfaces a malformed stored timer instead of replacing it', async () => {
    const { roomId, service } = await newRoom();
    await redis.hset(redisKeys.roomTimer(roomId), { phase: 'focus' });
    await expect(service.get(roomId)).rejects.toThrow(/malformed/);
    await expect(service.command(roomId, { type: 'start' })).rejects.toThrow(/malformed/);
  });
});

describe('command', () => {
  it('materialises an absent timer, then applies the command, announcing both', async () => {
    const { roomId, service, changes } = await newRoom();
    const t0 = await redisTimeMs(redis);
    const outcome = await okState(service, roomId, { type: 'start' });
    const t1 = await redisTimeMs(redis);

    expect(outcome.state.status).toBe('running');
    // Redis TIME is the clock for the segment start.
    expect(outcome.state.segmentStartedAtMs).toBeGreaterThanOrEqual(t0);
    expect(outcome.state.segmentStartedAtMs).toBeLessThanOrEqual(t1);
    expect(outcome.nowMs).toBe(outcome.state.segmentStartedAtMs);
    expect(changes.map((change) => change.cause)).toEqual(['created', 'command']);
    expect(outcome.state.version).toBe(must(changes[0]).state.version + 1);
    // Running timers are indexed by their end.
    expect(await redis.zscore(redisKeys.runningTimers, roomId)).toBe(
      String(must(outcome.state.segmentStartedAtMs) + outcome.state.durationMs),
    );
  });

  it('walks start, pause, resume, reset with versions strictly +1 and the index in step', async () => {
    const { roomId, service, changes } = await newRoom();
    const created = must(await service.get(roomId));
    const started = await okState(service, roomId, { type: 'start' });
    const paused = await okState(service, roomId, { type: 'pause' });
    expect(paused.state).toMatchObject({ status: 'paused', segmentStartedAtMs: null });
    expect(await redis.zscore(redisKeys.runningTimers, roomId)).toBeNull();
    const resumed = await okState(service, roomId, { type: 'resume' });
    expect(await redis.zscore(redisKeys.runningTimers, roomId)).not.toBeNull();
    const reset = await okState(service, roomId, {
      type: 'reset',
      expectedVersion: resumed.state.version,
    });
    expect(reset.state).toMatchObject({ status: 'idle', elapsedBeforeMs: 0 });
    expect(await redis.zscore(redisKeys.runningTimers, roomId)).toBeNull();

    expect([created, started, paused, resumed, reset].map((step) => step.state.version)).toEqual(
      Array.from({ length: 5 }, (_, index) => created.state.version + index),
    );
    expect(versionsOf(changes)).toEqual(
      Array.from({ length: 5 }, (_, index) => created.state.version + index),
    );
  });

  it('writes nothing for a repeated pause or resume: no version bump, no listener call', async () => {
    const { roomId, service, changes } = await newRoom();
    await okState(service, roomId, { type: 'start' });
    const paused = await okState(service, roomId, { type: 'pause' });
    const seen = changes.length;
    const again = await okState(service, roomId, { type: 'pause' });
    expect(again.state).toEqual(paused.state);
    expect(changes).toHaveLength(seen);
    const resumed = await okState(service, roomId, { type: 'resume' });
    const seenAfterResume = changes.length;
    const resumedAgain = await okState(service, roomId, { type: 'resume' });
    expect(resumedAgain.state).toEqual(resumed.state);
    expect(changes).toHaveLength(seenAfterResume);
    expect((await store.read(roomId)).state?.version).toBe(resumed.state.version);
  });

  it('rejects invalid transitions with the current state', async () => {
    const { roomId, service } = await newRoom();
    const created = must(await service.get(roomId));
    for (const command of [{ type: 'pause' }, { type: 'resume' }] as const) {
      const outcome = await service.command(roomId, command);
      expect(outcome).toMatchObject({
        ok: false,
        code: 'INVALID_TRANSITION',
        state: created.state,
      });
      expect(typeof (outcome.ok ? 0 : outcome.nowMs)).toBe('number');
    }
    const started = await okState(service, roomId, { type: 'start' });
    expect(await service.command(roomId, { type: 'start' })).toMatchObject({
      ok: false,
      code: 'INVALID_TRANSITION',
      state: started.state,
    });
    expect(
      await service.command(roomId, {
        type: 'setPhase',
        phase: 'focus',
        expectedVersion: started.state.version,
      }),
    ).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });
    expect((await store.read(roomId)).state).toEqual(started.state);
  });

  it('answers VERSION_CONFLICT with the current state for a stale expectedVersion', async () => {
    const { roomId, service } = await newRoom();
    const created = must(await service.get(roomId));
    const started = await okState(service, roomId, { type: 'start' });
    for (const command of [
      { type: 'reset', expectedVersion: created.state.version },
      { type: 'setPhase', phase: 'short_break', expectedVersion: created.state.version },
    ] as const) {
      const outcome = await service.command(roomId, command);
      expect(outcome).toMatchObject({ ok: false, code: 'VERSION_CONFLICT', state: started.state });
    }
    expect((await store.read(roomId)).state).toEqual(started.state);
  });

  it('applies exactly one of many identical reset commands', async () => {
    const { roomId, service, changes } = await newRoom();
    const started = await okState(service, roomId, { type: 'start' });
    const seen = changes.length;
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, () =>
        service.command(roomId, { type: 'reset', expectedVersion: started.state.version }),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    for (const outcome of outcomes) {
      if (outcome.ok) {
        continue;
      }
      expect(outcome).toMatchObject({ code: 'VERSION_CONFLICT' });
      expect(outcome.state?.version).toBe(started.state.version + 1);
    }
    expect(changes).toHaveLength(seen + 1);
    expect((await store.read(roomId)).state?.version).toBe(started.state.version + 1);
  });

  it('collapses concurrent identical pauses into one change', async () => {
    const { roomId, service, changes } = await newRoom();
    const started = await okState(service, roomId, { type: 'start' });
    const seen = changes.length;
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => service.command(roomId, { type: 'pause' })),
    );
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    expect(changes).toHaveLength(seen + 1);
    expect((await store.read(roomId)).state).toMatchObject({
      status: 'paused',
      version: started.state.version + 1,
    });
  });

  it('loses no update when pauses and resumes race: committed versions are consecutive', async () => {
    const { roomId, service, changes } = await newRoom();
    const started = await okState(service, roomId, { type: 'start' });
    const seen = changes.length;
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        service.command(roomId, { type: index % 2 === 0 ? 'pause' : 'resume' }),
      ),
    );
    // A command that lost three races in a row answers VERSION_CONFLICT; nothing else fails.
    for (const outcome of outcomes) {
      expect(outcome.ok || outcome.code === 'VERSION_CONFLICT').toBe(true);
    }
    const committed = changes.slice(seen);
    expect(committed.length).toBeGreaterThan(0);
    const final = must((await store.read(roomId)).state);
    expect(versionsOf(committed).sort((a, b) => a - b)).toEqual(
      Array.from({ length: committed.length }, (_, index) => started.state.version + 1 + index),
    );
    expect(final.version).toBe(started.state.version + committed.length);
    // The running index agrees with the final state.
    expect(await redis.zscore(redisKeys.runningTimers, roomId)).toEqual(
      final.status === 'running' ? expect.any(String) : null,
    );
  });

  it('answers ROOM_NOT_FOUND for an unknown room', async () => {
    const { service } = await newRoom();
    expect(await service.command(uuidv7(), { type: 'start' })).toMatchObject({
      ok: false,
      code: 'ROOM_NOT_FOUND',
    });
  });

  it('never fails the command because a listener throws', async () => {
    const { roomId, service, errors } = await newRoom();
    const later: TimerChange[] = [];
    service.onChange(() => {
      throw new Error('listener exploded');
    });
    service.onChange((change) => {
      later.push(change);
    });
    service.onChange(() => Promise.reject(new Error('async listener exploded')));
    const outcome = await okState(service, roomId, { type: 'start' });
    expect(outcome.state.status).toBe('running');
    expect(later.map((change) => change.cause)).toEqual(['created', 'command']);
    expect(errors.error).toHaveBeenCalled();
    expect((await store.read(roomId)).state).toEqual(outcome.state);
  });
});

describe('settings', () => {
  it('apply from the next phase only: the current phase keeps its duration', async () => {
    const { roomId, service } = await newRoom({ focusSeconds: 1500, shortBreakSeconds: 300 });
    const started = await okState(service, roomId, { type: 'start' });
    await db
      .update(rooms)
      .set({ focusSeconds: 120, shortBreakSeconds: 90 })
      .where(eq(rooms.id, roomId));
    const paused = await okState(service, roomId, { type: 'pause' });
    expect(paused.state.durationMs).toBe(1_500_000);
    expect(started.state.durationMs).toBe(1_500_000);

    // "Apply now" is a reset: the new duration is read at that moment.
    const reset = await okState(service, roomId, {
      type: 'reset',
      expectedVersion: paused.state.version,
    });
    expect(reset.state.durationMs).toBe(120_000);

    const toBreak = await okState(service, roomId, {
      type: 'setPhase',
      phase: 'short_break',
      expectedVersion: reset.state.version,
    });
    expect(toBreak.state).toMatchObject({ phase: 'short_break', durationMs: 90_000 });
  });
});

describe('completePhase', () => {
  /** Writes a running timer that reached zero `overdueMs` ago (negative: still `leftMs` to go). */
  const craftRunning = async (
    roomId: string,
    version: number,
    offsetMs: number,
    durationMs = 60_000,
  ): Promise<TimerState> => {
    const nowMs = await redisTimeMs(redis);
    const state: TimerState = {
      phase: 'focus',
      status: 'running',
      durationMs,
      elapsedBeforeMs: 0,
      segmentStartedAtMs: nowMs - durationMs - offsetMs,
      version,
      focusRunId: null,
    };
    await redis.del(redisKeys.roomTimer(roomId));
    expect(await store.write(roomId, null, state)).toBe('ok');
    return state;
  };

  it('does nothing for an absent timer, a stale version or a timer that is not running', async () => {
    const { roomId, service, changes } = await newRoom({ shortBreakSeconds: 300 });
    expect(await service.completePhase(roomId, 1)).toEqual({ result: 'noop' });
    expect(await redis.exists(redisKeys.roomTimer(roomId))).toBe(0);

    const created = must(await service.get(roomId));
    expect(await service.completePhase(roomId, created.state.version)).toEqual({ result: 'noop' });
    await craftRunning(roomId, 500, 1000);
    expect(await service.completePhase(roomId, 499)).toEqual({ result: 'noop' });
    expect(await service.completePhase(roomId, 501)).toEqual({ result: 'noop' });
    expect((await store.read(roomId)).state?.version).toBe(500);
    expect(changes.map((change) => change.cause)).toEqual(['created']);
  });

  it('answers early, with the remaining time, when the phase has not reached zero', async () => {
    const { roomId, service, changes } = await newRoom();
    await craftRunning(roomId, 700, -30_000);
    const outcome = await service.completePhase(roomId, 700);
    expect(outcome.result).toBe('early');
    if (outcome.result === 'early') {
      expect(outcome.delayMs).toBeGreaterThan(25_000);
      expect(outcome.delayMs).toBeLessThanOrEqual(30_000);
    }
    expect((await store.read(roomId)).state?.version).toBe(700);
    expect(changes).toHaveLength(0);
  });

  it('advances a due phase to an idle next phase using the settings of that moment', async () => {
    const { roomId, service, changes } = await newRoom({ shortBreakSeconds: 300 });
    await craftRunning(roomId, 900, 1000);
    // Changed after the phase began: it applies to the phase being created now.
    await db.update(rooms).set({ shortBreakSeconds: 100 }).where(eq(rooms.id, roomId));
    const outcome = await service.completePhase(roomId, 900);
    expect(outcome.result).toBe('advanced');
    const next = (await store.read(roomId)).state;
    expect(next).toEqual({
      phase: 'short_break',
      status: 'idle',
      durationMs: 100_000,
      elapsedBeforeMs: 0,
      segmentStartedAtMs: null,
      version: 901,
      focusRunId: null,
    });
    expect(await redis.zscore(redisKeys.runningTimers, roomId)).toBeNull();
    expect(changes.map((change) => change.cause)).toEqual(['phase_end']);
    expect(changes[0]?.state).toEqual(next);
  });

  it('advances exactly once when the same job runs concurrently', async () => {
    const { roomId, service, changes } = await newRoom();
    await craftRunning(roomId, 1100, 500);
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => service.completePhase(roomId, 1100)),
    );
    expect(outcomes.filter((outcome) => outcome.result === 'advanced')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.result === 'noop')).toHaveLength(9);
    expect(changes.map((change) => change.cause)).toEqual(['phase_end']);
    expect((await store.read(roomId)).state?.version).toBe(1101);
    // A later duplicate is a no-op too.
    expect(await service.completePhase(roomId, 1100)).toEqual({ result: 'noop' });
  });

  it('loses against a host reset that came first, and refuses a pause at zero', async () => {
    const { roomId, service } = await newRoom();
    await craftRunning(roomId, 1300, 500);
    // A pause at or after zero is refused (the phase end must not be turned into a no-op).
    expect(await service.command(roomId, { type: 'pause' })).toMatchObject({
      ok: false,
      code: 'INVALID_TRANSITION',
    });
    // The host resets first: the job's version is stale afterwards.
    await okState(service, roomId, { type: 'reset', expectedVersion: 1300 });
    expect(await service.completePhase(roomId, 1300)).toEqual({ result: 'noop' });
  });
});

describe('Redis data loss', () => {
  it('recreates the timer with a version above any version issued before the loss', async () => {
    const { roomId, service } = await newRoom();
    await okState(service, roomId, { type: 'start' });
    const before = must((await store.read(roomId)).state).version;

    // The version base is Redis TIME in ms, so the recreated timer is above the old one
    // once the clock has moved on by a few milliseconds.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await redis.flushall();
    const recreated = must(await service.get(roomId));
    expect(recreated.state.status).toBe('idle');
    expect(recreated.state.version).toBeGreaterThan(before);
    expect(await redis.zscore(redisKeys.runningTimers, roomId)).toBeNull();
  });
});

describe('write conflicts', () => {
  /** A service over a thin wrapper of the real store whose `write` is intercepted. */
  const withWrapper = (intercept: (attempt: number) => ReturnType<RoomTimerStore['write']>) => {
    const counts = { writes: 0, reads: 0 };
    const wrapped: RoomTimerStore = {
      ...store,
      read: (id) => {
        counts.reads += 1;
        return store.read(id);
      },
      write: () => {
        counts.writes += 1;
        return intercept(counts.writes);
      },
    };
    const { logger } = createStubLogger();
    const service = createRoomTimerService({
      store: wrapped,
      readSettings: createTimerSettingsReader(db),
      logger,
    });
    const changes: TimerChange[] = [];
    service.onChange((change) => {
      changes.push(change);
    });
    return { service, counts, changes };
  };

  it('command: three lost races answer VERSION_CONFLICT with the fresh state, no listener call', async () => {
    const { roomId, service: plain } = await newRoom();
    const created = must(await plain.get(roomId));
    const { service, counts, changes } = withWrapper(() => Promise.resolve('conflict'));
    const outcome = await service.command(roomId, { type: 'start' });
    expect(counts.writes).toBe(3);
    expect(outcome).toMatchObject({ ok: false, code: 'VERSION_CONFLICT', state: created.state });
    expect(typeof (outcome.ok ? 0 : outcome.nowMs)).toBe('number');
    expect(changes).toHaveLength(0);
    expect((await store.read(roomId)).state).toEqual(created.state);
  });

  it('completePhase: three lost races throw, so the job retry or reconciler decides', async () => {
    const { roomId } = await newRoom();
    const nowMs = await redisTimeMs(redis);
    await store.write(roomId, null, {
      phase: 'focus',
      status: 'running',
      durationMs: 60_000,
      elapsedBeforeMs: 0,
      segmentStartedAtMs: nowMs - 61_000,
      version: 40,
      focusRunId: null,
    });
    const { service, counts, changes } = withWrapper(() => Promise.resolve('conflict'));
    await expect(service.completePhase(roomId, 40)).rejects.toThrow(/kept conflicting/);
    expect(counts.writes).toBe(3);
    expect(changes).toHaveLength(0);
    expect((await store.read(roomId)).state?.version).toBe(40);
  });

  it('command: a conflict then success re-evaluates against the new state', async () => {
    const { roomId, service: plain } = await newRoom();
    await plain.get(roomId);
    const { service, counts, changes } = withWrapper(async (attempt) => {
      if (attempt === 1) {
        // Another start wins the race before this one's write lands.
        await okState(plain, roomId, { type: 'start' });
      }
      return Promise.resolve('conflict' as const);
    });
    const outcome = await service.command(roomId, { type: 'start' });
    expect(outcome).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });
    expect(counts.writes).toBe(1);
    expect(counts.reads).toBe(2);
    expect(changes).toHaveLength(0);
  });
});

describe('focus runs (Phase 8, RF2, RF3)', () => {
  const runRecord = (roomId: string, runId: string): Promise<Record<string, string>> =>
    redis.hgetall(redisKeys.roomRun(roomId, runId));
  const unsettled = (): Promise<string[]> => redis.zrange(redisKeys.unsettledRuns, 0, '-1');

  it('creates the first run with the timer: id on the state, open record, announced on the change', async () => {
    const { roomId, service, changes } = await newRoom();
    const created = must(await service.get(roomId));
    const runId = must(created.state.focusRunId);
    expect(runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(await runRecord(roomId, runId)).toEqual({
      status: 'open',
      openedAtMs: String(created.nowMs),
    });
    expect(changes[0]?.runs).toEqual({ open: { runId, openedAtMs: created.nowMs } });
    expect(await unsettled()).toEqual([]);
  });

  it('keeps the run through start, pause and resume, writing no run effects', async () => {
    const { roomId, service, changes } = await newRoom();
    const created = must(await service.get(roomId));
    for (const type of ['start', 'pause', 'resume'] as const) {
      const outcome = await okState(service, roomId, { type });
      expect(outcome.state.focusRunId).toBe(created.state.focusRunId);
    }
    expect(changes.slice(1).every((change) => change.runs === undefined)).toBe(true);
    expect(await unsettled()).toEqual([]);
  });

  it('a reset closes the run with its elapsed time and opens a new one, in one write', async () => {
    const { roomId, service, changes } = await newRoom();
    const created = must(await service.get(roomId));
    const oldRun = must(created.state.focusRunId);
    await okState(service, roomId, { type: 'start' });
    const paused = await okState(service, roomId, { type: 'pause' });
    const reset = await okState(service, roomId, {
      type: 'reset',
      expectedVersion: paused.state.version,
    });
    const newRun = must(reset.state.focusRunId);
    expect(newRun).not.toBe(oldRun);

    expect(await runRecord(roomId, oldRun)).toMatchObject({
      status: 'closed',
      closeReason: 'reset',
      closedAtMs: String(reset.nowMs),
      elapsedAtCloseMs: String(paused.state.elapsedBeforeMs),
    });
    expect(await runRecord(roomId, newRun)).toMatchObject({ status: 'open' });
    expect(await unsettled()).toEqual([`${roomId}:${oldRun}`]);
    expect((await store.read(roomId)).state?.focusRunId).toBe(newRun);
    expect(changes.at(-1)?.runs).toMatchObject({
      close: { runId: oldRun, reason: 'reset' },
      open: { runId: newRun },
    });
  });

  it('a reset of an idle timer still closes the run and opens a new one', async () => {
    const { roomId, service } = await newRoom();
    const created = must(await service.get(roomId));
    const reset = await okState(service, roomId, {
      type: 'reset',
      expectedVersion: created.state.version,
    });
    expect(reset.state.focusRunId).not.toBe(created.state.focusRunId);
    expect(await unsettled()).toEqual([`${roomId}:${must(created.state.focusRunId)}`]);
  });

  it('setPhase away from focus closes the run (phase_changed) and the break has none; back to focus opens one', async () => {
    const { roomId, service } = await newRoom();
    const created = must(await service.get(roomId));
    const oldRun = must(created.state.focusRunId);
    const toBreak = await okState(service, roomId, {
      type: 'setPhase',
      phase: 'short_break',
      expectedVersion: created.state.version,
    });
    expect(toBreak.state.focusRunId).toBeNull();
    expect(await runRecord(roomId, oldRun)).toMatchObject({
      status: 'closed',
      closeReason: 'phase_changed',
    });
    const back = await okState(service, roomId, {
      type: 'setPhase',
      phase: 'focus',
      expectedVersion: toBreak.state.version,
    });
    const next = must(back.state.focusRunId);
    expect(await runRecord(roomId, next)).toMatchObject({ status: 'open' });
    expect(await unsettled()).toEqual([`${roomId}:${oldRun}`]);
  });

  it('a focus phase end closes the run as completed with the full duration, leaving no run in the break', async () => {
    const { roomId, service, changes } = await newRoom();
    const created = must(await service.get(roomId));
    const runId = must(created.state.focusRunId);
    const nowMs = await redisTimeMs(redis);
    await redis.del(redisKeys.roomTimer(roomId));
    await store.write(roomId, null, {
      phase: 'focus',
      status: 'running',
      durationMs: 60_000,
      elapsedBeforeMs: 0,
      segmentStartedAtMs: nowMs - 61_000,
      version: 800,
      focusRunId: runId,
    });
    const outcome = await service.completePhase(roomId, 800);
    expect(outcome.result).toBe('advanced');
    expect((await store.read(roomId)).state).toMatchObject({
      phase: 'short_break',
      status: 'idle',
      focusRunId: null,
    });
    expect(await runRecord(roomId, runId)).toMatchObject({
      status: 'closed',
      closeReason: 'completed',
      elapsedAtCloseMs: '60000',
    });
    expect(await unsettled()).toEqual([`${roomId}:${runId}`]);
    expect(changes.at(-1)).toMatchObject({
      cause: 'phase_end',
      runs: { close: { runId, reason: 'completed', elapsedAtCloseMs: 60_000 } },
    });
    expect(changes.at(-1)?.runs?.open).toBeUndefined();
  });

  it('a break end opens a new focus run', async () => {
    const { roomId, service, changes } = await newRoom();
    await service.get(roomId);
    const nowMs = await redisTimeMs(redis);
    await redis.del(redisKeys.roomTimer(roomId));
    await store.write(roomId, null, {
      phase: 'short_break',
      status: 'running',
      durationMs: 60_000,
      elapsedBeforeMs: 0,
      segmentStartedAtMs: nowMs - 61_000,
      version: 810,
      focusRunId: null,
    });
    expect((await service.completePhase(roomId, 810)).result).toBe('advanced');
    const state = must((await store.read(roomId)).state);
    expect(state.phase).toBe('focus');
    const runId = must(state.focusRunId);
    expect(await runRecord(roomId, runId)).toMatchObject({ status: 'open' });
    expect(changes.at(-1)?.runs).toMatchObject({ open: { runId } });
    expect(changes.at(-1)?.runs?.close).toBeUndefined();
  });

  it('closes exactly one run when identical resets race, leaving one unsettled entry', async () => {
    const { roomId, service, changes } = await newRoom();
    const started = await okState(service, roomId, { type: 'start' });
    const oldRun = must(started.state.focusRunId);
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, () =>
        service.command(roomId, { type: 'reset', expectedVersion: started.state.version }),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(await unsettled()).toEqual([`${roomId}:${oldRun}`]);
    expect(changes.filter((change) => change.runs?.close !== undefined)).toHaveLength(1);
    const raw = new Redis(redisContainer.getConnectionUrl());
    const all = await raw.keys(`ff-test:room:${roomId}:run:*`).finally(() => {
      raw.disconnect();
    });
    const keys = all.filter((key) => !key.endsWith(':participants'));
    // The old run and exactly one successor.
    expect(keys).toHaveLength(2);
  });

  it('a lost write leaves no run behind', async () => {
    const { roomId, service: plain } = await newRoom();
    const created = must(await plain.get(roomId));
    const generated: string[] = [];
    const { logger } = createStubLogger();
    const service = createRoomTimerService({
      store: { ...store, write: () => Promise.resolve('conflict') },
      readSettings: createTimerSettingsReader(db),
      logger,
      newRunId: () => {
        const id = uuidv7();
        generated.push(id);
        return id;
      },
    });
    const outcome = await service.command(roomId, {
      type: 'reset',
      expectedVersion: created.state.version,
    });
    expect(outcome).toMatchObject({ ok: false, code: 'VERSION_CONFLICT' });
    expect(generated.length).toBeGreaterThan(0);
    for (const id of generated) {
      expect(await redis.exists(redisKeys.roomRun(roomId, id))).toBe(0);
    }
    expect(await unsettled()).toEqual([]);
  });

  it('uses a fresh id on each creation, including the recreation after a Redis loss', async () => {
    const { roomId, service } = await newRoom();
    const first = must(must(await service.get(roomId)).state.focusRunId);
    await redis.flushall();
    const second = must(must(await service.get(roomId)).state.focusRunId);
    expect(second).not.toBe(first);
    expect((await redis.hgetall(redisKeys.roomRun(roomId, second))).status).toBe('open');
  });
});
