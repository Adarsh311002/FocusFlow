import type { TimerCommand } from '@focus-flow/contracts';
import { describe, expect, it } from 'vitest';

import { timerMachine as m } from '../room-timer/machine.js';
import type { TimerSettings, TimerState } from '../room-timer/types.js';
import {
  focusedSecondsBetween,
  graceRemainingMs,
  pendingEndAtMs,
  plannedSecondsAtOptIn,
  planRun,
  settlementForClosedRun,
  settlementForDeparture,
  settlementForGraceExpiry,
  settlementForReconnectAfterClose,
  settlementForStale,
  settlementForTimerLost,
} from './model.js';
import { type LedgerParticipant, ROOM_GRACE_MS, type RunRecord } from './types.js';

const settings: TimerSettings = { focusMs: 1_500_000, shortBreakMs: 300_000, longBreakMs: 900_000 };
const RUN_A = '0190a7b2-0000-7000-8000-00000000000a';
const RUN_B = '0190a7b2-0000-7000-8000-00000000000b';

const participant = (over: Partial<LedgerParticipant> = {}): LedgerParticipant => ({
  userId: 'u1',
  sessionId: 's1',
  optedInAtMs: 1_000_000,
  elapsedAtOptInMs: 100_000,
  disconnectedAtMs: null,
  elapsedAtDisconnectMs: null,
  ...over,
});

const closedRun = (over: Partial<RunRecord> = {}): RunRecord => ({
  roomId: 'r1',
  runId: RUN_A,
  status: 'closed',
  closeReason: 'completed',
  openedAtMs: 900_000,
  closedAtMs: 2_000_000,
  elapsedAtCloseMs: 1_500_000,
  ...over,
});

describe('plannedSecondsAtOptIn', () => {
  it('rounds the remaining time to whole seconds', () => {
    expect(plannedSecondsAtOptIn(1_500_000, 0)).toEqual({ ok: true, plannedSeconds: 1500 });
    expect(plannedSecondsAtOptIn(1_500_000, 400)).toEqual({ ok: true, plannedSeconds: 1500 });
    expect(plannedSecondsAtOptIn(1_500_000, 600)).toEqual({ ok: true, plannedSeconds: 1499 });
    expect(plannedSecondsAtOptIn(1_500_000, 1_500)).toEqual({ ok: true, plannedSeconds: 1499 });
  });

  it('is joinable down to exactly 60 s and not below', () => {
    expect(plannedSecondsAtOptIn(120_000, 60_000)).toEqual({ ok: true, plannedSeconds: 60 });
    expect(plannedSecondsAtOptIn(120_000, 60_500)).toEqual({ ok: true, plannedSeconds: 60 });
    expect(plannedSecondsAtOptIn(120_000, 60_501)).toEqual({ ok: false });
    expect(plannedSecondsAtOptIn(120_000, 120_000)).toEqual({ ok: false });
  });

  it('refuses above 14 400 s', () => {
    expect(plannedSecondsAtOptIn(14_400_000, 0)).toEqual({ ok: true, plannedSeconds: 14_400 });
    expect(plannedSecondsAtOptIn(14_401_000, 0)).toEqual({ ok: false });
  });
});

describe('focusedSecondsBetween', () => {
  it('floors whole seconds', () => {
    expect(focusedSecondsBetween(0, 59_999, 1000)).toBe(59);
    expect(focusedSecondsBetween(100, 60_100, 1000)).toBe(60);
  });

  it('is never negative and never above planned', () => {
    expect(focusedSecondsBetween(50_000, 10_000, 100)).toBe(0);
    expect(focusedSecondsBetween(0, 10_000_000, 100)).toBe(100);
    expect(focusedSecondsBetween(0, 5_000, 0)).toBe(0);
  });
});

