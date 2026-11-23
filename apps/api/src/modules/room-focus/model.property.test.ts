import type { TimerCommand, TimerPhase } from '@focus-flow/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { timerMachine as m } from '../room-timer/machine.js';
import type { TimerSettings, TimerState } from '../room-timer/types.js';
import {
  focusedSecondsBetween,
  graceRemainingMs,
  plannedSecondsAtOptIn,
  planRun,
  settlementForClosedRun,
  settlementForDeparture,
  settlementForGraceExpiry,
  settlementForReconnectAfterClose,
} from './model.js';
import { type LedgerParticipant, ROOM_GRACE_MS, type RunRecord, type Settlement } from './types.js';

const runs = { numRuns: 300 };

const settingsArb: fc.Arbitrary<TimerSettings> = fc.record({
  focusMs: fc.integer({ min: 60_000, max: 14_400_000 }),
  shortBreakMs: fc.integer({ min: 60_000, max: 3_600_000 }),
  longBreakMs: fc.integer({ min: 60_000, max: 7_200_000 }),
});
const phaseArb = fc.constantFrom<TimerPhase>('focus', 'short_break', 'long_break');

// ---- Focused seconds -------------------------------------------------------------------

describe('focusedSecondsBetween properties', () => {
  const ms = fc.integer({ min: -1_000_000, max: 100_000_000 });
  const planned = fc.integer({ min: 0, max: 14_400 });

  it('is always within [0, planned] and a whole number', () => {
    fc.assert(
      fc.property(ms, ms, planned, (a, b, p) => {
        const s = focusedSecondsBetween(a, b, p);
        expect(Number.isInteger(s)).toBe(true);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(p);
      }),
      runs,
    );
  });

  it('is monotone in the end reading and anti-monotone in the start reading', () => {
    fc.assert(
      fc.property(ms, ms, ms, planned, (a, b, c, p) => {
        const [lo, hi] = b <= c ? [b, c] : [c, b];
        expect(focusedSecondsBetween(a, lo, p)).toBeLessThanOrEqual(
          focusedSecondsBetween(a, hi, p),
        );
        expect(focusedSecondsBetween(hi, a, p)).toBeLessThanOrEqual(
          focusedSecondsBetween(lo, a, p),
        );
      }),
      runs,
    );
  });

  it('a reading at or before the start is 0', () => {
    fc.assert(
      fc.property(ms, fc.integer({ min: 0, max: 5_000_000 }), planned, (a, back, p) => {
        expect(focusedSecondsBetween(a, a - back, p)).toBe(0);
      }),
      runs,
    );
  });
});

describe('plannedSecondsAtOptIn properties', () => {
  it('ok implies the PostgreSQL bounds and matches the rounded remaining time', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20_000_000 }),
        fc.integer({ min: 0, max: 20_000_000 }),
        (duration, elapsedRaw) => {
          const elapsed = Math.min(elapsedRaw, duration);
          const r = plannedSecondsAtOptIn(duration, elapsed);
          const expected = Math.round((duration - elapsed) / 1000);
          expect(r.ok).toBe(expected >= 60 && expected <= 14_400);
          if (r.ok) expect(r.plannedSeconds).toBe(expected);
        },
      ),
      runs,
    );
  });
});

// ---- Settlements -----------------------------------------------------------------------

const participantArb: fc.Arbitrary<LedgerParticipant> = fc
  .record({
    optIn: fc.integer({ min: 0, max: 14_000_000 }),
    advance: fc.integer({ min: 0, max: 14_000_000 }),
    optedInAtMs: fc.integer({ min: 0, max: 1_000_000_000 }),
    disconnected: fc.boolean(),
    sinceOptInMs: fc.integer({ min: 0, max: 100_000_000 }),
  })
  .map((r) => ({
    userId: 'u',
    sessionId: 's',
    optedInAtMs: r.optedInAtMs,
    elapsedAtOptInMs: r.optIn,
    disconnectedAtMs: r.disconnected ? r.optedInAtMs + r.sinceOptInMs : null,
    elapsedAtDisconnectMs: r.disconnected ? r.optIn + r.advance - 5_000_000 : null,
  }));

const closedRunArb: fc.Arbitrary<RunRecord> = fc
  .record({
    closeReason: fc.constantFrom<'reset' | 'phase_changed' | 'completed'>(
      'reset',
      'phase_changed',
      'completed',
    ),
    closedAtMs: fc.integer({ min: 0, max: 2_000_000_000 }),
    elapsed: fc.integer({ min: 0, max: 14_400_000 }),
  })
  .map((r) => ({
    roomId: 'r',
    runId: 'run',
    status: 'closed' as const,
    closeReason: r.closeReason,
    openedAtMs: 0,
    closedAtMs: r.closedAtMs,
    elapsedAtCloseMs: r.elapsed,
  }));

const plannedArb = fc.integer({ min: 60, max: 14_400 });
const nowArb = fc.integer({ min: 0, max: 3_000_000_000 });

