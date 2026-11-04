import { type TimerCommand, type TimerPhase, timerViewSchema } from '@focus-flow/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createTimerMachine } from './machine.js';
import type { TimerSettings, TimerState } from './types.js';

const m = createTimerMachine();
const ROOM = '0190a7b2-0000-7000-8000-000000000001';
const runs = { numRuns: 300 };

const settingsArb: fc.Arbitrary<TimerSettings> = fc.record({
  focusMs: fc.integer({ min: 60_000, max: 14_400_000 }),
  shortBreakMs: fc.integer({ min: 60_000, max: 3_600_000 }),
  longBreakMs: fc.integer({ min: 60_000, max: 7_200_000 }),
});

const phaseArb: fc.Arbitrary<TimerPhase> = fc.constantFrom<TimerPhase>(
  'focus',
  'short_break',
  'long_break',
);

type StepKind = 'start' | 'pause' | 'resume' | 'reset' | 'setPhase' | 'complete';

// A step: advance the clock by `dt` (never backwards), then issue an action. The
// `expectedVersion` of reset/setPhase is the live version plus `skew` (usually 0).
type Step = {
  readonly dt: number;
  readonly kind: StepKind;
  readonly phase: TimerPhase;
  readonly skew: number;
  readonly newSettings: TimerSettings;
};

const stepArb: fc.Arbitrary<Step> = fc.record({
  dt: fc.oneof(fc.integer({ min: 0, max: 5_000 }), fc.integer({ min: 0, max: 20_000_000 })),
  kind: fc.constantFrom<StepKind>('start', 'pause', 'resume', 'reset', 'setPhase', 'complete'),
  phase: phaseArb,
  skew: fc.constantFrom(0, 0, 0, 1, -1),
  newSettings: settingsArb,
});

/** `null` stands for the automatic phase end (`completePhase`). */
const toCommand = (step: Step, version: number): TimerCommand | null => {
  const expectedVersion = Math.max(0, version + step.skew);
  switch (step.kind) {
    case 'start':
    case 'pause':
    case 'resume':
      return { type: step.kind };
    case 'reset':
      return { type: 'reset', expectedVersion };
    case 'setPhase':
      return { type: 'setPhase', phase: step.phase, expectedVersion };
    case 'complete':
      return null;
  }
};

const checkInvariants = (s: TimerState, now: number): void => {
  expect(['focus', 'short_break', 'long_break']).toContain(s.phase);
  expect(['idle', 'running', 'paused']).toContain(s.status);
  expect(s.elapsedBeforeMs).toBeGreaterThanOrEqual(0);
  expect(s.elapsedBeforeMs).toBeLessThanOrEqual(s.durationMs);
  const elapsed = m.elapsedMs(s, now);
  expect(elapsed).toBeGreaterThanOrEqual(0);
  expect(elapsed).toBeLessThanOrEqual(s.durationMs);
  expect(s.durationMs - elapsed).toBeGreaterThanOrEqual(0);
  if (s.status === 'running') {
    expect(s.segmentStartedAtMs).not.toBeNull();
    const ends = m.endsAtMs(s);
    expect(ends).not.toBeNull();
    expect(ends ?? -1).toBeGreaterThanOrEqual(s.segmentStartedAtMs ?? Infinity);
  } else {
    expect(s.segmentStartedAtMs).toBeNull();
    expect(m.endsAtMs(s)).toBeNull();
  }
  expect(timerViewSchema.safeParse(m.toView(ROOM, s)).success).toBe(true);
};