describe('settlementForGraceExpiry', () => {
  it('counts to the disconnect and ends at the disconnect instant', () => {
    expect(
      settlementForGraceExpiry(
        participant({ disconnectedAtMs: 1_500_000, elapsedAtDisconnectMs: 400_000 }),
        1400,
      ),
    ).toEqual({
      kind: 'abandon',
      reason: 'grace_expired',
      focusedSeconds: 300,
      endedAtMs: 1_500_000,
    });
  });

  it('a disconnect before the opt-in elapsed counts 0', () => {
    const s = settlementForGraceExpiry(
      participant({ disconnectedAtMs: 1_500_000, elapsedAtDisconnectMs: 50_000 }),
      1400,
    );
    expect(s).toMatchObject({ kind: 'abandon', focusedSeconds: 0 });
  });

  it('needs a disconnected participant', () => {
    expect(() => settlementForGraceExpiry(participant(), 100)).toThrow(RangeError);
  });
});

describe('settlementForClosedRun', () => {
  it.each(['reset', 'phase_changed'] as const)(
    '%s while connected counts to the close',
    (reason) => {
      const s = settlementForClosedRun(
        participant(),
        closedRun({ closeReason: reason, elapsedAtCloseMs: 700_000 }),
        1400,
        2_100_000,
      );
      expect(s).toEqual({ kind: 'abandon', reason, focusedSeconds: 600, endedAtMs: 2_000_000 });
    },
  );

  it('reset while disconnected counts to the disconnect, ends at the close', () => {
    const s = settlementForClosedRun(
      participant({ disconnectedAtMs: 1_900_000, elapsedAtDisconnectMs: 300_000 }),
      closedRun({ closeReason: 'reset', elapsedAtCloseMs: 700_000 }),
      1400,
      9_000_000,
    );
    expect(s).toEqual({
      kind: 'abandon',
      reason: 'reset',
      focusedSeconds: 200,
      endedAtMs: 2_000_000,
    });
  });

  it('completed while connected completes at the close', () => {
    expect(settlementForClosedRun(participant(), closedRun(), 1400, 5_000_000)).toEqual({
      kind: 'complete',
      endedAtMs: 2_000_000,
    });
  });

  it('completed while disconnected waits during the grace, then expires', () => {
    const p = participant({ disconnectedAtMs: 1_990_000, elapsedAtDisconnectMs: 1_490_000 });
    expect(settlementForClosedRun(p, closedRun(), 1400, 1_990_000 + ROOM_GRACE_MS - 1)).toEqual({
      kind: 'wait_for_grace',
    });
    expect(settlementForClosedRun(p, closedRun(), 1400, 1_990_000 + ROOM_GRACE_MS)).toEqual({
      kind: 'abandon',
      reason: 'grace_expired',
      focusedSeconds: 1390,
      endedAtMs: 1_990_000,
    });
  });

  describe('a disconnect at or after the true end of a completed run (G3)', () => {
    // The run's true end is 2_000_000 (closedAtMs is clamped to it by planRun).
    it('counts as present through the end: complete at the true end, no grace', () => {
      const run = closedRun();
      for (const disconnectedAtMs of [2_000_000, 2_005_000, 2_500_000]) {
        const p = participant({ disconnectedAtMs, elapsedAtDisconnectMs: 1_500_000 });
        for (const nowMs of [disconnectedAtMs, disconnectedAtMs + ROOM_GRACE_MS + 5_000]) {
          expect(settlementForClosedRun(p, run, 1400, nowMs)).toEqual({
            kind: 'complete',
            endedAtMs: 2_000_000,
          });
        }
      }
    });

    it('a disconnect one millisecond before the true end still goes through the grace', () => {
      const p = participant({ disconnectedAtMs: 1_999_999, elapsedAtDisconnectMs: 1_499_999 });
      expect(settlementForClosedRun(p, closedRun(), 1400, 2_000_000)).toEqual({
        kind: 'wait_for_grace',
      });
      expect(settlementForClosedRun(p, closedRun(), 1400, 1_999_999 + ROOM_GRACE_MS)).toMatchObject(
        { kind: 'abandon', reason: 'grace_expired', endedAtMs: 1_999_999 },
      );
    });

    it('does not apply to a reset or a phase change', () => {
      const p = participant({ disconnectedAtMs: 2_500_000, elapsedAtDisconnectMs: 700_000 });
      expect(
        settlementForClosedRun(
          p,
          closedRun({ closeReason: 'reset', elapsedAtCloseMs: 700_000 }),
          1400,
          9_000_000,
        ),
      ).toMatchObject({ kind: 'abandon', reason: 'reset' });
    });

    it('also holds for a reconnect after the close', () => {
      const p = participant({ disconnectedAtMs: 2_005_000, elapsedAtDisconnectMs: 1_500_000 });
      expect(settlementForReconnectAfterClose(p, closedRun(), 2_005_000 + 300_000, 1400)).toEqual({
        kind: 'complete',
        endedAtMs: 2_000_000,
      });
    });
  });

  it('refuses an open run', () => {
    expect(() =>
      settlementForClosedRun(participant(), closedRun({ status: 'open', closeReason: null }), 1, 1),
    ).toThrow(RangeError);
  });
});

