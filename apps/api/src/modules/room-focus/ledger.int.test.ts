import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { redisKeys } from '../../platform/redis-keys.js';
import { createRoomTimerStore } from '../room-timer/store.js';
import type { RoomTimerStore, TimerState } from '../room-timer/types.js';
import { createRunLedger } from './ledger.js';
import type { LedgerParticipant, RunLedger, RunTransition } from './types.js';

// The run ledger and the timer's atomic run write against a real Redis (RF3, RF7). Runs are
// opened and closed only through `RoomTimerStore.write(..., runs)`, exactly as in production.

const ROOM = '0190a000-0000-7000-8000-0000000000aa';
const OTHER_ROOM = '0190a000-0000-7000-8000-0000000000bb';
const RUN_A = '0190a000-0000-7000-8000-00000000a001';
const RUN_B = '0190a000-0000-7000-8000-00000000b001';
const RUN_C = '0190a000-0000-7000-8000-00000000c001';
const ALICE = '0190a000-0000-7000-8000-0000000000a1';
const BOB = '0190a000-0000-7000-8000-0000000000b2';

let container: StartedRedisContainer;
let redis: Redis;
let store: RoomTimerStore;
let ledger: RunLedger;

beforeAll(async () => {
  container = await new RedisContainer('redis:7.4-alpine').start();
  redis = new Redis(container.getConnectionUrl(), { keyPrefix: 'ff-test:' });
  store = createRoomTimerStore(redis);
  ledger = createRunLedger(redis);
}, 180_000);

afterAll(async () => {
  redis.disconnect();
  await container.stop();
}, 60_000);

beforeEach(async () => {
  await redis.flushall();
});

const timer = (version: number, runId: string | null, overrides: Partial<TimerState> = {}) =>
  ({
    phase: 'focus',
    status: 'idle',
    durationMs: 1_500_000,
    elapsedBeforeMs: 0,
    segmentStartedAtMs: null,
    version,
    focusRunId: runId,
    ...overrides,
  }) satisfies TimerState;

const mustWrite = async (
  roomId: string,
  expected: number | null,
  next: TimerState,
  runs?: RunTransition,
): Promise<void> => {
  expect(await store.write(roomId, expected, next, runs)).toBe('ok');
};

/** The room's timer in focus run `runId`, opened at `openedAtMs`, version 1. */
const openRun = (runId: string, roomId = ROOM, openedAtMs = 1_000): Promise<void> =>
  mustWrite(roomId, null, timer(1, runId), { open: { runId, openedAtMs } });

const close = (
  runId: string,
  closedAtMs: number,
  reason: 'reset' | 'phase_changed' | 'completed' = 'reset',
  elapsedAtCloseMs = 5_000,
): NonNullable<RunTransition['close']> => ({ runId, reason, closedAtMs, elapsedAtCloseMs });

const participant = (userId: string, overrides: Partial<LedgerParticipant> = {}) =>
  ({
    userId,
    sessionId: `session-${userId}`,
    optedInAtMs: 2_000,
    elapsedAtOptInMs: 1_000,
    disconnectedAtMs: null,
    elapsedAtDisconnectMs: null,
    ...overrides,
  }) satisfies LedgerParticipant;

const entry = async (runId: string, userId: string, roomId = ROOM): Promise<string | null> =>
  redis.hget(redisKeys.roomRunParticipants(roomId, runId), userId);

/** Keys by full name (the prefixed client rewrites patterns and replies). */
const rawKeys = async (pattern: string): Promise<string[]> => {
  const raw = new Redis(container.getConnectionUrl());
  try {
    return await raw.keys(pattern);
  } finally {
    raw.disconnect();
  }
};

const unsettledMembers = (): Promise<string[]> => redis.zrange(redisKeys.unsettledRuns, 0, '-1');

