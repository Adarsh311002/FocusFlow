import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  CLOCK_SKEW_TOLERANCE_MS,
  decideRunningSession,
  type DecisionInput,
  type DisconnectMarker,
  SOLO_GRACE_MS,
} from './decision.js';
import { plannedEndMs, type RunningSession, startSession } from './timing.js';

// Every row of the protocol's two decision tables, plus the rules that must hold for any
// input (docs/architecture/focus-timing-protocol.md, "The decision for a running session").

const T0 = 1_791_000_000_000;
const SESSION_ID = 'session-1';
const session: RunningSession = startSession(1_500, T0);
const T_END = plannedEndMs(session); // T0 + 25 min
const BEFORE_END = T_END - 5 * 60_000;
const AFTER_END = T_END + 5 * 60_000;
const EPOCH_OLD = T0 - 86_400_000;

const marker = (
  disconnectedAtMs: number,
  evidence: DisconnectMarker['evidence'] = 'observed',
  sessionId = SESSION_ID,
): DisconnectMarker => ({ sessionId, disconnectedAtMs, evidence });

const decide = (overrides: Partial<DecisionInput>) =>
  decideRunningSession({
    sessionId: SESSION_ID,
    session,
    nowMs: BEFORE_END,
    marker: null,
    presence: { online: true, checkedAtMs: BEFORE_END },
    epochCreatedAtMs: EPOCH_OLD,
    ...overrides,
  });

describe('presence unknown', () => {
  it('decides nothing, before or after the planned end (H2)', () => {
    for (const nowMs of [BEFORE_END, AFTER_END]) {
      expect(decide({ nowMs, presence: undefined }).decision).toEqual({
        kind: 'retry',
        reason: 'presence_unknown',
      });
    }
  });
});

describe('before T_end', () => {
  it('online: keeps running, clearing this session’s marker up to the check', () => {
    expect(decide({}).decision).toEqual({ kind: 'continue', clearMarkerUpToMs: null });
    expect(decide({ marker: marker(BEFORE_END - 10_000) }).decision).toEqual({
      kind: 'continue',
      clearMarkerUpToMs: BEFORE_END,
    });
  });

  it('online after the marker’s grace ran out: only its grace job continues it (E16)', () => {
    const disconnectedAtMs = BEFORE_END - SOLO_GRACE_MS;
    // Any other caller hands over to the grace job.
    expect(decide({ marker: marker(disconnectedAtMs, 'detected') }).decision).toEqual({
      kind: 'wait_for_grace',
      disconnectedAtMs,
    });
    // The late grace job of exactly this disconnect treats it as a reconnect within grace.
    expect(
      decide({ marker: marker(disconnectedAtMs, 'detected'), graceJob: { disconnectedAtMs } })
        .decision,
    ).toEqual({ kind: 'continue', clearMarkerUpToMs: BEFORE_END });
  });

  it('offline with a marker: waits for the grace, then expires it', () => {
    const disconnectedAtMs = BEFORE_END - 30_000;
    expect(
      decide({
        marker: marker(disconnectedAtMs),
        presence: { online: false, checkedAtMs: BEFORE_END },
      }).decision,
    ).toEqual({ kind: 'wait_for_grace', disconnectedAtMs });
    expect(
      decide({
        marker: marker(disconnectedAtMs),
        presence: { online: false, checkedAtMs: disconnectedAtMs + SOLO_GRACE_MS },
      }).decision,
    ).toEqual({ kind: 'grace_expired', disconnectedAtMs });
  });

  it('offline without a marker: late grace, or expired only on a definite Redis loss', () => {
    const offline = { online: false, checkedAtMs: BEFORE_END };
    expect(decide({ presence: offline }).decision).toEqual({
      kind: 'late_grace',
      detectedAtMs: BEFORE_END,
    });
    expect(
      decide({ presence: offline, epochCreatedAtMs: T0 + CLOCK_SKEW_TOLERANCE_MS + 1 }).decision,
    ).toEqual({ kind: 'expired' });
    // Within the tolerance it is ambiguous: grace, never expiry (E9).
    expect(
      decide({ presence: offline, epochCreatedAtMs: T0 + CLOCK_SKEW_TOLERANCE_MS }).decision.kind,
    ).toBe('late_grace');
    expect(decide({ presence: offline, epochCreatedAtMs: undefined }).decision).toEqual({
      kind: 'retry',
      reason: 'epoch_unknown',
    });
  });

  it('never completes before the planned end, even with a through-the-end disconnect', () => {
    expect(
      decide({
        nowMs: T_END - 1,
        marker: marker(T_END - 1_000),
        presence: { online: false, checkedAtMs: T_END - 1 },
      }).decision.kind,
    ).toBe('wait_for_grace');
  });
});

