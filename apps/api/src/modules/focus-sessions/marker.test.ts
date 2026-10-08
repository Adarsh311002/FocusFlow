import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { CLOCK_SKEW_TOLERANCE_MS, type DisconnectMarker } from './decision.js';
import {
  formatMarker,
  parseMarker,
  planMarkerClear,
  planMarkerRecord,
  type RecordPlan,
} from './marker.js';

// The E10 marker rules, one by one, and the properties that make concurrent and repeated
// recording safe (docs/architecture/focus-timing-protocol.md, "Disconnect marker").

const S1 = '01a0ed0d-55de-7d1b-8495-82fb5050d815';
const S2 = '01a0ed0d-55de-7d1b-8495-82fb5050d816';
const R = 1_791_000_000_000; // running_since of the current stretch
const T = R + 60_000;

const marker = (
  disconnectedAtMs: number,
  evidence: DisconnectMarker['evidence'] = 'observed',
  sessionId = S1,
): DisconnectMarker => ({ sessionId, disconnectedAtMs, evidence });

describe('value format', () => {
  it('round-trips {sessionId}:{latestDisconnectedAtMs}:{evidence}', () => {
    const value = marker(T, 'detected');
    expect(formatMarker(value)).toBe(`${S1}:${String(T)}:detected`);
    expect(parseMarker(formatMarker(value))).toEqual(value);
  });

  it.each([
    '',
    `${S1}:${String(T)}`,
    `${S1}:${String(T)}:seen`,
    `not-a-uuid:${String(T)}:observed`,
    `${S1}:-5:observed`,
    `${S1}:12.5:observed`,
    `${S1}:${String(T)}:observed:extra`,
  ])('treats the malformed value %j as absent', (raw) => {
    expect(parseMarker(raw)).toBeUndefined();
  });
});

describe('planMarkerRecord (E10)', () => {
  it('sets a marker when there is none', () => {
    expect(planMarkerRecord(undefined, marker(T), R)).toEqual({
      action: 'write',
      marker: marker(T),
      kind: 'created',
    });
  });

  it('replaces another session’s marker, whatever its time', () => {
    expect(planMarkerRecord(marker(T + 1_000, 'observed', S2), marker(T, 'detected'), R)).toEqual({
      action: 'write',
      marker: marker(T, 'detected'),
      kind: 'replaced_other_session',
    });
  });

  it('same session, older incoming: no change', () => {
    expect(planMarkerRecord(marker(T), marker(T - 1, 'observed'), R)).toEqual({
      action: 'keep',
      reason: 'not_newer',
    });
  });

  it('same session, newer incoming: replaces, with the incoming evidence', () => {
    expect(planMarkerRecord(marker(T, 'observed'), marker(T + 1, 'detected'), R)).toEqual({
      action: 'write',
      marker: marker(T + 1, 'detected'),
      kind: 'replaced_older',
    });
  });

  it('equal timestamp: detected upgrades to observed, never the reverse', () => {
    expect(planMarkerRecord(marker(T, 'detected'), marker(T, 'observed'), R)).toEqual({
      action: 'write',
      marker: marker(T, 'observed'),
      kind: 'upgraded',
    });
    expect(planMarkerRecord(marker(T, 'observed'), marker(T, 'detected'), R).action).toBe('keep');
    expect(planMarkerRecord(marker(T, 'observed'), marker(T, 'observed'), R).action).toBe('keep');
    expect(planMarkerRecord(marker(T, 'detected'), marker(T, 'detected'), R).action).toBe('keep');
  });

  it('ignores an event from before the current running stretch (2 s tolerance)', () => {
    expect(planMarkerRecord(undefined, marker(R - CLOCK_SKEW_TOLERANCE_MS - 1), R)).toEqual({
      action: 'keep',
      reason: 'predates_stretch',
    });
    expect(planMarkerRecord(undefined, marker(R - CLOCK_SKEW_TOLERANCE_MS), R).action).toBe(
      'write',
    );
  });
});