describe('settlementForDeparture', () => {
  it.each(['opted_out', 'left_room', 'removed'] as const)('%s counts to now and ends now', (r) => {
    expect(settlementForDeparture(r, participant(), 400_000, 1_300_000, 1400)).toEqual({
      kind: 'abandon',
      reason: r,
      focusedSeconds: 300,
      endedAtMs: 1_300_000,
    });
  });

  it('ignores a recorded disconnect: a departure is now', () => {
    const p = participant({ disconnectedAtMs: 1_100_000, elapsedAtDisconnectMs: 200_000 });
    expect(settlementForDeparture('left_room', p, 400_000, 1_300_000, 1400)).toMatchObject({
      focusedSeconds: 300,
    });
  });

  it('is clamped to planned', () => {
    expect(settlementForDeparture('opted_out', participant(), 9_000_000, 1, 50)).toMatchObject({
      focusedSeconds: 50,
    });
  });
});

describe('settlementForReconnectAfterClose', () => {
  const p = participant({ disconnectedAtMs: 1_990_000, elapsedAtDisconnectMs: 1_490_000 });

  it('within the grace completes at the close', () => {
    expect(
      settlementForReconnectAfterClose(p, closedRun(), 1_990_000 + ROOM_GRACE_MS, 1400),
    ).toEqual({ kind: 'complete', endedAtMs: 2_000_000 });
  });

  it('after the grace is a grace expiry', () => {
    expect(
      settlementForReconnectAfterClose(p, closedRun(), 1_990_000 + ROOM_GRACE_MS + 1, 1400),
    ).toMatchObject({ kind: 'abandon', reason: 'grace_expired', endedAtMs: 1_990_000 });
  });

  it('a connected participant completes', () => {
    expect(settlementForReconnectAfterClose(participant(), closedRun(), 3_000_000, 1400)).toEqual({
      kind: 'complete',
      endedAtMs: 2_000_000,
    });
  });
});

describe('settlementForTimerLost and graceRemainingMs', () => {
  it('timer_lost is 0 focused seconds at the given instant', () => {
    expect(settlementForTimerLost(77)).toEqual({
      kind: 'abandon',
      reason: 'timer_lost',
      focusedSeconds: 0,
      endedAtMs: 77,
    });
  });

  it('grace remaining', () => {
    expect(graceRemainingMs(participant(), 5)).toBe(ROOM_GRACE_MS);
    const p = participant({ disconnectedAtMs: 1_000, elapsedAtDisconnectMs: 1 });
    expect(graceRemainingMs(p, 1_000)).toBe(ROOM_GRACE_MS);
    expect(graceRemainingMs(p, 21_000)).toBe(40_000);
    expect(graceRemainingMs(p, 61_000)).toBe(0);
    expect(graceRemainingMs(p, 9_000_000)).toBe(0);
    expect(graceRemainingMs(p, 0)).toBe(ROOM_GRACE_MS); // clock went backwards
  });
});

