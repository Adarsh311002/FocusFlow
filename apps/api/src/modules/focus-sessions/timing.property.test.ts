import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  complete,
  expire,
  expireGrace,
  hasReachedPlannedEnd,
  isEnded,
  isPaused,
  isRunning,
  pause,
  plannedEndMs,
  resume,
  type SoloSession,
  startSession,
  stop,
  type Transition,
} from './timing.js';

// Property tests (E13) over random *legal* histories: every step picks one of the
// transitions allowed in the current state, with random time passing in between, so the
// generator never manufactures an impossible database state.

type Step =
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'stop' }
  | { readonly kind: 'complete' }
  | { readonly kind: 'expireGrace'; readonly offsetMs: number }
  | { readonly kind: 'expire' };

const ABANDON_REASONS = new Set(['stopped', 'grace_expired', 'expired']);

/** Every invariant the database enforces (E1, E5, E15 and the lifecycle CHECKs). */
const expectInvariants = (session: SoloSession): void => {
  expect(Number.isInteger(session.focusedSeconds)).toBe(true);
  expect(session.focusedSeconds).toBeGreaterThanOrEqual(0);
  expect(session.focusedSeconds).toBeLessThanOrEqual(session.plannedSeconds);
  expect(session.plannedSeconds).toBeGreaterThanOrEqual(60);
  expect(session.plannedSeconds).toBeLessThanOrEqual(14_400);
  if (session.runningSinceMs !== null) {
    expect(session.status).toBe('in_progress');
    expect(session.runningSinceMs).toBeGreaterThanOrEqual(session.startedAtMs);
  }
  if (session.status !== 'in_progress') {
    expect(session.endedAtMs).toBeGreaterThanOrEqual(session.startedAtMs);
  }
  if (session.status === 'completed') {
    expect(session.focusedSeconds).toBe(session.plannedSeconds);
  }
  if (session.status === 'abandoned') {
    expect(ABANDON_REASONS.has(session.abandonReason)).toBe(true);
  }
};

/** The transitions allowed in the current state (and, for completion, at this time). */
const legalSteps = (session: SoloSession, nowMs: number, offsetMs: number): Step[] => {
  if (isEnded(session)) {
    return [];
  }
  if (isPaused(session)) {
    return [{ kind: 'resume' }, { kind: 'stop' }, { kind: 'expire' }];
  }
  const steps: Step[] = [
    { kind: 'pause' },
    { kind: 'stop' },
    { kind: 'expireGrace', offsetMs },
    { kind: 'expire' },
  ];
  if (isRunning(session) && hasReachedPlannedEnd(session, nowMs)) {
    steps.push({ kind: 'complete' });
  }
  return steps;
};

const applyStep = (session: SoloSession, step: Step, nowMs: number): Transition => {
  switch (step.kind) {
    case 'pause':
      return pause(session, nowMs);
    case 'resume':
      return resume(session, nowMs);
    case 'stop':
      return stop(session, nowMs);
    case 'complete':
      return complete(session, nowMs);
    case 'expireGrace':
      return expireGrace(session, nowMs - step.offsetMs);
    case 'expire':
      return expire(session, nowMs);
  }
};

const startArb = fc.record({
  plannedSeconds: fc.integer({ min: 60, max: 14_400 }),
  startedAtMs: fc.integer({ min: 1_700_000_000_000, max: 1_900_000_000_000 }),
});

/** One step of a history: time passes (fractional ms included), then a legal choice. */
const tickArb = fc.record({
  elapsedMs: fc.oneof(
    fc.integer({ min: 0, max: 5_000 }),
    fc.integer({ min: 0, max: 4 * 3_600_000 }),
    fc.double({ min: 0, max: 120_000, noNaN: true }),
  ),
  choice: fc.nat(),
  // How long before "now" a grace expiry's disconnect happened (can predate the stretch).
  graceOffsetMs: fc.integer({ min: -60_000, max: 6 * 3_600_000 }),
});

type History = { readonly sessions: SoloSession[]; readonly times: number[] };

const runHistory = (
  start: { plannedSeconds: number; startedAtMs: number },
  ticks: readonly { elapsedMs: number; choice: number; graceOffsetMs: number }[],
  allowed: (step: Step) => boolean = () => true,
): History => {
  let session: SoloSession = startSession(start.plannedSeconds, start.startedAtMs);
  let now = start.startedAtMs;
  const sessions: SoloSession[] = [session];
  const times = [now];
  for (const tick of ticks) {
    now += tick.elapsedMs;
    const steps = legalSteps(session, now, tick.graceOffsetMs).filter(allowed);
    const step = steps[tick.choice % Math.max(1, steps.length)];
    if (step === undefined) {
      continue;
    }
    const transition = applyStep(session, step, now);
    expect(transition.outcome).toBe('changed');
    session = transition.session;
    sessions.push(session);
    times.push(now);
  }
  return { sessions, times };
};