describe('planMarkerClear (always ownership-checked)', () => {
  it('upTo: deletes this session’s disconnect at or before the confirmation, keeps a later one', () => {
    expect(planMarkerClear(marker(T), { kind: 'upTo', sessionId: S1, upToMs: T })).toBe(true);
    expect(planMarkerClear(marker(T + 1), { kind: 'upTo', sessionId: S1, upToMs: T })).toBe(false);
  });

  it('session: deletes this session’s marker only', () => {
    expect(planMarkerClear(marker(T), { kind: 'session', sessionId: S1 })).toBe(true);
    expect(planMarkerClear(marker(T, 'observed', S2), { kind: 'session', sessionId: S1 })).toBe(
      false,
    );
  });

  it('stale: deletes this session’s marker only if it predates the stretch', () => {
    const rule = { kind: 'stale', sessionId: S1, runningSinceMs: R } as const;
    expect(planMarkerClear(marker(R - CLOCK_SKEW_TOLERANCE_MS - 1), rule)).toBe(true);
    expect(planMarkerClear(marker(R - CLOCK_SKEW_TOLERANCE_MS), rule)).toBe(false);
  });

  it('never deletes another session’s, a malformed or a missing marker', () => {
    for (const rule of [
      { kind: 'upTo', sessionId: S1, upToMs: Number.MAX_SAFE_INTEGER },
      { kind: 'session', sessionId: S1 },
      { kind: 'stale', sessionId: S1, runningSinceMs: Number.MAX_SAFE_INTEGER },
    ] as const) {
      expect(planMarkerClear(marker(T, 'observed', S2), rule)).toBe(false);
      expect(planMarkerClear(undefined, rule)).toBe(false);
    }
  });
});

describe('properties', () => {
  const eventArb = fc.record({
    offsetMs: fc.integer({ min: -5_000, max: 3_600_000 }),
    evidence: fc.constantFrom<DisconnectMarker['evidence']>('observed', 'detected'),
  });

  /** Applies a sequence of record requests for one session, as the store does. */
  const replay = (
    events: readonly { offsetMs: number; evidence: DisconnectMarker['evidence'] }[],
  ) => {
    let stored: DisconnectMarker | undefined;
    for (const event of events) {
      const plan: RecordPlan = planMarkerRecord(
        stored,
        marker(R + event.offsetMs, event.evidence),
        R,
      );
      if (plan.action === 'write') {
        stored = plan.marker;
      }
    }
    return stored;
  };

  it('the stored timestamp is the latest accepted event, whatever the order', () => {
    fc.assert(
      fc.property(fc.array(eventArb, { minLength: 1, maxLength: 20 }), (events) => {
        const accepted = events.filter((event) => event.offsetMs + CLOCK_SKEW_TOLERANCE_MS >= 0);
        const stored = replay(events);
        if (accepted.length === 0) {
          expect(stored).toBeUndefined();
          return;
        }
        const latest = Math.max(...accepted.map((event) => event.offsetMs));
        expect(stored?.disconnectedAtMs).toBe(R + latest);
        // At the latest timestamp, observed wins if any event there was observed.
        const atLatest = accepted.filter((event) => event.offsetMs === latest);
        const expected = atLatest.some((event) => event.evidence === 'observed')
          ? 'observed'
          : 'detected';
        expect(stored?.evidence).toBe(expected);
      }),
    );
  });

  it('the result does not depend on the order the events arrive in', () => {
    fc.assert(
      fc.property(
        fc.array(eventArb, { minLength: 1, maxLength: 12 }),
        fc.func(fc.integer()),
        (events, key) => {
          const shuffled = [...events].sort((a, b) => key(a) - key(b));
          expect(replay(shuffled)).toEqual(replay(events));
        },
      ),
    );
  });

  it('recording the same event twice is the same as once (idempotent)', () => {
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 12 }), (events) => {
        const doubled = events.flatMap((event) => [event, event]);
        expect(replay(doubled)).toEqual(replay(events));
      }),
    );
  });

  it('a stored observed marker is never downgraded to detected at the same time', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 3_600_000 }), (offset) => {
        const stored = marker(R + offset, 'observed');
        expect(planMarkerRecord(stored, marker(R + offset, 'detected'), R).action).toBe('keep');
      }),
    );
  });
});