describe('the timer write with run effects', () => {
  it('stores the focus run id in the timer hash and creates the open run record', async () => {
    await openRun(RUN_A, ROOM, 1234);
    expect((await store.read(ROOM)).state?.focusRunId).toBe(RUN_A);
    const snapshot = await ledger.read(ROOM, RUN_A);
    expect(snapshot.run).toEqual({
      roomId: ROOM,
      runId: RUN_A,
      status: 'open',
      closeReason: null,
      openedAtMs: 1234,
      closedAtMs: null,
      elapsedAtCloseMs: null,
    });
    expect(snapshot.participants).toEqual([]);
    expect(await unsettledMembers()).toEqual([]);
  });

  it('round-trips a break with no run', async () => {
    await mustWrite(ROOM, null, timer(1, null, { phase: 'short_break' }));
    expect((await store.read(ROOM)).state?.focusRunId).toBeNull();
  });

  it('reads a timer hash written before Phase 8 (no focusRunId field) as having no run', async () => {
    await redis.hset(redisKeys.roomTimer(ROOM), {
      phase: 'focus',
      status: 'idle',
      durationMs: '1500000',
      elapsedBeforeMs: '0',
      segmentStartedAtMs: '',
      version: '7',
    });
    expect((await store.read(ROOM)).state).toEqual(timer(7, null));
  });

  it('closes the old run, queues it as unsettled and opens the new one in the same write', async () => {
    await openRun(RUN_A);
    await ledger.addParticipant(ROOM, RUN_A, participant(ALICE));
    await mustWrite(ROOM, 1, timer(2, RUN_B), {
      close: close(RUN_A, 9_000, 'reset', 4_000),
      open: { runId: RUN_B, openedAtMs: 9_000 },
    });

    expect((await store.read(ROOM)).state).toEqual(timer(2, RUN_B));
    const closed = (await ledger.read(ROOM, RUN_A)).run;
    expect(closed).toMatchObject({
      status: 'closed',
      closeReason: 'reset',
      openedAtMs: 1_000,
      closedAtMs: 9_000,
      elapsedAtCloseMs: 4_000,
    });
    expect((await ledger.read(ROOM, RUN_B)).run).toMatchObject({
      status: 'open',
      openedAtMs: 9_000,
    });
    expect(await unsettledMembers()).toEqual([`${ROOM}:${RUN_A}`]);
    expect(await redis.zscore(redisKeys.unsettledRuns, `${ROOM}:${RUN_A}`)).toBe('9000');
    // The closed run keeps its participants for the settlement.
    expect((await ledger.read(ROOM, RUN_A)).participants.map((p) => p.userId)).toEqual([ALICE]);
  });

  it('closes without opening when the focus phase is left, and opens without closing', async () => {
    await openRun(RUN_A);
    await mustWrite(ROOM, 1, timer(2, null, { phase: 'short_break' }), {
      close: close(RUN_A, 3_000, 'phase_changed'),
    });
    expect((await ledger.read(ROOM, RUN_A)).run).toMatchObject({
      status: 'closed',
      closeReason: 'phase_changed',
    });
    await mustWrite(ROOM, 2, timer(3, RUN_B), { open: { runId: RUN_B, openedAtMs: 4_000 } });
    expect((await ledger.read(ROOM, RUN_B)).run?.status).toBe('open');
    expect(await unsettledMembers()).toEqual([`${ROOM}:${RUN_A}`]);
  });

  it('closes with the running index kept in step (a running timer reset in focus)', async () => {
    await mustWrite(ROOM, null, timer(1, RUN_A, { status: 'running', segmentStartedAtMs: 10 }), {
      open: { runId: RUN_A, openedAtMs: 10 },
    });
    expect(await redis.zscore(redisKeys.runningTimers, ROOM)).toBe('1500010');
    await mustWrite(ROOM, 1, timer(2, RUN_B), {
      close: close(RUN_A, 500),
      open: { runId: RUN_B, openedAtMs: 500 },
    });
    expect(await redis.zscore(redisKeys.runningTimers, ROOM)).toBeNull();
    expect(await redis.zscore(redisKeys.unsettledRuns, `${ROOM}:${RUN_A}`)).toBe('500');
  });

  it('writes nothing at all on a version conflict: no timer change, no run, no unsettled entry', async () => {
    await openRun(RUN_A);
    const before = (await store.read(ROOM)).state;
    expect(
      await store.write(ROOM, 99, timer(100, RUN_B), {
        close: close(RUN_A, 9_000),
        open: { runId: RUN_B, openedAtMs: 9_000 },
      }),
    ).toBe('conflict');
    expect((await store.read(ROOM)).state).toEqual(before);
    expect((await ledger.read(ROOM, RUN_A)).run?.status).toBe('open');
    expect((await ledger.read(ROOM, RUN_B)).run).toBeUndefined();
    expect(await redis.exists(redisKeys.roomRun(ROOM, RUN_B))).toBe(0);
    expect(await unsettledMembers()).toEqual([]);
    // Creating over an existing timer is a conflict too and must not create a run.
    expect(
      await store.write(ROOM, null, timer(5, RUN_C), { open: { runId: RUN_C, openedAtMs: 1 } }),
    ).toBe('conflict');
    expect(await redis.exists(redisKeys.roomRun(ROOM, RUN_C))).toBe(0);
  });

  it('lets exactly one of many parallel resets close the run and open its successor', async () => {
    await openRun(RUN_A);
    const results = await Promise.all(
      Array.from({ length: 15 }, (_, index) => {
        const successor = `0190a000-0000-7000-8000-00000000d${String(index).padStart(3, '0')}`;
        return store
          .write(ROOM, 1, timer(2, successor), {
            close: close(RUN_A, 7_000 + index),
            open: { runId: successor, openedAtMs: 7_000 + index },
          })
          .then((result) => ({ result, successor }));
      }),
    );
    const winners = results.filter((entry) => entry.result === 'ok');
    expect(winners).toHaveLength(1);
    expect(await unsettledMembers()).toEqual([`${ROOM}:${RUN_A}`]);
    // Only the winner's run record exists.
    const runKeys = (await rawKeys(`ff-test:room:${ROOM}:run:*`)).filter(
      (key) => !key.endsWith(':participants'),
    );
    expect(runKeys.sort()).toEqual(
      [
        `ff-test:${redisKeys.roomRun(ROOM, RUN_A)}`,
        `ff-test:${redisKeys.roomRun(ROOM, winners[0]?.successor ?? '')}`,
      ].sort(),
    );
  });
});