// ---- planRun ---------------------------------------------------------------------------

const NOW = 10_000_000;
const withRun = (s: TimerState, id: string | null = RUN_A): TimerState => ({
  ...s,
  focusRunId: id,
});
const focusIdle = (): TimerState => withRun(m.initial(settings, 100));
const accept = (s: TimerState, c: TimerCommand, now: number): TimerState => {
  const r = m.apply(s, c, now, settings);
  if (!r.ok) throw new Error('rejected');
  return r.state;
};
const plan = (prev: TimerState, c: TimerCommand, now = NOW) =>
  planRun(prev, accept(prev, c, now), 'command', c, now, RUN_B);

describe('planRun', () => {
  it('creation of a focus phase opens a run', () => {
    const out = planRun(undefined, m.initial(settings, 1), 'created', undefined, NOW, RUN_B);
    expect(out.state.focusRunId).toBe(RUN_B);
    expect(out.runs).toEqual({ open: { runId: RUN_B, openedAtMs: NOW } });
  });

  it('creation of a break opens nothing', () => {
    const out = planRun(
      undefined,
      m.initial(settings, 1, 'short_break'),
      'created',
      undefined,
      NOW,
      RUN_B,
    );
    expect(out.state.focusRunId).toBeNull();
    expect(out.runs).toBeUndefined();
  });

  it('start, pause and resume keep the run and write no run effects', () => {
    const idle = focusIdle();
    const started = plan(idle, { type: 'start' }, 1_000);
    expect(started).toMatchObject({ runs: undefined, state: { focusRunId: RUN_A } });
    const paused = plan(started.state, { type: 'pause' }, 2_000);
    expect(paused).toMatchObject({ runs: undefined, state: { focusRunId: RUN_A } });
    const resumed = plan(paused.state, { type: 'resume' }, 3_000);
    expect(resumed).toMatchObject({ runs: undefined, state: { focusRunId: RUN_A } });
  });

  it('reset in focus closes the old run at the current elapsed time and opens a new one', () => {
    const running = accept(focusIdle(), { type: 'start' }, 1_000);
    const out = plan(running, { type: 'reset', expectedVersion: running.version }, 61_000);
    expect(out.state.focusRunId).toBe(RUN_B);
    expect(out.runs).toEqual({
      close: { runId: RUN_A, reason: 'reset', closedAtMs: 61_000, elapsedAtCloseMs: 60_000 },
      open: { runId: RUN_B, openedAtMs: 61_000 },
    });
  });

  it('reset or setPhase after the phase is already over closes the run as completed (D35)', () => {
    const running = accept(focusIdle(), { type: 'start' }, 1_000);
    const reset = plan(running, { type: 'reset', expectedVersion: running.version }, 1_600_000);
    expect(reset.runs?.close).toMatchObject({
      runId: RUN_A,
      reason: 'completed',
      elapsedAtCloseMs: 1_500_000,
      closedAtMs: 1_501_000, // the true end (start 1_000 + 1_500_000), not the late command's now (G3)
    });
    expect(reset.runs?.open?.runId).toBe(RUN_B);
    const moved = plan(
      running,
      { type: 'setPhase', phase: 'long_break', expectedVersion: running.version },
      1_501_000,
    );
    expect(moved.runs?.close).toMatchObject({
      reason: 'completed',
      elapsedAtCloseMs: 1_500_000,
      closedAtMs: 1_501_000,
    });
    // One millisecond before the end it is still a reset.
    const early = plan(running, { type: 'reset', expectedVersion: running.version }, 1_500_999);
    expect(early.runs?.close?.reason).toBe('reset');
  });

  it('reset of an idle focus phase closes (elapsed 0) and opens', () => {
    const idle = focusIdle();
    const out = plan(idle, { type: 'reset', expectedVersion: idle.version });
    expect(out.runs?.close).toMatchObject({ runId: RUN_A, reason: 'reset', elapsedAtCloseMs: 0 });
    expect(out.runs?.open?.runId).toBe(RUN_B);
  });

  it('setPhase away from focus closes with phase_changed and opens nothing', () => {
    const running = accept(focusIdle(), { type: 'start' }, 1_000);
    const out = plan(
      running,
      { type: 'setPhase', phase: 'long_break', expectedVersion: running.version },
      31_000,
    );
    expect(out.state.focusRunId).toBeNull();
    expect(out.runs).toEqual({
      close: {
        runId: RUN_A,
        reason: 'phase_changed',
        closedAtMs: 31_000,
        elapsedAtCloseMs: 30_000,
      },
    });
  });

  it('setPhase from a break to focus opens a run and closes nothing', () => {
    const brk = m.initial(settings, 5, 'short_break');
    const out = plan(brk, { type: 'setPhase', phase: 'focus', expectedVersion: 5 });
    expect(out.state.focusRunId).toBe(RUN_B);
    expect(out.runs).toEqual({ open: { runId: RUN_B, openedAtMs: NOW } });
  });

  it('setPhase between breaks changes no run', () => {
    const brk = m.initial(settings, 5, 'short_break');
    const out = plan(brk, { type: 'setPhase', phase: 'long_break', expectedVersion: 5 });
    expect(out.state.focusRunId).toBeNull();
    expect(out.runs).toBeUndefined();
  });

  it('the end of a focus phase closes it as completed at its full duration', () => {
    const running = accept(focusIdle(), { type: 'start' }, 1_000);
    const done = m.completePhase(running, 1_600_000, settings);
    if (!done.ok) throw new Error('not due');
    const out = planRun(running, done.state, 'phase_end', undefined, 1_600_000, RUN_B);
    expect(out.state).toMatchObject({ phase: 'short_break', focusRunId: null });
    // The job ran 99 s late: the run closes at the TRUE end (1_000 + 1_500_000), not at the
    // job's own time, so a disconnect in between counts as present through the end (G3).
    expect(out.runs).toEqual({
      close: {
        runId: RUN_A,
        reason: 'completed',
        closedAtMs: 1_501_000,
        elapsedAtCloseMs: 1_500_000,
      },
    });
  });

  it('an on-time phase end closes at the job time (which is the true end)', () => {
    const running = accept(focusIdle(), { type: 'start' }, 1_000);
    const done = m.completePhase(running, 1_501_000, settings);
    if (!done.ok) throw new Error('not due');
    const out = planRun(running, done.state, 'phase_end', undefined, 1_501_000, RUN_B);
    expect(out.runs?.close).toMatchObject({ closedAtMs: 1_501_000, elapsedAtCloseMs: 1_500_000 });
  });

  it('an end after a pause/resume closes at the true end, not at the job time (G3)', () => {
    const started = accept(focusIdle(), { type: 'start' }, 0);
    const paused = accept(started, { type: 'pause' }, 400_000);
    const resumed = accept(paused, { type: 'resume' }, 1_000_000); // 1_100_000 ms left
    const trueEnd = 1_000_000 + 1_100_000;
    const done = m.completePhase(resumed, trueEnd + 30_000, settings);
    if (!done.ok) throw new Error('not due');
    const out = planRun(resumed, done.state, 'phase_end', undefined, trueEnd + 30_000, RUN_B);
    expect(out.runs?.close).toMatchObject({ closedAtMs: trueEnd, elapsedAtCloseMs: 1_500_000 });
  });

  it('the end of a break opens a new focus run', () => {
    const brk = accept(m.initial(settings, 5, 'short_break'), { type: 'start' }, 0);
    const done = m.completePhase(brk, 400_000, settings);
    if (!done.ok) throw new Error('not due');
    const out = planRun(brk, done.state, 'phase_end', undefined, 400_000, RUN_B);
    expect(out.state).toMatchObject({ phase: 'focus', focusRunId: RUN_B });
    expect(out.runs).toEqual({ open: { runId: RUN_B, openedAtMs: 400_000 } });
  });

  it('repairs a focus timer that has no run (written before Phase 8)', () => {
    const legacy = m.initial(settings, 7);
    const out = plan(legacy, { type: 'start' }, 1_000);
    expect(out.state.focusRunId).toBe(RUN_B);
    expect(out.runs).toEqual({ open: { runId: RUN_B, openedAtMs: 1_000 } });
  });

  it('a legacy focus timer with no run closes nothing on reset', () => {
    const legacy = m.initial(settings, 7);
    const out = plan(legacy, { type: 'reset', expectedVersion: 7 });
    expect(out.runs).toEqual({ open: { runId: RUN_B, openedAtMs: NOW } });
  });
});