describe('timer machine properties', () => {
  it('holds every invariant over random command sequences', () => {
    fc.assert(
      fc.property(
        settingsArb,
        fc.integer({ min: 0, max: 2_000_000_000 }),
        fc.integer({ min: 0, max: 1_000_000_000_000 }),
        fc.array(stepArb, { maxLength: 40 }),
        (settings, base, t0, steps) => {
          let state = m.initial(settings, base);
          let now = t0;
          checkInvariants(state, now);
          for (const step of steps) {
            const before = state;
            now += step.dt;
            const command = toCommand(step, before.version);
            const result =
              command === null
                ? m.completePhase(before, now, step.newSettings)
                : m.apply(before, command, now, step.newSettings);
            if (!result.ok) {
              // A rejection changes nothing; NOT_DUE only when genuinely not due.
              if (result.rejection.code === 'NOT_DUE') {
                expect(result.rejection.remainingMs).toBeGreaterThan(0);
                expect(now).toBeLessThan(m.endsAtMs(before) ?? -Infinity);
              }
              continue;
            }
            if (command === null) {
              // completePhase succeeds only when due.
              expect(before.status).toBe('running');
              expect(now).toBeGreaterThanOrEqual(m.endsAtMs(before) ?? Infinity);
              expect(result.state.status).toBe('idle');
              expect(result.state.phase).toBe(before.phase === 'focus' ? 'short_break' : 'focus');
            }
            state = result.state;
            if (result.changed) {
              expect(state.version).toBe(before.version + 1);
            } else {
              expect(state).toBe(before);
            }
            if (command?.type === 'pause') {
              expect(state.status === 'paused' ? state.elapsedBeforeMs : 0).toBeLessThan(
                state.durationMs,
              );
            }
            checkInvariants(state, now);
          }
        },
      ),
      runs,
    );
  });

  it('elapsed equals the wall time spent running, capped at the duration', () => {
    fc.assert(
      fc.property(
        settingsArb,
        fc.array(
          fc.record({
            dt: fc.oneof(
              fc.integer({ min: 0, max: 30_000 }),
              fc.integer({ min: 0, max: 30_000_000 }),
            ),
            type: fc.constantFrom<'start' | 'pause' | 'resume'>('start', 'pause', 'resume'),
          }),
          { maxLength: 30 },
        ),
        (settings, steps) => {
          let state = m.initial(settings, 1);
          let now = 1_000;
          let wallRunning = 0;
          for (const step of steps) {
            if (state.status === 'running') wallRunning += step.dt;
            now += step.dt;
            const r = m.apply(state, { type: step.type }, now, settings);
            if (r.ok) state = r.state;
            expect(m.elapsedMs(state, now)).toBe(Math.min(state.durationMs, wallRunning));
          }
        },
      ),
      runs,
    );
  });

  it('a pause is accepted exactly before the end, never leaving a timer paused at zero', () => {
    fc.assert(
      fc.property(
        settingsArb,
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 30_000_000 }),
        (settings, startAt, dt) => {
          const started = m.apply(m.initial(settings, 1), { type: 'start' }, startAt, settings);
          if (!started.ok) throw new Error('start must succeed');
          const now = startAt + dt;
          const r = m.apply(started.state, { type: 'pause' }, now, settings);
          if (now >= (m.endsAtMs(started.state) ?? 0)) {
            expect(r.ok).toBe(false);
            expect(!r.ok && r.rejection.code).toBe('INVALID_TRANSITION');
          } else {
            expect(r.ok && r.state.elapsedBeforeMs).toBeLessThan(settings.focusMs);
          }
        },
      ),
      runs,
    );
  });

  it('is deterministic', () => {
    fc.assert(
      fc.property(
        settingsArb,
        fc.integer({ min: 0, max: 1_000_000 }),
        stepArb,
        fc.integer({ min: 0, max: 1_000_000_000 }),
        (settings, base, step, now) => {
          const s = m.initial(settings, base);
          const command = toCommand(step, s.version) ?? { type: 'start' as const };
          expect(m.apply(s, command, now, settings)).toEqual(m.apply(s, command, now, settings));
          expect(m.completePhase(s, now, settings)).toEqual(m.completePhase(s, now, settings));
        },
      ),
      runs,
    );
  });

  it('no-ops are idempotent and never change the version', () => {
    fc.assert(
      fc.property(
        settingsArb,
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 0, max: 59_000 }), // before the end (focus is at least 60 s)
        (settings, startAt, dt) => {
          const started = m.apply(m.initial(settings, 5), { type: 'start' }, startAt, settings);
          if (!started.ok) throw new Error('start must succeed');
          const resumeAgain = m.apply(started.state, { type: 'resume' }, startAt + dt, settings);
          expect(resumeAgain).toEqual({ ok: true, state: started.state, changed: false });
          const p1 = m.apply(started.state, { type: 'pause' }, startAt + dt, settings);
          if (!p1.ok) throw new Error('pause must succeed');
          const p2 = m.apply(p1.state, { type: 'pause' }, startAt + dt + 99, settings);
          expect(p2).toEqual({ ok: true, state: p1.state, changed: false });
        },
      ),
      runs,
    );
  });

  it('completePhase succeeds exactly when now >= endsAt of a running timer', () => {
    fc.assert(
      fc.property(
        settingsArb,
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: -100_000, max: 100_000 }),
        (settings, startAt, offset) => {
          const started = m.apply(m.initial(settings, 1), { type: 'start' }, startAt, settings);
          if (!started.ok) throw new Error('start must succeed');
          const ends = m.endsAtMs(started.state) ?? 0;
          const r = m.completePhase(started.state, ends + offset, settings);
          expect(r.ok).toBe(offset >= 0);
          if (!r.ok && r.rejection.code === 'NOT_DUE') {
            expect(r.rejection.remainingMs).toBe(-offset);
          }
        },
      ),
      runs,
    );
  });

  it('survives a clock that goes backwards without negative elapsed or a lower version', () => {
    fc.assert(
      fc.property(
        settingsArb,
        fc.array(
          fc.record({
            now: fc.integer({ min: 0, max: 100_000_000 }),
            kind: fc.constantFrom<'start' | 'pause' | 'resume' | 'complete'>(
              'start',
              'pause',
              'resume',
              'complete',
            ),
          }),
          { maxLength: 30 },
        ),
        (settings, steps) => {
          let state = m.initial(settings, 10);
          for (const step of steps) {
            const r =
              step.kind === 'complete'
                ? m.completePhase(state, step.now, settings)
                : m.apply(state, { type: step.kind }, step.now, settings);
            if (r.ok) {
              expect(r.state.version).toBeGreaterThanOrEqual(state.version);
              state = r.state;
            }
            checkInvariants(state, step.now);
          }
        },
      ),
      runs,
    );
  });

  it('two hosts holding the same stale version can never both succeed', () => {
    const guarded = fc.constantFrom<'reset' | 'setPhase'>('reset', 'setPhase');
    fc.assert(
      fc.property(
        settingsArb,
        fc.array(fc.constantFrom<'start' | 'pause' | 'resume'>('start', 'pause', 'resume'), {
          maxLength: 6,
        }),
        guarded,
        guarded,
        phaseArb,
        phaseArb,
        (settings, prelude, kindA, kindB, phaseA, phaseB) => {
          let state = m.initial(settings, 50);
          let now = 1_000;
          for (const type of prelude) {
            now += 777;
            const r = m.apply(state, { type }, now, settings);
            if (r.ok) state = r.state;
          }
          const seen = state.version;
          const cmd = (kind: 'reset' | 'setPhase', phase: TimerPhase): TimerCommand =>
            kind === 'reset'
              ? { type: 'reset', expectedVersion: seen }
              : { type: 'setPhase', phase, expectedVersion: seen };
          // Host A is applied first; host B then runs against the state A produced.
          const a = m.apply(state, cmd(kindA, phaseA), now, settings);
          if (!a.ok || !a.changed) return; // A rejected: nothing to race against.
          const b = m.apply(a.state, cmd(kindB, phaseB), now, settings);
          expect(b.ok).toBe(false);
          expect(!b.ok && b.rejection.code).toBe('VERSION_CONFLICT');
        },
      ),
      runs,
    );
  });
});