const checkBounds = (s: Settlement, planned: number): void => {
  if (s.kind === 'abandon') {
    expect(Number.isInteger(s.focusedSeconds)).toBe(true);
    expect(s.focusedSeconds).toBeGreaterThanOrEqual(0);
    expect(s.focusedSeconds).toBeLessThanOrEqual(planned);
  }
};

describe('settlement properties', () => {
  it('a closed-run settlement is always bounded, and waits only inside the grace', () => {
    fc.assert(
      fc.property(participantArb, closedRunArb, plannedArb, nowArb, (p, run, planned, now) => {
        const s = settlementForClosedRun(p, run, planned, now);
        checkBounds(s, planned);
        if (s.kind === 'wait_for_grace') {
          expect(run.closeReason).toBe('completed');
          expect(p.disconnectedAtMs).not.toBeNull();
          expect(graceRemainingMs(p, now)).toBeGreaterThan(0);
        }
        if (run.closeReason !== 'completed') {
          expect(s).toMatchObject({ kind: 'abandon', reason: run.closeReason });
        }
        if (run.closeReason === 'completed' && p.disconnectedAtMs === null) {
          expect(s.kind).toBe('complete');
        }
      }),
      runs,
    );
  });

  it('a disconnect before the opt-in elapsed never yields negative time', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1_000, max: 5_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        plannedArb,
        (optIn, behind, planned) => {
          const p: LedgerParticipant = {
            userId: 'u',
            sessionId: 's',
            optedInAtMs: 0,
            elapsedAtOptInMs: optIn,
            disconnectedAtMs: 10,
            elapsedAtDisconnectMs: optIn - behind,
          };
          expect(settlementForGraceExpiry(p, planned)).toMatchObject({ focusedSeconds: 0 });
        },
      ),
      runs,
    );
  });

  it('later departures never count less time (monotone in the elapsed reading)', () => {
    fc.assert(
      fc.property(
        participantArb,
        fc.integer({ min: 0, max: 14_400_000 }),
        fc.integer({ min: 0, max: 14_400_000 }),
        plannedArb,
        fc.constantFrom<'opted_out' | 'left_room' | 'removed'>('opted_out', 'left_room', 'removed'),
        (p, a, b, planned, reason) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          const early = settlementForDeparture(reason, p, lo, 5, planned);
          const late = settlementForDeparture(reason, p, hi, 5, planned);
          checkBounds(early, planned);
          checkBounds(late, planned);
          if (early.kind === 'abandon' && late.kind === 'abandon') {
            expect(early.focusedSeconds).toBeLessThanOrEqual(late.focusedSeconds);
          }
        },
      ),
      runs,
    );
  });

  it('a reconnect after a normal close never gives a worse outcome than a later one', () => {
    fc.assert(
      fc.property(
        participantArb.filter((p) => p.disconnectedAtMs !== null),
        closedRunArb.map((r) => ({ ...r, closeReason: 'completed' as const })),
        plannedArb,
        fc.integer({ min: 0, max: 200_000 }),
        fc.integer({ min: 0, max: 200_000 }),
        (p, run, planned, d1, d2) => {
          const base = p.disconnectedAtMs ?? 0;
          // A disconnect at or after the true end is presence through the end (G3): own property.
          fc.pre(base < (run.closedAtMs ?? 0));
          const [lo, hi] = d1 <= d2 ? [d1, d2] : [d2, d1];
          const early = settlementForReconnectAfterClose(p, run, base + lo, planned);
          const late = settlementForReconnectAfterClose(p, run, base + hi, planned);
          checkBounds(early, planned);
          checkBounds(late, planned);
          if (late.kind === 'complete') expect(early.kind).toBe('complete');
          expect(early.kind === 'complete').toBe(lo <= ROOM_GRACE_MS);
        },
      ),
      runs,
    );
  });

  it('a disconnect at or after the true end of a completed run always completes at that end (G3)', () => {
    fc.assert(
      fc.property(
        participantArb.filter((p) => p.disconnectedAtMs !== null),
        closedRunArb.map((r) => ({ ...r, closeReason: 'completed' as const })),
        plannedArb,
        nowArb,
        (p, run, planned, now) => {
          fc.pre((p.disconnectedAtMs ?? 0) >= (run.closedAtMs ?? 0));
          const expected = { kind: 'complete', endedAtMs: run.closedAtMs };
          expect(settlementForClosedRun(p, run, planned, now)).toEqual(expected);
          expect(settlementForReconnectAfterClose(p, run, now, planned)).toEqual(expected);
        },
      ),
      runs,
    );
  });

  it('graceRemainingMs stays in [0, 60 s] and never grows as time passes', () => {
    fc.assert(
      fc.property(participantArb, nowArb, nowArb, (p, a, b) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        const r1 = graceRemainingMs(p, lo);
        const r2 = graceRemainingMs(p, hi);
        for (const r of [r1, r2]) {
          expect(r).toBeGreaterThanOrEqual(0);
          expect(r).toBeLessThanOrEqual(ROOM_GRACE_MS);
        }
        expect(r2).toBeLessThanOrEqual(r1);
      }),
      runs,
    );
  });
});