describe('pendingEndAtMs (G3, an open run past its true end)', () => {
  const running: TimerState = {
    phase: 'focus',
    status: 'running',
    durationMs: 1_500_000,
    elapsedBeforeMs: 0,
    segmentStartedAtMs: 1_000_000,
    version: 1,
    focusRunId: RUN_A,
  };
  const endsAt = 2_500_000;

  it('returns the true end for a disconnect at or after it', () => {
    expect(pendingEndAtMs(participant({ disconnectedAtMs: endsAt }), RUN_A, running)).toBe(endsAt);
    expect(pendingEndAtMs(participant({ disconnectedAtMs: endsAt + 9_000 }), RUN_A, running)).toBe(
      endsAt,
    );
  });

  it('is null for a disconnect strictly before the end, a connected person or no timer', () => {
    expect(
      pendingEndAtMs(participant({ disconnectedAtMs: endsAt - 1 }), RUN_A, running),
    ).toBeNull();
    expect(pendingEndAtMs(participant(), RUN_A, running)).toBeNull();
    expect(pendingEndAtMs(participant({ disconnectedAtMs: endsAt }), RUN_A, undefined)).toBeNull();
  });

  it('is null for a paused, idle, other-run or break timer', () => {
    const p = participant({ disconnectedAtMs: endsAt + 1 });
    expect(
      pendingEndAtMs(p, RUN_A, { ...running, status: 'paused', segmentStartedAtMs: null }),
    ).toBeNull();
    expect(
      pendingEndAtMs(p, RUN_A, { ...running, status: 'idle', segmentStartedAtMs: null }),
    ).toBeNull();
    expect(pendingEndAtMs(p, RUN_B, running)).toBeNull();
    expect(
      pendingEndAtMs(p, RUN_A, { ...running, phase: 'short_break', focusRunId: null }),
    ).toBeNull();
  });
});