describe('addParticipant', () => {
  it('adds to the open run of the focus phase and stores the entry', async () => {
    await openRun(RUN_A);
    expect(await ledger.addParticipant(ROOM, RUN_A, participant(ALICE))).toEqual({
      result: 'added',
    });
    const snapshot = await ledger.read(ROOM, RUN_A);
    expect(snapshot.participants).toEqual([participant(ALICE)]);
  });

  it('is allowed while the phase is running or paused, not only idle', async () => {
    await mustWrite(ROOM, null, timer(1, RUN_A, { status: 'paused', elapsedBeforeMs: 100 }), {
      open: { runId: RUN_A, openedAtMs: 1 },
    });
    expect((await ledger.addParticipant(ROOM, RUN_A, participant(ALICE))).result).toBe('added');
  });

  it('is idempotent: an existing entry is returned, never replaced', async () => {
    await openRun(RUN_A);
    await ledger.addParticipant(ROOM, RUN_A, participant(ALICE));
    const second = await ledger.addParticipant(
      ROOM,
      RUN_A,
      participant(ALICE, { sessionId: 'another-session', optedInAtMs: 99_999 }),
    );
    expect(second).toEqual({ result: 'exists', participant: participant(ALICE) });
    expect((await ledger.read(ROOM, RUN_A)).participants).toEqual([participant(ALICE)]);
    expect(await redis.hlen(redisKeys.roomRunParticipants(ROOM, RUN_A))).toBe(1);
  });

  it('returns a disconnected existing entry as stored', async () => {
    await openRun(RUN_A);
    await ledger.addParticipant(ROOM, RUN_A, participant(ALICE));
    await ledger.markDisconnected(ROOM, RUN_A, ALICE, {
      disconnectedAtMs: 5_000,
      elapsedAtDisconnectMs: 2_000,
      timerVersion: 1,
    });
    const again = await ledger.addParticipant(ROOM, RUN_A, participant(ALICE));
    expect(again).toMatchObject({
      result: 'exists',
      participant: { disconnectedAtMs: 5_000, elapsedAtDisconnectMs: 2_000 },
    });
  });

  it('writes nothing when there is no timer', async () => {
    expect(await ledger.addParticipant(ROOM, RUN_A, participant(ALICE))).toEqual({
      result: 'run_changed',
    });
    expect(await redis.exists(redisKeys.roomRunParticipants(ROOM, RUN_A))).toBe(0);
  });

  it('writes nothing when the timer is in another run', async () => {
    await openRun(RUN_B);
    expect((await ledger.addParticipant(ROOM, RUN_A, participant(ALICE))).result).toBe(
      'run_changed',
    );
    expect(await redis.exists(redisKeys.roomRunParticipants(ROOM, RUN_A))).toBe(0);
  });

  it('writes nothing when the run was closed by a reset (the timer moved on)', async () => {
    await openRun(RUN_A);
    await mustWrite(ROOM, 1, timer(2, RUN_B), {
      close: close(RUN_A, 9_000),
      open: { runId: RUN_B, openedAtMs: 9_000 },
    });
    expect((await ledger.addParticipant(ROOM, RUN_A, participant(ALICE))).result).toBe(
      'run_changed',
    );
    expect(await redis.exists(redisKeys.roomRunParticipants(ROOM, RUN_A))).toBe(0);
    expect((await ledger.addParticipant(ROOM, RUN_B, participant(ALICE))).result).toBe('added');
  });

  it('writes nothing in a break, even with a stale run id still in the hash', async () => {
    await openRun(RUN_A);
    await mustWrite(ROOM, 1, timer(2, null, { phase: 'short_break' }), {
      close: close(RUN_A, 3_000, 'phase_changed'),
    });
    expect((await ledger.addParticipant(ROOM, RUN_A, participant(ALICE))).result).toBe(
      'run_changed',
    );
    // A malformed leftover: the break hash says the old run id, the run record is closed.
    await redis.hset(redisKeys.roomTimer(ROOM), { focusRunId: RUN_A });
    expect((await ledger.addParticipant(ROOM, RUN_A, participant(ALICE))).result).toBe(
      'run_changed',
    );
  });

  it('refuses a closed run record even if the timer still names it', async () => {
    await openRun(RUN_A);
    await redis.hset(redisKeys.roomRun(ROOM, RUN_A), { status: 'closed' });
    expect((await ledger.addParticipant(ROOM, RUN_A, participant(ALICE))).result).toBe(
      'run_changed',
    );
  });

  it('keeps rooms apart', async () => {
    await openRun(RUN_A, ROOM);
    await openRun(RUN_B, OTHER_ROOM);
    expect((await ledger.addParticipant(OTHER_ROOM, RUN_A, participant(ALICE))).result).toBe(
      'run_changed',
    );
    expect((await ledger.addParticipant(OTHER_ROOM, RUN_B, participant(ALICE))).result).toBe(
      'added',
    );
    expect((await ledger.read(ROOM, RUN_A)).participants).toEqual([]);
  });

  it('is atomic against a concurrent reset: an entry never lands in a run the reset closed first', async () => {
    for (let round = 0; round < 30; round += 1) {
      await redis.flushall();
      await openRun(RUN_A);
      const [added] = await Promise.all([
        ledger.addParticipant(ROOM, RUN_A, participant(ALICE)),
        store.write(ROOM, 1, timer(2, RUN_B), {
          close: close(RUN_A, 9_000),
          open: { runId: RUN_B, openedAtMs: 9_000 },
        }),
      ]);
      // The reset is the only writer of the timer, so it always succeeds.
      expect((await store.read(ROOM)).state?.focusRunId).toBe(RUN_B);
      const stored = await entry(RUN_A, ALICE);
      if (added.result === 'added') {
        // The add ran first: the entry is there and the closed run carries it to settlement.
        expect(stored).not.toBeNull();
        expect(await unsettledMembers()).toEqual([`${ROOM}:${RUN_A}`]);
      } else {
        // The reset ran first: nothing was written into the closed run.
        expect(added.result).toBe('run_changed');
        expect(stored).toBeNull();
      }
      // Whatever the order, no later add can reach the closed run.
      expect((await ledger.addParticipant(ROOM, RUN_A, participant(BOB))).result).toBe(
        'run_changed',
      );
      expect(await entry(RUN_A, BOB)).toBeNull();
    }
  });
});

