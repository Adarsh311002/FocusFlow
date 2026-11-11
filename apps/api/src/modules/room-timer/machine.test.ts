import { type TimerCommand, timerViewSchema } from '@focus-flow/contracts';
import { describe, expect, it } from 'vitest';

import { createTimerMachine, timerMachine } from './machine.js';
import type { TimerSettings, TimerState } from './types.js';

const m = createTimerMachine();
const ROOM = '0190a7b2-0000-7000-8000-000000000001';
const settings: TimerSettings = { focusMs: 60_000, shortBreakMs: 10_000, longBreakMs: 30_000 };
const other: TimerSettings = { focusMs: 90_000, shortBreakMs: 20_000, longBreakMs: 40_000 };

const idle = (version = 100): TimerState => m.initial(settings, version);

const accepted = (
  state: TimerState,
  command: TimerCommand,
  now: number,
  s: TimerSettings = settings,
): TimerState => {
  const r = m.apply(state, command, now, s);
  if (!r.ok) throw new Error(`rejected: ${r.rejection.code}`);
  return r.state;
};

const rejectedCode = (state: TimerState, command: TimerCommand, now = 0): string | undefined => {
  const r = m.apply(state, command, now, settings);
  return r.ok ? undefined : r.rejection.code;
};

const running = (): TimerState => accepted(idle(), { type: 'start' }, 1_000);
const paused = (): TimerState => accepted(running(), { type: 'pause' }, 11_000);

describe('timer machine: initial', () => {
  it('creates an idle focus timer at the base version', () => {
    expect(idle(777)).toEqual({
      phase: 'focus',
      status: 'idle',
      durationMs: 60_000,
      elapsedBeforeMs: 0,
      segmentStartedAtMs: null,
      version: 777,
      focusRunId: null,
    });
  });

  it('uses the duration of the requested phase', () => {
    expect(m.initial(settings, 1, 'short_break').durationMs).toBe(10_000);
    expect(m.initial(settings, 1, 'long_break').durationMs).toBe(30_000);
  });

  it('exports a ready machine', () => {
    expect(timerMachine.initial(settings, 5)).toEqual(idle(5));
  });
});

describe('timer machine: start, pause, resume', () => {
  it('start moves idle to running and bumps the version', () => {
    const s = running();
    expect(s).toMatchObject({ status: 'running', segmentStartedAtMs: 1_000, version: 101 });
    expect(m.endsAtMs(s)).toBe(61_000);
  });

  it('start from running or paused is an invalid transition', () => {
    expect(rejectedCode(running(), { type: 'start' })).toBe('INVALID_TRANSITION');
    expect(rejectedCode(paused(), { type: 'start' })).toBe('INVALID_TRANSITION');
  });

  it('pause accumulates the elapsed stretch and clears the segment', () => {
    const s = paused();
    expect(s).toMatchObject({
      status: 'paused',
      elapsedBeforeMs: 10_000,
      segmentStartedAtMs: null,
      version: 102,
    });
    expect(m.endsAtMs(s)).toBeNull();
  });

  it('a repeated pause is a no-op that keeps the state object', () => {
    const s = paused();
    const r = m.apply(s, { type: 'pause' }, 50_000, settings);
    expect(r).toEqual({ ok: true, state: s, changed: false });
    expect(r.ok && r.state).toBe(s);
  });

  it('pause from idle is an invalid transition', () => {
    expect(rejectedCode(idle(), { type: 'pause' })).toBe('INVALID_TRANSITION');
  });

  it('resume continues from the accumulated elapsed time', () => {
    const s = accepted(paused(), { type: 'resume' }, 20_000);
    expect(s).toMatchObject({
      status: 'running',
      elapsedBeforeMs: 10_000,
      segmentStartedAtMs: 20_000,
      version: 103,
    });
    expect(m.endsAtMs(s)).toBe(70_000);
  });

  it('resume while running is a no-op', () => {
    const s = running();
    const r = m.apply(s, { type: 'resume' }, 5_000, settings);
    expect(r).toEqual({ ok: true, state: s, changed: false });
    expect(r.ok && r.state).toBe(s);
  });

  it('resume from idle is an invalid transition', () => {
    expect(rejectedCode(idle(), { type: 'resume' })).toBe('INVALID_TRANSITION');
  });

  it('pause one millisecond before the end is accepted', () => {
    const s = accepted(running(), { type: 'pause' }, 60_999);
    expect(s.elapsedBeforeMs).toBe(59_999);
    expect(s.status).toBe('paused');
  });

  it('pause exactly at the end is rejected', () => {
    expect(m.apply(running(), { type: 'pause' }, 61_000, settings)).toEqual({
      ok: false,
      rejection: { code: 'INVALID_TRANSITION', message: 'The phase has just ended.' },
    });
  });

  it('pause long after the end is rejected', () => {
    expect(rejectedCode(running(), { type: 'pause' }, 9_999_999)).toBe('INVALID_TRANSITION');
  });

  it('reset and setPhase at or after the end are still allowed', () => {
    const r = running();
    expect(accepted(r, { type: 'reset', expectedVersion: r.version }, 61_000).status).toBe('idle');
    expect(
      accepted(r, { type: 'setPhase', phase: 'long_break', expectedVersion: r.version }, 99_000)
        .phase,
    ).toBe('long_break');
  });

  it('a clock that went backwards never yields negative elapsed or a lower version', () => {
    const r = running();
    expect(m.elapsedMs(r, 500)).toBe(0);
    const s = accepted(r, { type: 'pause' }, 500);
    expect(s.elapsedBeforeMs).toBe(0);
    expect(s.version).toBe(r.version + 1);
  });
});

