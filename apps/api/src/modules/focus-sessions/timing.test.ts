import { describe, expect, it } from 'vitest';

import {
  accumulatedSeconds,
  complete,
  expire,
  expireGrace,
  hasReachedPlannedEnd,
  pause,
  plannedEndMs,
  remainingSeconds,
  resume,
  type RunningSession,
  SessionClockError,
  type SoloSession,
  startSession,
  stop,
  type Transition,
} from './timing.js';

// Solo session formulas and transitions (docs/architecture/focus-timing-protocol.md,
// "Solo sessions"). Instants are epoch milliseconds; T0 is an arbitrary start.

const T0 = 1_791_000_000_000;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;

/** The session a transition produced, failing the test if it did not apply. */
const applied = (transition: Transition): SoloSession => {
  expect(transition.outcome).toBe('changed');
  return transition.session;
};

const running = (session: SoloSession): RunningSession => {
  if (session.status !== 'in_progress' || session.runningSinceMs === null) {
    throw new Error('expected a running session');
  }
  return session;
};

describe('startSession', () => {
  it('starts running with nothing accumulated: R = started_at = now, F = 0', () => {
    const session = startSession(1_500, T0);
    expect(session).toEqual({
      status: 'in_progress',
      plannedSeconds: 1_500,
      focusedSeconds: 0,
      startedAtMs: T0,
      runningSinceMs: T0,
    });
    expect(plannedEndMs(session)).toBe(T0 + 25 * MINUTE);
    expect(accumulatedSeconds(session, T0)).toBe(0);
    expect(remainingSeconds(session, T0)).toBe(1_500);
  });

  it.each([59, 14_401, 90.5, Number.NaN])('rejects the planned duration %j (E1)', (planned) => {
    expect(() => startSession(planned, T0)).toThrow(RangeError);
  });

  it('accepts both planned-duration bounds', () => {
    expect(startSession(60, T0).plannedSeconds).toBe(60);
    expect(startSession(14_400, T0).plannedSeconds).toBe(14_400);
  });
});

describe('accumulated time', () => {
  it('grows with the running stretch and is capped at the plan', () => {
    const session = startSession(120, T0);
    expect(accumulatedSeconds(session, T0 + 30 * SECOND)).toBe(30);
    expect(accumulatedSeconds(session, T0 + 30_500)).toBe(30.5);
    expect(accumulatedSeconds(session, T0 + 10 * MINUTE)).toBe(120);
    expect(remainingSeconds(session, T0 + 10 * MINUTE)).toBe(0);
  });

  it('is frozen while paused', () => {
    const paused = applied(pause(startSession(120, T0), T0 + 45 * SECOND));
    expect(accumulatedSeconds(paused, T0 + 10 * MINUTE)).toBe(45);
  });
});

describe('pause and resume', () => {
  it('pause adds the whole seconds of the stretch and clears R', () => {
    const paused = applied(pause(startSession(1_500, T0), T0 + 90 * SECOND));
    expect(paused).toMatchObject({
      status: 'in_progress',
      focusedSeconds: 90,
      runningSinceMs: null,
    });
  });

  it('rounds partial seconds down at a pause (E14)', () => {
    const paused = applied(pause(startSession(1_500, T0), T0 + 1_999));
    expect(paused.focusedSeconds).toBe(1);
    const fractional = applied(pause(startSession(1_500, T0), T0 + 2_000.9));
    expect(fractional.focusedSeconds).toBe(2);
  });

  it('resume starts a new stretch at now and moves the planned end', () => {
    const paused = applied(pause(startSession(1_500, T0), T0 + 10 * MINUTE));
    const resumed = running(applied(resume(paused, T0 + 20 * MINUTE)));
    expect(resumed.runningSinceMs).toBe(T0 + 20 * MINUTE);
    expect(resumed.focusedSeconds).toBe(600);
    expect(plannedEndMs(resumed)).toBe(T0 + 20 * MINUTE + 15 * MINUTE);
  });

  it('repeated pause/resume accumulates each stretch, under-counting at most 1 s per pause', () => {
    let session: SoloSession = startSession(1_500, T0);
    let now = T0;
    for (let cycle = 0; cycle < 10; cycle += 1) {
      now += 10_999; // 10.999 s focused
      session = applied(pause(session, now));
      now += 5 * SECOND; // paused
      session = applied(resume(session, now));
    }
    expect(session.focusedSeconds).toBe(100); // 10 × 10 s, not 109.99
  });

  it('pausing a paused session and resuming a running one are harmless repeats (E11)', () => {
    const runningSession = startSession(1_500, T0);
    expect(resume(runningSession, T0 + SECOND)).toEqual({
      outcome: 'unchanged',
      session: runningSession,
    });
    const paused = applied(pause(runningSession, T0 + SECOND));
    expect(pause(paused, T0 + 2 * SECOND)).toEqual({ outcome: 'unchanged', session: paused });
  });

  it('refuses a resume before started_at (a clock step back) instead of adjusting it (E15)', () => {
    const paused = applied(pause(startSession(1_500, T0), T0 + MINUTE));
    expect(() => resume(paused, T0 - MINUTE)).toThrow(SessionClockError);
  });

  it('refuses a pause before the running stretch began instead of counting zero', () => {
    expect(() => pause(startSession(1_500, T0), T0 - 1)).toThrow(SessionClockError);
  });

  it('a pause at or after T_end caps F at P (E7: the completion decision ran first)', () => {
    const paused = applied(pause(startSession(60, T0), T0 + 5 * MINUTE));
    expect(paused.focusedSeconds).toBe(60);
  });
});