describe('at or after T_end', () => {
  it('an observed disconnect through the end (within tolerance) completes, online or not (E8)', () => {
    for (const disconnectedAtMs of [T_END, T_END - CLOCK_SKEW_TOLERANCE_MS, AFTER_END - 1_000]) {
      expect(
        decide({
          nowMs: AFTER_END,
          marker: marker(disconnectedAtMs),
          presence: { online: false, checkedAtMs: AFTER_END },
        }).decision,
      ).toEqual({ kind: 'complete' });
    }
  });

  it('a detected disconnect never proves presence through the end (E10)', () => {
    // Detected at T_end + 60 s, checked 30 s later: still inside its grace, not complete.
    const decision = decide({
      nowMs: T_END + 90_000,
      marker: marker(T_END + 60_000, 'detected'),
      presence: { online: false, checkedAtMs: T_END + 90_000 },
    }).decision;
    expect(decision).toEqual({ kind: 'wait_for_grace', disconnectedAtMs: T_END + 60_000 });
  });

  it('an observed disconnect before the end (beyond tolerance) does not prove it', () => {
    const disconnectedAtMs = T_END - CLOCK_SKEW_TOLERANCE_MS - 1;
    expect(
      decide({
        nowMs: AFTER_END,
        marker: marker(disconnectedAtMs),
        presence: { online: false, checkedAtMs: AFTER_END },
      }).decision,
    ).toEqual({ kind: 'grace_expired', disconnectedAtMs });
  });

  it('online with no marker completes (D35), with the epoch known and no loss', () => {
    const online = { nowMs: T_END, presence: { online: true, checkedAtMs: T_END } };
    expect(decide(online).decision).toEqual({ kind: 'complete' });
    // Within the tolerance it is ambiguous: no loss (E9).
    expect(decide({ ...online, epochCreatedAtMs: T0 + CLOCK_SKEW_TOLERANCE_MS }).decision).toEqual({
      kind: 'complete',
    });
    expect(decide({ ...online, epochCreatedAtMs: undefined }).decision).toEqual({
      kind: 'retry',
      reason: 'epoch_unknown',
    });
  });

  it('online with no marker after a definite Redis loss during the stretch: expired (E9)', () => {
    expect(
      decide({
        nowMs: AFTER_END,
        presence: { online: true, checkedAtMs: AFTER_END },
        epochCreatedAtMs: T0 + CLOCK_SKEW_TOLERANCE_MS + 1,
      }).decision,
    ).toEqual({ kind: 'expired' });
  });

  it('online with a recorded disconnect: the end job, reconciler or a request hands over to its grace job', () => {
    const online = { nowMs: AFTER_END, presence: { online: true, checkedAtMs: AFTER_END } };
    for (const recorded of [
      marker(T_END - 10 * 60_000, 'detected'),
      marker(T_END - 10 * 60_000, 'observed'),
      marker(T_END + 60_000, 'detected'),
      // Still inside its grace.
      marker(AFTER_END - 1_000, 'detected'),
    ]) {
      expect(decide({ ...online, marker: recorded }).decision).toEqual({
        kind: 'wait_for_grace',
        disconnectedAtMs: recorded.disconnectedAtMs,
      });
    }
  });

  it('E16: the late grace job of exactly this disconnect, online, completes at T_end', () => {
    const disconnectedAtMs = T_END - 10 * 60_000;
    const online = {
      nowMs: AFTER_END,
      marker: marker(disconnectedAtMs, 'detected'),
      presence: { online: true, checkedAtMs: AFTER_END },
    };
    expect(decide({ ...online, graceJob: { disconnectedAtMs } }).decision).toEqual({
      kind: 'complete',
    });
    // A grace job about another disconnect is not E16.
    expect(
      decide({ ...online, graceJob: { disconnectedAtMs: disconnectedAtMs - 1 } }).decision,
    ).toEqual({ kind: 'wait_for_grace', disconnectedAtMs });
    // E16 is no evidence about a Redis loss during the stretch (E9).
    expect(
      decide({
        ...online,
        graceJob: { disconnectedAtMs },
        epochCreatedAtMs: T0 + CLOCK_SKEW_TOLERANCE_MS + 1,
      }).decision,
    ).toEqual({ kind: 'expired' });
    expect(
      decide({ ...online, graceJob: { disconnectedAtMs }, epochCreatedAtMs: undefined }).decision,
    ).toEqual({ kind: 'retry', reason: 'epoch_unknown' });
  });

  it('an observed disconnect through the end completes even after a Redis loss (E8)', () => {
    expect(
      decide({
        nowMs: AFTER_END,
        marker: marker(T_END + 1_000),
        presence: { online: true, checkedAtMs: AFTER_END },
        epochCreatedAtMs: T_END,
      }).decision,
    ).toEqual({ kind: 'complete' });
  });

  it('offline with a marker before the end: waits, then expires the grace', () => {
    const disconnectedAtMs = T_END - 30_000;
    expect(
      decide({
        nowMs: T_END,
        marker: marker(disconnectedAtMs),
        presence: { online: false, checkedAtMs: T_END },
      }).decision,
    ).toEqual({ kind: 'wait_for_grace', disconnectedAtMs });
    expect(
      decide({
        nowMs: AFTER_END,
        marker: marker(disconnectedAtMs),
        presence: { online: false, checkedAtMs: AFTER_END },
      }).decision,
    ).toEqual({ kind: 'grace_expired', disconnectedAtMs });
  });

  it('offline with no marker: late grace (never completion), or expired on a definite loss', () => {
    const offline = { online: false, checkedAtMs: AFTER_END };
    expect(decide({ nowMs: AFTER_END, presence: offline }).decision).toEqual({
      kind: 'late_grace',
      detectedAtMs: AFTER_END,
    });
    expect(
      decide({ nowMs: AFTER_END, presence: offline, epochCreatedAtMs: T_END }).decision,
    ).toEqual({ kind: 'expired' });
  });
});