describe('timer machine: reset', () => {
  const states: [string, TimerState][] = [
    ['idle', idle()],
    ['running', running()],
    ['paused', paused()],
  ];

  it.each(states)('reset from %s gives an idle phase with the new duration', (_name, s) => {
    const out = accepted(s, { type: 'reset', expectedVersion: s.version }, 30_000, other);
    expect(out).toEqual({
      phase: 'focus',
      status: 'idle',
      durationMs: 90_000,
      elapsedBeforeMs: 0,
      segmentStartedAtMs: null,
      version: s.version + 1,
      focusRunId: null,
    });
  });

  it('keeps the current phase', () => {
    const b = m.initial(settings, 4, 'short_break');
    expect(accepted(b, { type: 'reset', expectedVersion: 4 }, 0, other)).toMatchObject({
      phase: 'short_break',
      durationMs: 20_000,
    });
  });

  it('a stale or future expectedVersion is a VERSION_CONFLICT', () => {
    const s = running();
    expect(rejectedCode(s, { type: 'reset', expectedVersion: s.version - 1 })).toBe(
      'VERSION_CONFLICT',
    );
    expect(rejectedCode(s, { type: 'reset', expectedVersion: s.version + 1 })).toBe(
      'VERSION_CONFLICT',
    );
  });
});

describe('timer machine: setPhase', () => {
  it('moves to idle in the new phase with its duration', () => {
    const s = running();
    expect(
      accepted(s, { type: 'setPhase', phase: 'long_break', expectedVersion: s.version }, 5, other),
    ).toEqual({
      phase: 'long_break',
      status: 'idle',
      durationMs: 40_000,
      elapsedBeforeMs: 0,
      segmentStartedAtMs: null,
      version: s.version + 1,
      focusRunId: null,
    });
  });

  it('works from every status', () => {
    for (const s of [idle(), running(), paused()]) {
      const out = accepted(
        s,
        { type: 'setPhase', phase: 'short_break', expectedVersion: s.version },
        5,
      );
      expect(out.status).toBe('idle');
      expect(out.phase).toBe('short_break');
    }
  });

  it('the same phase is an invalid transition', () => {
    const s = idle();
    expect(rejectedCode(s, { type: 'setPhase', phase: 'focus', expectedVersion: s.version })).toBe(
      'INVALID_TRANSITION',
    );
  });

  it('checks the version before the transition', () => {
    const s = idle();
    expect(
      rejectedCode(s, { type: 'setPhase', phase: 'focus', expectedVersion: s.version + 5 }),
    ).toBe('VERSION_CONFLICT');
  });
});

describe('timer machine: completePhase', () => {
  const r = running(); // ends at 61_000

  it('is not due one millisecond before the end', () => {
    const out = m.completePhase(r, 60_999, settings);
    expect(out).toEqual({
      ok: false,
      rejection: { code: 'NOT_DUE', message: expect.any(String) as unknown, remainingMs: 1 },
    });
  });

  it('is due exactly at the end', () => {
    const out = m.completePhase(r, 61_000, settings);
    expect(out.ok && out.changed).toBe(true);
  });

  it('focus becomes an idle short break; never auto-started', () => {
    const out = m.completePhase(r, 70_000, other);
    expect(out.ok && out.state).toEqual({
      phase: 'short_break',
      status: 'idle',
      durationMs: 20_000,
      elapsedBeforeMs: 0,
      segmentStartedAtMs: null,
      version: r.version + 1,
      focusRunId: null,
    });
  });

  it('a break becomes an idle focus', () => {
    for (const phase of ['short_break', 'long_break'] as const) {
      const started = accepted(m.initial(settings, 9, phase), { type: 'start' }, 0);
      const out = m.completePhase(started, 1_000_000, settings);
      expect(out.ok && out.state).toMatchObject({
        phase: 'focus',
        status: 'idle',
        durationMs: 60_000,
      });
    }
  });

  it('idle and paused timers are invalid transitions', () => {
    for (const s of [idle(), paused()]) {
      const out = m.completePhase(s, 10_000_000, settings);
      expect(out.ok ? undefined : out.rejection.code).toBe('INVALID_TRANSITION');
    }
  });

  it('resuming a nearly finished timer ends one millisecond later', () => {
    const p = accepted(running(), { type: 'pause' }, 60_999); // 1 ms remaining
    const r = accepted(p, { type: 'resume' }, 100_000);
    expect(r.status).toBe('running');
    expect(m.endsAtMs(r)).toBe(100_001);
    expect(m.completePhase(r, 100_000, settings).ok).toBe(false);
    expect(m.completePhase(r, 100_001, settings).ok).toBe(true);
  });

  it('pause and resume keep durationMs when the settings differ from creation', () => {
    const p = accepted(running(), { type: 'pause' }, 11_000, other);
    expect(p.durationMs).toBe(60_000);
    expect(accepted(p, { type: 'resume' }, 12_000, other).durationMs).toBe(60_000);
    expect(accepted(idle(), { type: 'start' }, 1, other).durationMs).toBe(60_000);
  });

  it('accounts for time elapsed before a pause', () => {
    const resumed = accepted(paused(), { type: 'resume' }, 20_000); // ends 70_000
    expect(m.completePhase(resumed, 69_999, settings).ok).toBe(false);
    expect(m.completePhase(resumed, 70_000, settings).ok).toBe(true);
  });
});