describe('early stop', () => {
  it('a running session keeps the whole seconds focused and ends now', () => {
    const stopped = applied(stop(startSession(1_500, T0), T0 + 7 * MINUTE + 400));
    expect(stopped).toMatchObject({
      status: 'abandoned',
      abandonReason: 'stopped',
      focusedSeconds: 420,
      runningSinceMs: null,
      endedAtMs: T0 + 7 * MINUTE + 400,
    });
  });

  it('a paused session keeps what it accumulated', () => {
    const paused = applied(pause(startSession(1_500, T0), T0 + 2 * MINUTE));
    const stopped = applied(stop(paused, T0 + 30 * MINUTE));
    expect(stopped).toMatchObject({ focusedSeconds: 120, endedAtMs: T0 + 30 * MINUTE });
  });

  it('refuses to end before the latest stored instant (a clock step back), never adjusting it', () => {
    expect(() => stop(startSession(1_500, T0), T0 - SECOND)).toThrow(SessionClockError);
    expect(() => expire(startSession(1_500, T0), T0 - SECOND)).toThrow(SessionClockError);
    expect(() => accumulatedSeconds(startSession(1_500, T0), T0 - SECOND)).toThrow(
      SessionClockError,
    );
  });
});

describe('completion', () => {
  it('completes exactly at the planned end: F = P, ended_at = T_end', () => {
    const session = startSession(1_500, T0);
    expect(hasReachedPlannedEnd(session, T0 + 25 * MINUTE - 1)).toBe(false);
    expect(hasReachedPlannedEnd(session, T0 + 25 * MINUTE)).toBe(true);
    expect(applied(complete(session, T0 + 25 * MINUTE))).toEqual({
      status: 'completed',
      plannedSeconds: 1_500,
      focusedSeconds: 1_500,
      startedAtMs: T0,
      runningSinceMs: null,
      endedAtMs: T0 + 25 * MINUTE,
    });
  });

  it('records T_end, not the (later) decision time, as ended_at', () => {
    const completed = applied(complete(startSession(60, T0), T0 + 3 * MINUTE));
    expect(completed).toMatchObject({ focusedSeconds: 60, endedAtMs: T0 + MINUTE });
  });

  it('completes after pauses, at the planned end of the last stretch', () => {
    const paused = applied(pause(startSession(120, T0), T0 + 50 * SECOND));
    const resumed = applied(resume(paused, T0 + 10 * MINUTE));
    expect(complete(resumed, T0 + 10 * MINUTE + 69 * SECOND).outcome).toBe('rejected');
    expect(applied(complete(resumed, T0 + 10 * MINUTE + 70 * SECOND))).toMatchObject({
      focusedSeconds: 120,
      endedAtMs: T0 + 10 * MINUTE + 70 * SECOND,
    });
  });

  it('is rejected before the planned end', () => {
    const session = startSession(1_500, T0);
    expect(complete(session, T0 + 10 * MINUTE)).toEqual({
      outcome: 'rejected',
      session,
      reason: 'before_planned_end',
    });
  });

  it('a paused session cannot complete, even with nothing left to focus', () => {
    const paused = applied(pause(startSession(60, T0), T0 + 2 * MINUTE)); // F = P = 60
    expect(complete(paused, T0 + 3 * MINUTE)).toEqual({
      outcome: 'rejected',
      session: paused,
      reason: 'not_running',
    });
  });

  it('with zero remaining time, a resumed session completes at once', () => {
    const paused = applied(pause(startSession(60, T0), T0 + 2 * MINUTE)); // F = P
    const resumed = running(applied(resume(paused, T0 + 3 * MINUTE)));
    expect(plannedEndMs(resumed)).toBe(T0 + 3 * MINUTE);
    expect(remainingSeconds(resumed, T0 + 3 * MINUTE)).toBe(0);
    expect(applied(complete(resumed, T0 + 3 * MINUTE))).toMatchObject({
      status: 'completed',
      focusedSeconds: 60,
      endedAtMs: T0 + 3 * MINUTE,
    });
  });
});