describe('settlementForStale (RF17)', () => {
  const entry: LedgerParticipant = {
    userId: 'u',
    sessionId: 's',
    optedInAtMs: 0,
    elapsedAtOptInMs: 60_000,
    disconnectedAtMs: null,
    elapsedAtDisconnectMs: null,
  };

  it('counts from the opt-in to the elapsed time, floored, as expired', () => {
    expect(settlementForStale(entry, 960_900, 5_000_000, 1_500)).toEqual({
      kind: 'abandon',
      reason: 'expired',
      focusedSeconds: 900,
      endedAtMs: 5_000_000,
    });
  });

  it('never counts past a disconnect, nor past the planned seconds, nor below 0', () => {
    expect(
      settlementForStale(
        { ...entry, disconnectedAtMs: 1, elapsedAtDisconnectMs: 180_000 },
        960_000,
        9,
        1_500,
      ),
    ).toMatchObject({ focusedSeconds: 120 });
    expect(settlementForStale(entry, 99_000_000, 9, 1_500)).toMatchObject({
      focusedSeconds: 1_500,
    });
    expect(settlementForStale(entry, 0, 9, 1_500)).toMatchObject({ focusedSeconds: 0 });
  });

  it('counts 0 s without a ledger entry', () => {
    expect(settlementForStale(undefined, 999_000, 7, 1_500)).toEqual({
      kind: 'abandon',
      reason: 'expired',
      focusedSeconds: 0,
      endedAtMs: 7,
    });
  });
});