describe('removeParticipant', () => {
  it('removes the entry, reports whether it existed and is idempotent', async () => {
    await openRun(RUN_A);
    await ledger.addParticipant(ROOM, RUN_A, participant(ALICE));
    await ledger.addParticipant(ROOM, RUN_A, participant(BOB));
    expect(await ledger.removeParticipant(ROOM, RUN_A, ALICE, `session-${ALICE}`)).toBe(true);
    expect(await ledger.removeParticipant(ROOM, RUN_A, ALICE, `session-${ALICE}`)).toBe(false);
    expect((await ledger.read(ROOM, RUN_A)).participants.map((p) => p.userId)).toEqual([BOB]);
    expect(await ledger.removeParticipant(ROOM, RUN_C, ALICE, `session-${ALICE}`)).toBe(false);
  });

  it('removes only the entry of the given session (compare-and-delete)', async () => {
    await openRun(RUN_A);
    await ledger.addParticipant(ROOM, RUN_A, participant(ALICE, { sessionId: 'session-new' }));
    // A late cleanup of an older session of the same user leaves the new entry alone.
    expect(await ledger.removeParticipant(ROOM, RUN_A, ALICE, 'session-old')).toBe(false);
    expect((await ledger.read(ROOM, RUN_A)).participants.map((p) => p.sessionId)).toEqual([
      'session-new',
    ]);
    expect(await ledger.removeParticipant(ROOM, RUN_A, ALICE, 'session-new')).toBe(true);
    expect((await ledger.read(ROOM, RUN_A)).participants).toEqual([]);
  });

  it('removes an entry whose disconnect fields changed between the read and the delete', async () => {
    await openRun(RUN_A);
    await ledger.addParticipant(ROOM, RUN_A, participant(ALICE));
    // The entry is rewritten (disconnect cleared/marked) but still belongs to the session.
    await redis.hset(
      redisKeys.roomRunParticipants(ROOM, RUN_A),
      ALICE,
      JSON.stringify(participant(ALICE, { disconnectedAtMs: 5_000, elapsedAtDisconnectMs: 100 })),
    );
    expect(await ledger.removeParticipant(ROOM, RUN_A, ALICE, `session-${ALICE}`)).toBe(true);
  });
});

describe('read', () => {
  it('answers an absent run with no participants and Redis TIME', async () => {
    const snapshot = await ledger.read(ROOM, RUN_A);
    expect(snapshot.run).toBeUndefined();
    expect(snapshot.participants).toEqual([]);
    const [seconds] = await redis.time();
    expect(Math.abs(snapshot.nowMs - Number(seconds) * 1000)).toBeLessThan(5000);
  });

  it('throws for a malformed participant or run instead of ignoring it', async () => {
    await openRun(RUN_A);
    await redis.hset(redisKeys.roomRunParticipants(ROOM, RUN_A), ALICE, 'not json');
    await expect(ledger.read(ROOM, RUN_A)).rejects.toThrow(/malformed/);
    await redis.hset(redisKeys.roomRunParticipants(ROOM, RUN_A), ALICE, '{"userId":"x"}');
    await expect(ledger.read(ROOM, RUN_A)).rejects.toThrow(/malformed/);
    await redis.del(redisKeys.roomRunParticipants(ROOM, RUN_A));
    await redis.hset(redisKeys.roomRun(ROOM, RUN_A), { status: 'weird' });
    await expect(ledger.read(ROOM, RUN_A)).rejects.toThrow(/malformed/);
  });
});