describe('markers that do not count', () => {
  it('ignores another session’s marker', () => {
    expect(
      decide({
        nowMs: AFTER_END,
        marker: marker(AFTER_END - 1_000, 'observed', 'other-session'),
        presence: { online: false, checkedAtMs: AFTER_END },
      }),
    ).toEqual({
      decision: { kind: 'late_grace', detectedAtMs: AFTER_END },
      clearStaleMarker: false,
    });
  });

  it('treats this session’s marker from before the current stretch as absent and stale (E10)', () => {
    expect(
      decide({
        marker: marker(T0 - CLOCK_SKEW_TOLERANCE_MS - 1),
        presence: { online: false, checkedAtMs: BEFORE_END },
      }),
    ).toEqual({
      decision: { kind: 'late_grace', detectedAtMs: BEFORE_END },
      clearStaleMarker: true,
    });
    // Within the tolerance it still belongs to the stretch.
    expect(
      decide({
        marker: marker(T0 - CLOCK_SKEW_TOLERANCE_MS),
        presence: { online: false, checkedAtMs: BEFORE_END },
      }).clearStaleMarker,
    ).toBe(false);
  });
});

describe('properties', () => {
  const inputArb = fc.record({
    nowOffsetMs: fc.integer({ min: 0, max: 3 * 3_600_000 }),
    online: fc.option(fc.boolean(), { nil: undefined }),
    checkedOffsetMs: fc.integer({ min: -5_000, max: 5_000 }),
    marker: fc.option(
      fc.record({
        offsetMs: fc.integer({ min: -3_600_000, max: 3 * 3_600_000 }),
        evidence: fc.constantFrom<DisconnectMarker['evidence']>('observed', 'detected'),
        own: fc.boolean(),
      }),
      { nil: null },
    ),
    epochOffsetMs: fc.option(fc.integer({ min: -86_400_000, max: 3 * 3_600_000 }), {
      nil: undefined,
    }),
  });

  it('never completes before the planned end, and never on an unknown presence', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const nowMs = T0 + input.nowOffsetMs;
        const { decision } = decideRunningSession({
          sessionId: SESSION_ID,
          session,
          nowMs,
          marker:
            input.marker === null
              ? null
              : marker(
                  T0 + input.marker.offsetMs,
                  input.marker.evidence,
                  input.marker.own ? SESSION_ID : 'other',
                ),
          presence:
            input.online === undefined
              ? undefined
              : { online: input.online, checkedAtMs: nowMs + input.checkedOffsetMs },
          epochCreatedAtMs:
            input.epochOffsetMs === undefined ? undefined : T0 + input.epochOffsetMs,
        });
        if (decision.kind === 'complete') {
          expect(nowMs).toBeGreaterThanOrEqual(T_END);
          expect(input.online).not.toBeUndefined();
        }
        if (input.online === undefined) {
          expect(decision).toEqual({ kind: 'retry', reason: 'presence_unknown' });
        }
      }),
    );
  });

  it('completes exactly on the approved evidence (E8, E9, E16, D35)', () => {
    const arb = fc.record({
      input: inputArb,
      graceJob: fc.constantFrom('none', 'exact', 'other'),
    });
    fc.assert(
      fc.property(arb, ({ input, graceJob }) => {
        const nowMs = T0 + input.nowOffsetMs;
        const recorded =
          input.marker === null
            ? null
            : marker(
                T0 + input.marker.offsetMs,
                input.marker.evidence,
                input.marker.own ? SESSION_ID : 'other',
              );
        const epochCreatedAtMs =
          input.epochOffsetMs === undefined ? undefined : T0 + input.epochOffsetMs;
        const { decision } = decideRunningSession({
          sessionId: SESSION_ID,
          session,
          nowMs,
          marker: recorded,
          presence:
            input.online === undefined
              ? undefined
              : { online: input.online, checkedAtMs: nowMs + input.checkedOffsetMs },
          epochCreatedAtMs,
          ...(graceJob === 'none' || recorded === null
            ? {}
            : {
                graceJob: {
                  disconnectedAtMs: recorded.disconnectedAtMs + (graceJob === 'exact' ? 0 : 1),
                },
              }),
        });

        // The marker that counts: this session's, not from before the stretch.
        const own =
          recorded !== null &&
          recorded.sessionId === SESSION_ID &&
          recorded.disconnectedAtMs + CLOCK_SKEW_TOLERANCE_MS >= T0
            ? recorded
            : null;
        const pastEnd = nowMs >= T_END;
        const throughTheEnd =
          own !== null &&
          own.evidence === 'observed' &&
          own.disconnectedAtMs + CLOCK_SKEW_TOLERANCE_MS >= T_END;
        const lateGraceReconnect = own !== null && graceJob === 'exact';
        const noLoss =
          epochCreatedAtMs !== undefined && epochCreatedAtMs <= T0 + CLOCK_SKEW_TOLERANCE_MS;
        const expected =
          input.online !== undefined &&
          pastEnd &&
          (throughTheEnd || (input.online && (own === null || lateGraceReconnect) && noLoss));
        expect(decision.kind === 'complete').toBe(expected);
      }),
      { numRuns: 2_000 },
    );
  });

  it('a definite Redis loss during the stretch never completes without E8 evidence', () => {
    fc.assert(
      fc.property(
        inputArb,
        fc.integer({ min: CLOCK_SKEW_TOLERANCE_MS + 1, max: 3 * 3_600_000 }),
        (input, lossOffsetMs) => {
          const nowMs = T0 + input.nowOffsetMs;
          const { decision } = decideRunningSession({
            sessionId: SESSION_ID,
            session,
            nowMs,
            marker:
              input.marker === null
                ? null
                : marker(T0 + input.marker.offsetMs, 'detected', SESSION_ID),
            presence: { online: input.online ?? true, checkedAtMs: nowMs },
            epochCreatedAtMs: T0 + lossOffsetMs,
            ...(input.marker === null
              ? {}
              : { graceJob: { disconnectedAtMs: T0 + input.marker.offsetMs } }),
          });
          expect(decision.kind).not.toBe('complete');
        },
      ),
    );
  });

  it('offline with only detected evidence never completes (E8, E10)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 3 * 3_600_000 }),
        fc.integer({ min: -3_600_000, max: 3 * 3_600_000 }),
        (nowOffsetMs, markerOffsetMs) => {
          const nowMs = T0 + nowOffsetMs;
          const { decision } = decideRunningSession({
            sessionId: SESSION_ID,
            session,
            nowMs,
            marker: marker(T0 + markerOffsetMs, 'detected'),
            presence: { online: false, checkedAtMs: nowMs },
            epochCreatedAtMs: EPOCH_OLD,
          });
          expect(decision.kind).not.toBe('complete');
        },
      ),
    );
  });

  it('never expires on an ambiguous epoch comparison (E9)', () => {
    fc.assert(
      fc.property(fc.integer({ min: -86_400_000, max: CLOCK_SKEW_TOLERANCE_MS }), (offset) => {
        const { decision } = decideRunningSession({
          sessionId: SESSION_ID,
          session,
          nowMs: BEFORE_END,
          marker: null,
          presence: { online: false, checkedAtMs: BEFORE_END },
          epochCreatedAtMs: T0 + offset,
        });
        expect(decision.kind).toBe('late_grace');
      }),
    );
  });
});
