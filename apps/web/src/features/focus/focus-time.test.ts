import type { FocusSessionId } from '@focus-flow/contracts';
import { describe, expect, it } from 'vitest';

import {
  focusedSecondsAt,
  formatClock,
  parseDurationMinutes,
  remainingSecondsAt,
  wholeMinutes,
} from './focus-time';

const START = '2026-01-01T10:00:00.000Z';
const startMs = Date.parse(START);

function session(overrides: { focusedSeconds?: number; runningSince?: string | null }) {
  return {
    id: '0190a000-0000-7000-8000-000000000001' as FocusSessionId,
    context: { kind: 'solo' as const },
    task: null,
    plannedSeconds: 1500,
    focusedSeconds: overrides.focusedSeconds ?? 0,
    startedAt: START,
    status: 'in_progress' as const,
    runningSince: overrides.runningSince === undefined ? START : overrides.runningSince,
  };
}

describe('focusedSecondsAt', () => {
  it('adds the running stretch to the accumulated time (D6)', () => {
    expect(focusedSecondsAt(session({ focusedSeconds: 100 }), startMs + 30_900)).toBe(130);
  });
  it('does not advance while paused', () => {
    expect(
      focusedSecondsAt(session({ focusedSeconds: 100, runningSince: null }), startMs + 99_000),
    ).toBe(100);
  });
  it('clamps for display to [0, planned]', () => {
    expect(focusedSecondsAt(session({}), startMs - 5000)).toBe(0);
    expect(focusedSecondsAt(session({}), startMs + 9_999_000)).toBe(1500);
  });
  it('reports remaining time', () => {
    expect(remainingSecondsAt(session({}), startMs + 60_000)).toBe(1440);
    expect(remainingSecondsAt(session({}), startMs + 9_999_000)).toBe(0);
  });
});

describe('formatClock', () => {
  it.each([
    [0, '00:00'],
    [59, '00:59'],
    [1500, '25:00'],
    [3599, '59:59'],
    [3600, '1:00:00'],
    [14_400, '4:00:00'],
    [-5, '00:00'],
  ])('%s -> %s', (seconds, text) => {
    expect(formatClock(seconds)).toBe(text);
  });
});

describe('wholeMinutes', () => {
  it('rounds down', () => {
    expect(wholeMinutes(119)).toBe(1);
    expect(wholeMinutes(0)).toBe(0);
  });
});

describe('parseDurationMinutes', () => {
  it('accepts 1 to 240 minutes', () => {
    expect(parseDurationMinutes('1')).toEqual({ ok: true, plannedSeconds: 60 });
    expect(parseDurationMinutes(' 240 ')).toEqual({ ok: true, plannedSeconds: 14_400 });
  });
  it.each(['', '0', '241', '-5', '1.5', 'abc', '25m', '10000'])('rejects %j', (text) => {
    expect(parseDurationMinutes(text).ok).toBe(false);
  });
});