describe('grace expiry', () => {
  it('before T_end: keeps the time up to the disconnect and ends then', () => {
    const settled = applied(expireGrace(startSession(1_500, T0), T0 + 10 * MINUTE + 750));
    expect(settled).toMatchObject({
      status: 'abandoned',
      abandonReason: 'grace_expired',
      focusedSeconds: 600,
      endedAtMs: T0 + 10 * MINUTE + 750,
    });
  });

  it('a disconnect after T_end is clamped to T_end', () => {
    const settled = applied(expireGrace(startSession(1_500, T0), T0 + 40 * MINUTE));
    expect(settled).toMatchObject({ focusedSeconds: 1_500, endedAtMs: T0 + 25 * MINUTE });
  });

  it('a disconnect before the stretch began (clock skew) is clamped to R', () => {
    const paused = applied(pause(startSession(1_500, T0), T0 + 5 * MINUTE));
    const resumed = applied(resume(paused, T0 + 10 * MINUTE));
    const settled = applied(expireGrace(resumed, T0 + 9 * MINUTE));
    expect(settled).toMatchObject({ focusedSeconds: 300, endedAtMs: T0 + 10 * MINUTE });
  });

  it('a paused session has no grace to expire', () => {
    const paused = applied(pause(startSession(1_500, T0), T0 + MINUTE));
    expect(expireGrace(paused, T0 + 2 * MINUTE)).toMatchObject({
      outcome: 'rejected',
      reason: 'not_running',
    });
  });
});

describe('expiry', () => {
  it('discards the current running stretch', () => {
    const paused = applied(pause(startSession(1_500, T0), T0 + 4 * MINUTE));
    const resumed = applied(resume(paused, T0 + 5 * MINUTE));
    const expired = applied(expire(resumed, T0 + 9 * MINUTE));
    expect(expired).toMatchObject({
      status: 'abandoned',
      abandonReason: 'expired',
      focusedSeconds: 240,
      runningSinceMs: null,
      endedAtMs: T0 + 9 * MINUTE,
    });
  });

  it('keeps a paused session’s accumulated time (stale cleanup, E2)', () => {
    const paused = applied(pause(startSession(1_500, T0), T0 + 4 * MINUTE));
    const expired = applied(expire(paused, T0 + 12 * 60 * MINUTE));
    expect(expired).toMatchObject({ focusedSeconds: 240, endedAtMs: T0 + 12 * 60 * MINUTE });
  });
});

describe('terminal states', () => {
  const later = T0 + 60 * MINUTE;
  const ended: SoloSession[] = [
    applied(complete(startSession(60, T0), later)),
    applied(stop(startSession(1_500, T0), T0 + MINUTE)),
    applied(expireGrace(startSession(1_500, T0), T0 + MINUTE)),
    applied(expire(startSession(1_500, T0), T0 + MINUTE)),
  ];

  it.each(ended.map((session) => [session.status, session] as const))(
    'every transition on a %s session is an unchanged repeat',
    (_status, session) => {
      for (const transition of [
        pause(session, later),
        resume(session, later),
        stop(session, later),
        complete(session, later),
        expireGrace(session, later),
        expire(session, later),
      ]) {
        expect(transition).toEqual({ outcome: 'unchanged', session });
      }
    },
  );

  it('completed sessions always have F = P', () => {
    for (const session of ended) {
      if (session.status === 'completed') {
        expect(session.focusedSeconds).toBe(session.plannedSeconds);
      }
    }
  });
});