describe('timer machine: focusRunId', () => {
  const RUN = '0190a7b2-0000-7000-8000-0000000000aa';
  const withRun = (state: TimerState): TimerState => ({ ...state, focusRunId: RUN });

  it('a new machine state has no run; the service assigns it', () => {
    expect(idle().focusRunId).toBeNull();
    expect(m.initial(settings, 1, 'short_break').focusRunId).toBeNull();
  });

  it('start, pause and resume keep the run unchanged', () => {
    const started = accepted(withRun(idle()), { type: 'start' }, 1_000);
    expect(started.focusRunId).toBe(RUN);
    const p = accepted(started, { type: 'pause' }, 5_000);
    expect(p.focusRunId).toBe(RUN);
    expect(accepted(p, { type: 'resume' }, 6_000).focusRunId).toBe(RUN);
  });

  it('a no-op returns the very same state, run included', () => {
    const p = withRun(paused());
    const r = m.apply(p, { type: 'pause' }, 50_000, settings);
    expect(r.ok && r.state).toBe(p);
  });

  it('reset and setPhase clear the run (the service issues a new one)', () => {
    const s = withRun(running());
    expect(accepted(s, { type: 'reset', expectedVersion: s.version }, 5_000).focusRunId).toBeNull();
    for (const phase of ['short_break', 'long_break'] as const) {
      expect(
        accepted(s, { type: 'setPhase', phase, expectedVersion: s.version }, 5_000).focusRunId,
      ).toBeNull();
    }
  });

  it('a phase end clears the run, for a focus and for a break', () => {
    const out = m.completePhase(withRun(running()), 70_000, settings);
    expect(out.ok && out.state.focusRunId).toBeNull();
    const brk = accepted(m.initial(settings, 9, 'short_break'), { type: 'start' }, 0);
    const out2 = m.completePhase(brk, 1_000_000, settings);
    expect(out2.ok && out2.state.focusRunId).toBeNull();
  });

  it('toView carries the run id and stays valid', () => {
    const v = m.toView(ROOM, withRun(running()));
    expect(v.focusRunId).toBe(RUN);
    expect(timerViewSchema.safeParse(v).success).toBe(true);
    expect(m.toView(ROOM, idle()).focusRunId).toBeNull();
  });
});

describe('timer machine: derived values', () => {
  it('elapsedMs follows the running stretch and clamps', () => {
    const r = running();
    expect(m.elapsedMs(r, 1_000)).toBe(0);
    expect(m.elapsedMs(r, 31_000)).toBe(30_000);
    expect(m.elapsedMs(r, 1_000_000)).toBe(60_000);
    expect(m.elapsedMs(paused(), 1_000_000)).toBe(10_000);
  });

  it('does not crash on a zero-duration phase', () => {
    const z: TimerState = { ...idle(), durationMs: 0 };
    const r = accepted(z, { type: 'start' }, 5);
    expect(m.elapsedMs(r, 100)).toBe(0);
    expect(m.completePhase(r, 5, settings).ok).toBe(true);
    expect(rejectedCode(r, { type: 'pause' }, 9)).toBe('INVALID_TRANSITION');
  });

  it('toView exposes endsAt and segment start only while running', () => {
    for (const s of [idle(), running(), paused()]) {
      const v = m.toView(ROOM, s);
      expect(timerViewSchema.safeParse(v).success).toBe(true);
      expect(v.endsAtMs).toBe(s.status === 'running' ? m.endsAtMs(s) : null);
      expect(v.segmentStartedAtMs).toBe(s.status === 'running' ? s.segmentStartedAtMs : null);
    }
    expect(m.toView(ROOM, running())).toMatchObject({
      roomId: ROOM,
      endsAtMs: 61_000,
      segmentStartedAtMs: 1_000,
    });
  });
});