// ---- planRun ---------------------------------------------------------------------------

type Step = {
  readonly dt: number;
  readonly kind: 'start' | 'pause' | 'resume' | 'reset' | 'setPhase' | 'complete';
  readonly phase: TimerPhase;
  readonly settings: TimerSettings;
};

const stepArb: fc.Arbitrary<Step> = fc.record({
  dt: fc.oneof(fc.integer({ min: 0, max: 5_000 }), fc.integer({ min: 0, max: 20_000_000 })),
  kind: fc.constantFrom('start', 'pause', 'resume', 'reset', 'setPhase', 'complete'),
  phase: phaseArb,
  settings: settingsArb,
});

describe('planRun properties', () => {
  it('over random sequences: at most one close and one open, state matches, ids never reused', () => {
    fc.assert(
      fc.property(
        settingsArb,
        fc.integer({ min: 0, max: 2_000_000_000 }),
        fc.array(stepArb, { maxLength: 50 }),
        (initialSettings, t0, steps) => {
          let counter = 0;
          const newId = (): string => `run-${String(++counter)}`;
          const used = new Set<string>();
          const open = new Set<string>();

          const created = planRun(
            undefined,
            m.initial(initialSettings, 1),
            'created',
            undefined,
            t0,
            newId(),
          );
          let state: TimerState = created.state;
          if (created.runs?.open) {
            used.add(created.runs.open.runId);
            open.add(created.runs.open.runId);
          }
          let now = t0;

          for (const step of steps) {
            now += step.dt;
            const before = state;
            let command: TimerCommand | undefined;
            let result;
            if (step.kind === 'complete') {
              result = m.completePhase(before, now, step.settings);
            } else {
              const chosen: TimerCommand =
                step.kind === 'reset' || step.kind === 'setPhase'
                  ? step.kind === 'reset'
                    ? { type: 'reset', expectedVersion: before.version }
                    : { type: 'setPhase', phase: step.phase, expectedVersion: before.version }
                  : { type: step.kind };
              command = chosen;
              result = m.apply(before, chosen, now, step.settings);
            }
            if (!result.ok || !result.changed) continue;

            const id = newId();
            const plan = planRun(
              before,
              result.state,
              step.kind === 'complete' ? 'phase_end' : 'command',
              command,
              now,
              id,
            );
            state = plan.state;

            // Everything except the run id is the machine's result.
            expect({ ...plan.state, focusRunId: null }).toEqual({
              ...result.state,
              focusRunId: null,
            });

            const closes = plan.runs?.close;
            const opens = plan.runs?.open;
            if (closes) {
              // Exactly the previous run, of a focus phase, once.
              expect(before.phase).toBe('focus');
              expect(closes.runId).toBe(before.focusRunId);
              expect(open.has(closes.runId)).toBe(true);
              open.delete(closes.runId);
              expect(closes.elapsedAtCloseMs).toBeGreaterThanOrEqual(0);
              expect(closes.elapsedAtCloseMs).toBeLessThanOrEqual(before.durationMs);
              const endsAt = m.endsAtMs(before);
              const over = endsAt !== null && now >= endsAt;
              // A completed run closes at the TRUE end, any other close at the instant of the change.
              expect(closes.closedAtMs).toBe(
                (step.kind === 'complete' || over) && endsAt !== null ? Math.min(now, endsAt) : now,
              );
              if (step.kind === 'complete' || over) {
                // A phase that is already over completes whoever closes it (D35, Rev J3).
                expect(closes.reason).toBe('completed');
                expect(closes.elapsedAtCloseMs).toBe(before.durationMs);
              } else {
                expect(closes.reason).not.toBe('completed');
              }
            }
            if (opens) {
              expect(opens.runId).toBe(id);
              expect(used.has(opens.runId)).toBe(false); // never reused
              used.add(opens.runId);
              open.add(opens.runId);
              expect(plan.state.phase).toBe('focus');
              expect(plan.state.focusRunId).toBe(opens.runId);
            }
            // A focus phase always has exactly its one open run; a break has none.
            if (plan.state.phase === 'focus') {
              expect(plan.state.focusRunId).not.toBeNull();
              expect(open.has(plan.state.focusRunId ?? '')).toBe(true);
            } else {
              expect(plan.state.focusRunId).toBeNull();
            }
            expect(open.size).toBe(plan.state.phase === 'focus' ? 1 : 0);

            // start / pause / resume never touch runs.
            if (
              command !== undefined &&
              (command.type === 'start' || command.type === 'pause' || command.type === 'resume')
            ) {
              expect(plan.runs).toBeUndefined();
              expect(plan.state.focusRunId).toBe(before.focusRunId);
            }
          }
        },
      ),
      runs,
    );
  });
});