describe('markDisconnected', () => {
  const disconnect = (
    overrides: Partial<{ at: number; elapsed: number; version: number }> = {},
  ) => ({
    disconnectedAtMs: overrides.at ?? 6_000,
    elapsedAtDisconnectMs: overrides.elapsed ?? 3_000,
    timerVersion: overrides.version ?? 1,
  });

  it('records the disconnect on a connected participant and keeps the other fields', async () => {
    await openRun(RUN_A);
    await ledger.addParticipant(ROOM, RUN_A, participant(ALICE));
    await ledger.addParticipant(ROOM, RUN_A, participant(BOB));
    expect(await ledger.markDisconnected(ROOM, RUN_A, ALICE, disconnect())).toBe('marked');
    const byUser = new Map((await ledger.read(ROOM, RUN_A)).participants.map((p) => [p.userId, p]));
    expect(byUser.get(ALICE)).toEqual(
      participant(ALICE, { disconnectedAtMs: 6_000, elapsedAtDisconnectMs: 3_000 }),
    );
    expect(byUser.get(BOB)).toEqual(participant(BOB));
  });

  it('answers already_disconnected and keeps the first disconnect', async () => {
    await openRun(RUN_A);
    await ledger.addParticipant(ROOM, RUN_A, participant(ALICE));
    await ledger.markDisconnected(ROOM, RUN_A, ALICE, disconnect());
    expect(
      await ledger.markDisconnected(ROOM, RUN_A, ALICE, disconnect({ at: 9_999, elapsed: 1 })),
    ).toBe('already_disconnected');
    expect((await ledger.read(ROOM, RUN_A)).participants[0]).toMatchObject({
      disconnectedAtMs: 6_000,
      elapsedAtDisconnectMs: 3_000,
    });
  });

  it('answers not_participant for an unknown user or run, writing nothing', async () => {
    await openRun(RUN_A);
    expect(await ledger.markDisconnected(ROOM, RUN_A, ALICE, disconnect())).toBe('not_participant');
    expect(await ledger.markDisconnected(ROOM, RUN_C, ALICE, disconnect())).toBe('not_participant');
    expect(await redis.exists(redisKeys.roomRunParticipants(ROOM, RUN_A))).toBe(0);
  });

  it('answers conflict, changing nothing, when the timer version moved (pause, resume)', async () => {
    await openRun(RUN_A);
    await ledger.addParticipant(ROOM, RUN_A, participant(ALICE));
    await mustWrite(ROOM, 1, timer(2, RUN_A, { status: 'paused', elapsedBeforeMs: 100 }));
    expect(await ledger.markDisconnected(ROOM, RUN_A, ALICE, disconnect({ version: 1 }))).toBe(
      'conflict',
    );
    expect((await ledger.read(ROOM, RUN_A)).participants[0]?.disconnectedAtMs).toBeNull();
    // Read again with the fresh version: it succeeds.
    expect(await ledger.markDisconnected(ROOM, RUN_A, ALICE, disconnect({ version: 2 }))).toBe(
      'marked',
    );
  });

  it('answers conflict when there is no timer at all', async () => {
    await openRun(RUN_A);
    await ledger.addParticipant(ROOM, RUN_A, participant(ALICE));
    await redis.del(redisKeys.roomTimer(ROOM));
    expect(await ledger.markDisconnected(ROOM, RUN_A, ALICE, disconnect())).toBe('conflict');
  });

  it('answers run_closed once the run closed, leaving the entry for the settlement', async () => {
    await openRun(RUN_A);
    await ledger.addParticipant(ROOM, RUN_A, participant(ALICE));
    await mustWrite(ROOM, 1, timer(2, RUN_B), {
      close: close(RUN_A, 9_000, 'completed', 1_500_000),
      open: { runId: RUN_B, openedAtMs: 9_000 },
    });
    // Both a stale and the fresh version: the closed run wins over the version check.
    expect(await ledger.markDisconnected(ROOM, RUN_A, ALICE, disconnect({ version: 1 }))).toBe(
      'run_closed',
    );
    expect(await ledger.markDisconnected(ROOM, RUN_A, ALICE, disconnect({ version: 2 }))).toBe(
      'run_closed',
    );
    expect((await ledger.read(ROOM, RUN_A)).participants[0]?.disconnectedAtMs).toBeNull();
  });

  it('lets exactly one of many parallel disconnects win and never loses the entry', async () => {
    await openRun(RUN_A);
    await ledger.addParticipant(ROOM, RUN_A, participant(ALICE));
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        ledger.markDisconnected(
          ROOM,
          RUN_A,
          ALICE,
          disconnect({ at: 6_000 + index, elapsed: 3_000 + index }),
        ),
      ),
    );
    expect(results.filter((result) => result === 'marked')).toHaveLength(1);
    for (const result of results) {
      expect(['marked', 'already_disconnected', 'conflict']).toContain(result);
    }
    const stored = (await ledger.read(ROOM, RUN_A)).participants[0];
    // The recorded pair is one writer's, never a mixture.
    expect(stored?.disconnectedAtMs).not.toBeNull();
    expect((stored?.elapsedAtDisconnectMs ?? 0) - 3_000).toBe(
      (stored?.disconnectedAtMs ?? 0) - 6_000,
    );
  });

  it('is atomic against a concurrent reset: a mark that returns marked beat the close', async () => {
    for (let round = 0; round < 30; round += 1) {
      await redis.flushall();
      await openRun(RUN_A);
      await ledger.addParticipant(ROOM, RUN_A, participant(ALICE));
      const [marked] = await Promise.all([
        ledger.markDisconnected(ROOM, RUN_A, ALICE, disconnect()),
        store.write(ROOM, 1, timer(2, RUN_B), {
          close: close(RUN_A, 9_000),
          open: { runId: RUN_B, openedAtMs: 9_000 },
        }),
      ]);
      expect(['marked', 'run_closed', 'conflict']).toContain(marked);
      const stored = (await ledger.read(ROOM, RUN_A)).participants[0];
      expect(stored?.disconnectedAtMs === null).toBe(marked !== 'marked');
    }
  });
});