describe('solo timing properties', () => {
  it('every legal history keeps focused_seconds in [0, P] and every other invariant', () => {
    fc.assert(
      fc.property(startArb, fc.array(tickArb, { maxLength: 40 }), (start, ticks) => {
        const { sessions } = runHistory(start, ticks);
        for (const session of sessions) {
          expectInvariants(session);
          expect(session.plannedSeconds).toBe(start.plannedSeconds);
          expect(session.startedAtMs).toBe(start.startedAtMs);
        }
      }),
    );
  });

  it('focused time never decreases along a history', () => {
    fc.assert(
      fc.property(startArb, fc.array(tickArb, { maxLength: 40 }), (start, ticks) => {
        const { sessions } = runHistory(start, ticks);
        for (let index = 1; index < sessions.length; index += 1) {
          expect(sessions[index]!.focusedSeconds).toBeGreaterThanOrEqual(
            sessions[index - 1]!.focusedSeconds,
          );
        }
      }),
    );
  });

  it('random pause/resume sequences accumulate exactly the rounded-down running stretches', () => {
    fc.assert(
      fc.property(startArb, fc.array(tickArb, { maxLength: 60 }), (start, ticks) => {
        const { sessions, times } = runHistory(
          start,
          ticks,
          (step) => step.kind === 'pause' || step.kind === 'resume',
        );
        let expected = 0;
        for (let index = 1; index < sessions.length; index += 1) {
          const before = sessions[index - 1]!;
          const after = sessions[index]!;
          expectInvariants(after);
          if (isRunning(before) && isPaused(after)) {
            const stretch = Math.floor((times[index]! - before.runningSinceMs) / 1_000);
            expected = Math.min(start.plannedSeconds, expected + stretch);
          }
          expect(after.focusedSeconds).toBe(expected);
        }
      }),
    );
  });

  it('terminal states are terminal: every later transition is an unchanged repeat', () => {
    fc.assert(
      fc.property(
        startArb,
        fc.array(tickArb, { maxLength: 30 }),
        fc.integer({ min: 0, max: 24 * 3_600_000 }),
        (start, ticks, laterMs) => {
          const { sessions, times } = runHistory(start, ticks);
          const last = sessions.at(-1)!;
          if (!isEnded(last)) {
            return;
          }
          const now = times.at(-1)! + laterMs;
          for (const transition of [
            pause(last, now),
            resume(last, now),
            stop(last, now),
            complete(last, now),
            expireGrace(last, now),
            expire(last, now),
          ]) {
            expect(transition).toEqual({ outcome: 'unchanged', session: last });
          }
        },
      ),
    );
  });

  it('completion always sets F = P and ends exactly at T_end, never after now', () => {
    fc.assert(
      fc.property(startArb, fc.array(tickArb, { maxLength: 30 }), (start, ticks) => {
        const { sessions, times } = runHistory(start, ticks);
        for (let index = 1; index < sessions.length; index += 1) {
          const before = sessions[index - 1]!;
          const after = sessions[index]!;
          if (after.status === 'completed' && isRunning(before)) {
            expect(after.focusedSeconds).toBe(after.plannedSeconds);
            expect(after.endedAtMs).toBe(plannedEndMs(before));
            expect(after.endedAtMs).toBeLessThanOrEqual(times[index]!);
          }
        }
      }),
    );
  });

  it('a grace expiry with any disconnect instant stays within the running stretch', () => {
    fc.assert(
      fc.property(
        startArb,
        fc.integer({ min: 0, max: 6 * 3_600_000 }),
        fc.integer({ min: -3_600_000, max: 8 * 3_600_000 }),
        (start, runMs, disconnectOffsetMs) => {
          const session = startSession(start.plannedSeconds, start.startedAtMs);
          const settled = expireGrace(session, start.startedAtMs + disconnectOffsetMs).session;
          expectInvariants(settled);
          expect(settled.status).toBe('abandoned');
          if (settled.status === 'abandoned') {
            expect(settled.endedAtMs).toBeGreaterThanOrEqual(session.runningSinceMs);
            expect(settled.endedAtMs).toBeLessThanOrEqual(plannedEndMs(session));
          }
          // Unrelated time passing does not matter to a settled session.
          expect(pause(settled, start.startedAtMs + runMs).outcome).toBe('unchanged');
        },
      ),
    );
  });

  it('a paused session never completes', () => {
    fc.assert(
      fc.property(startArb, fc.array(tickArb, { maxLength: 30 }), fc.nat(), (start, ticks, ms) => {
        const { sessions, times } = runHistory(start, ticks);
        const last = sessions.at(-1)!;
        if (isPaused(last)) {
          expect(complete(last, times.at(-1)! + ms).outcome).toBe('rejected');
        }
      }),
    );
  });
});