describe('clearDisconnected', () => {
  const prepare = async (): Promise<void> => {
    await openRun(RUN_A);
    await ledger.addParticipant(ROOM, RUN_A, participant(ALICE));
    await ledger.markDisconnected(ROOM, RUN_A, ALICE, {
      disconnectedAtMs: 6_000,
      elapsedAtDisconnectMs: 3_000,
      timerVersion: 1,
    });
  };

  it('clears both disconnect fields only for exactly the expected instant', async () => {
    await prepare();
    expect(await ledger.clearDisconnected(ROOM, RUN_A, ALICE, 5_999)).toBe(false);
    expect(await ledger.clearDisconnected(ROOM, RUN_A, ALICE, 6_001)).toBe(false);
    expect((await ledger.read(ROOM, RUN_A)).participants[0]).toMatchObject({
      disconnectedAtMs: 6_000,
      elapsedAtDisconnectMs: 3_000,
    });
    expect(await ledger.clearDisconnected(ROOM, RUN_A, ALICE, 6_000)).toBe(true);
    expect((await ledger.read(ROOM, RUN_A)).participants[0]).toEqual(participant(ALICE));
    // Once cleared, the same call is a no-op.
    expect(await ledger.clearDisconnected(ROOM, RUN_A, ALICE, 6_000)).toBe(false);
  });

  it('does not clear a newer disconnect with an older expectation', async () => {
    await prepare();
    expect(await ledger.clearDisconnected(ROOM, RUN_A, ALICE, 6_000)).toBe(true);
    await ledger.markDisconnected(ROOM, RUN_A, ALICE, {
      disconnectedAtMs: 8_000,
      elapsedAtDisconnectMs: 4_000,
      timerVersion: 1,
    });
    expect(await ledger.clearDisconnected(ROOM, RUN_A, ALICE, 6_000)).toBe(false);
    expect((await ledger.read(ROOM, RUN_A)).participants[0]?.disconnectedAtMs).toBe(8_000);
  });

  it('answers false for a connected participant, an unknown user and an unknown run', async () => {
    await openRun(RUN_A);
    await ledger.addParticipant(ROOM, RUN_A, participant(ALICE));
    expect(await ledger.clearDisconnected(ROOM, RUN_A, ALICE, 0)).toBe(false);
    expect(await ledger.clearDisconnected(ROOM, RUN_A, BOB, 6_000)).toBe(false);
    expect(await ledger.clearDisconnected(ROOM, RUN_C, ALICE, 6_000)).toBe(false);
  });

  it('lets exactly one of many parallel clears win', async () => {
    await prepare();
    const results = await Promise.all(
      Array.from({ length: 15 }, () => ledger.clearDisconnected(ROOM, RUN_A, ALICE, 6_000)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('works on a closed run too (the reconnect-after-close path)', async () => {
    await prepare();
    await mustWrite(ROOM, 1, timer(2, RUN_B), {
      close: close(RUN_A, 9_000, 'completed', 1_500_000),
      open: { runId: RUN_B, openedAtMs: 9_000 },
    });
    expect(await ledger.clearDisconnected(ROOM, RUN_A, ALICE, 6_000)).toBe(true);
  });
});

describe('finishRun', () => {
  const closedRunWith = async (...users: string[]): Promise<void> => {
    await openRun(RUN_A);
    for (const user of users) {
      await ledger.addParticipant(ROOM, RUN_A, participant(user));
    }
    await mustWrite(ROOM, 1, timer(2, RUN_B), {
      close: close(RUN_A, 9_000),
      open: { runId: RUN_B, openedAtMs: 9_000 },
    });
  };

  it('deletes a closed, empty run with its record and unsettled entry', async () => {
    await closedRunWith();
    expect(await ledger.finishRun(ROOM, RUN_A)).toBe(true);
    expect((await ledger.read(ROOM, RUN_A)).run).toBeUndefined();
    expect(await unsettledMembers()).toEqual([]);
    expect(await redis.exists(redisKeys.roomRun(ROOM, RUN_A))).toBe(0);
    // The successor is untouched.
    expect((await ledger.read(ROOM, RUN_B)).run?.status).toBe('open');
  });

  it('keeps a closed run while a participant is left, and finishes it once they are removed', async () => {
    await closedRunWith(ALICE, BOB);
    expect(await ledger.finishRun(ROOM, RUN_A)).toBe(false);
    await ledger.removeParticipant(ROOM, RUN_A, ALICE, `session-${ALICE}`);
    expect(await ledger.finishRun(ROOM, RUN_A)).toBe(false);
    expect(await unsettledMembers()).toEqual([`${ROOM}:${RUN_A}`]);
    await ledger.removeParticipant(ROOM, RUN_A, BOB, `session-${BOB}`);
    expect(await ledger.finishRun(ROOM, RUN_A)).toBe(true);
    expect(await unsettledMembers()).toEqual([]);
  });

  it('never touches an open run, even an empty one', async () => {
    await openRun(RUN_A);
    expect(await ledger.finishRun(ROOM, RUN_A)).toBe(false);
    expect((await ledger.read(ROOM, RUN_A)).run?.status).toBe('open');
    await ledger.addParticipant(ROOM, RUN_A, participant(ALICE));
    expect(await ledger.finishRun(ROOM, RUN_A)).toBe(false);
    expect((await ledger.read(ROOM, RUN_A)).participants).toHaveLength(1);
  });

  it('is idempotent', async () => {
    await closedRunWith();
    expect(await ledger.finishRun(ROOM, RUN_A)).toBe(true);
    expect(await ledger.finishRun(ROOM, RUN_A)).toBe(false);
    expect(await ledger.finishRun(ROOM, RUN_C)).toBe(false);
  });

  it('drops a dangling unsettled entry whose run record is gone, but keeps orphan participants', async () => {
    await redis.zadd(redisKeys.unsettledRuns, '100', `${ROOM}:${RUN_C}`);
    expect(await ledger.finishRun(ROOM, RUN_C)).toBe(true);
    expect(await unsettledMembers()).toEqual([]);

    await redis.zadd(redisKeys.unsettledRuns, '100', `${ROOM}:${RUN_C}`);
    await redis.hset(
      redisKeys.roomRunParticipants(ROOM, RUN_C),
      ALICE,
      JSON.stringify(participant(ALICE)),
    );
    expect(await ledger.finishRun(ROOM, RUN_C)).toBe(false);
    expect(await unsettledMembers()).toEqual([`${ROOM}:${RUN_C}`]);
  });

  it('cannot delete a run that a racing add just filled: a participant added first keeps the run', async () => {
    // A closed run refuses adds, so the only race is finish vs removal: the run stays
    // while anyone is left, whatever the interleaving.
    await closedRunWith(ALICE);
    const [removed, finished] = await Promise.all([
      ledger.removeParticipant(ROOM, RUN_A, ALICE, `session-${ALICE}`),
      ledger.finishRun(ROOM, RUN_A),
    ]);
    expect(removed).toBe(true);
    if (!finished) {
      expect(await ledger.finishRun(ROOM, RUN_A)).toBe(true);
    }
    expect(await unsettledMembers()).toEqual([]);
  });
});

describe('unsettled', () => {
  const closeInRoom = async (roomId: string, runId: string, closedAtMs: number) => {
    await mustWrite(roomId, null, timer(1, runId));
    await mustWrite(roomId, 1, timer(2, null, { phase: 'short_break' }), {
      close: close(runId, closedAtMs),
    });
  };

  it('lists closed runs oldest first, then by member, within the limit', async () => {
    await closeInRoom('room-c', 'run-3', 300);
    await closeInRoom('room-a', 'run-1', 100);
    await closeInRoom('room-b', 'run-2', 200);
    await closeInRoom('room-a2', 'run-2b', 200);

    expect(await ledger.unsettled(10)).toEqual([
      { roomId: 'room-a', runId: 'run-1' },
      { roomId: 'room-a2', runId: 'run-2b' },
      { roomId: 'room-b', runId: 'run-2' },
      { roomId: 'room-c', runId: 'run-3' },
    ]);
    expect(await ledger.unsettled(2)).toEqual([
      { roomId: 'room-a', runId: 'run-1' },
      { roomId: 'room-a2', runId: 'run-2b' },
    ]);
    expect(await ledger.unsettled(0)).toEqual([]);
  });

  it('shrinks as runs are finished, and an open run is never listed', async () => {
    await openRun(RUN_B, OTHER_ROOM);
    await closeInRoom('room-a', 'run-1', 100);
    await closeInRoom('room-b', 'run-2', 200);
    expect(await ledger.unsettled(10)).toHaveLength(2);
    expect(await ledger.finishRun('room-a', 'run-1')).toBe(true);
    expect(await ledger.unsettled(10)).toEqual([{ roomId: 'room-b', runId: 'run-2' }]);
  });

  it('skips a malformed member instead of failing', async () => {
    await redis.zadd(redisKeys.unsettledRuns, '1', 'garbage');
    await closeInRoom('room-a', 'run-1', 100);
    expect(await ledger.unsettled(10)).toEqual([{ roomId: 'room-a', runId: 'run-1' }]);
  });

  it('stores the member without the key prefix', async () => {
    await closeInRoom('room-a', 'run-1', 100);
    const raw = new Redis(container.getConnectionUrl());
    try {
      expect(await raw.zrange(`ff-test:${redisKeys.unsettledRuns}`, '0', '-1')).toEqual([
        'room-a:run-1',
      ]);
    } finally {
      raw.disconnect();
    }
  });
});

describe('participantsVersion (G2)', () => {
  const versionOf = async (runId = RUN_A): Promise<number> =>
    (await ledger.read(ROOM, runId)).participantsVersion;

  it('starts at 0 with the run and for a run that does not exist', async () => {
    expect(await versionOf()).toBe(0);
    await openRun(RUN_A);
    expect(await versionOf()).toBe(0);
  });

  it('grows by exactly one with every change to the list or to a shown field', async () => {
    await openRun(RUN_A);
    const seen = [await versionOf()];
    await ledger.addParticipant(ROOM, RUN_A, participant(ALICE));
    seen.push(await versionOf());
    await ledger.addParticipant(ROOM, RUN_A, participant(BOB));
    seen.push(await versionOf());
    expect(
      await ledger.markDisconnected(ROOM, RUN_A, ALICE, {
        disconnectedAtMs: 6_000,
        elapsedAtDisconnectMs: 3_000,
        timerVersion: 1,
      }),
    ).toBe('marked');
    seen.push(await versionOf());
    expect(await ledger.clearDisconnected(ROOM, RUN_A, ALICE, 6_000)).toBe(true);
    seen.push(await versionOf());
    expect(await ledger.removeParticipant(ROOM, RUN_A, BOB, `session-${BOB}`)).toBe(true);
    seen.push(await versionOf());
    expect(seen).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('does not move for requests that change nothing', async () => {
    await openRun(RUN_A);
    await ledger.addParticipant(ROOM, RUN_A, participant(ALICE));
    expect(await ledger.addParticipant(ROOM, RUN_A, participant(ALICE))).toMatchObject({
      result: 'exists',
    });
    expect(await ledger.addParticipant(ROOM, RUN_B, participant(BOB))).toEqual({
      result: 'run_changed',
    });
    expect(await ledger.removeParticipant(ROOM, RUN_A, ALICE, 'someone-elses-session')).toBe(false);
    expect(await ledger.clearDisconnected(ROOM, RUN_A, ALICE, 6_000)).toBe(false);
    expect(
      await ledger.markDisconnected(ROOM, RUN_A, BOB, {
        disconnectedAtMs: 1,
        elapsedAtDisconnectMs: 1,
        timerVersion: 1,
      }),
    ).toBe('not_participant');
    expect(await versionOf()).toBe(1);
  });

  it('is per run: a new run starts again at 0 and the old run keeps its number', async () => {
    await openRun(RUN_A);
    await ledger.addParticipant(ROOM, RUN_A, participant(ALICE));
    await mustWrite(ROOM, 1, timer(2, RUN_B), {
      close: close(RUN_A, 9_000),
      open: { runId: RUN_B, openedAtMs: 9_000 },
    });
    expect(await versionOf(RUN_B)).toBe(0);
    expect(await versionOf(RUN_A)).toBe(1);
  });

  it('counts every parallel add exactly once', async () => {
    await openRun(RUN_A);
    const users = Array.from(
      { length: 12 },
      (_, index) => `0190a000-0000-7000-8000-0000000001${String(index).padStart(2, '0')}`,
    );
    await Promise.all(
      users.map((userId) => ledger.addParticipant(ROOM, RUN_A, participant(userId))),
    );
    const snapshot = await ledger.read(ROOM, RUN_A);
    expect(snapshot.participants).toHaveLength(12);
    expect(snapshot.participantsVersion).toBe(12);
  });

  it('never creates a run record when the run is gone (a late removal after finishRun)', async () => {
    await openRun(RUN_A);
    await ledger.addParticipant(ROOM, RUN_A, participant(ALICE));
    await mustWrite(ROOM, 1, timer(2, null, { phase: 'short_break' }), {
      close: close(RUN_A, 9_000),
    });
    await redis.del(redisKeys.roomRun(ROOM, RUN_A));
    expect(await ledger.removeParticipant(ROOM, RUN_A, ALICE, `session-${ALICE}`)).toBe(true);
    expect(await redis.exists(redisKeys.roomRun(ROOM, RUN_A))).toBe(0);
    expect((await ledger.read(ROOM, RUN_A)).participantsVersion).toBe(0);
  });

  it('reads the list and its version as one consistent pair under concurrent changes', async () => {
    await openRun(RUN_A);
    const users = Array.from(
      { length: 20 },
      (_, index) => `0190a000-0000-7000-8000-0000000002${String(index).padStart(2, '0')}`,
    );
    const writers = Promise.all(
      users.map((userId) => ledger.addParticipant(ROOM, RUN_A, participant(userId))),
    );
    const reads = await Promise.all(Array.from({ length: 30 }, () => ledger.read(ROOM, RUN_A)));
    await writers;
    // Each add is one change, so in any single read the version equals the number of entries.
    for (const read of reads) {
      expect(read.participantsVersion).toBe(read.participants.length);
    }
  });
});
