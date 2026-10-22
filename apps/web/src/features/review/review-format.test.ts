import { focusSessionViewSchema } from '@focus-flow/contracts';
import { describe, expect, it } from 'vitest';

import { fakeSession } from '../../test/fake-focus-session-api';
import {
  formatDateTime,
  formatDayLabel,
  formatDuration,
  sessionStatusLabel,
} from './review-format';

describe('formatDuration', () => {
  it.each([
    [0, '0 min'],
    [1, '1 s'],
    [59, '59 s'],
    [60, '1 min'],
    [1_499, '24 min'],
    [1_500, '25 min'],
    [3_600, '1 h'],
    [3_659, '1 h'],
    [5_100, '1 h 25 min'],
    [14_400, '4 h'],
  ])('%i seconds → %s (rounded down)', (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });
});

describe('formatDayLabel', () => {
  it('formats a calendar date without shifting it to a neighbouring day', () => {
    expect(formatDayLabel('2026-03-08', 'en-US')).toBe('Sun, Mar 8');
    expect(formatDayLabel('2026-10-25', 'en-US')).toBe('Sun, Oct 25');
    expect(formatDayLabel('2026-01-01', 'en-US')).toBe('Thu, Jan 1');
  });
});

describe('formatDateTime', () => {
  it('shows the instant in the review time zone', () => {
    const iso = '2026-03-09T05:00:00.000Z';
    const la = formatDateTime(iso, 'America/Los_Angeles', 'en-US');
    expect(la).toContain('Mar 8, 2026');
    expect(la).toContain('10:00');
    const kiritimati = formatDateTime(iso, 'Pacific/Kiritimati', 'en-US');
    expect(kiritimati).toContain('Mar 9, 2026');
    expect(kiritimati).toContain('7:00');
  });
});

describe('sessionStatusLabel', () => {
  const view = (overrides: Parameters<typeof fakeSession>[0]) =>
    focusSessionViewSchema.parse(fakeSession(overrides));

  it.each([
    [{}, 'Completed'],
    [
      { status: 'abandoned', endedAt: '2026-03-09T10:10:00.000Z', abandonReason: 'stopped' },
      'Stopped early',
    ],
    [
      { status: 'abandoned', endedAt: '2026-03-09T10:10:00.000Z', abandonReason: 'grace_expired' },
      'Disconnected',
    ],
    [
      { status: 'abandoned', endedAt: '2026-03-09T22:00:00.000Z', abandonReason: 'expired' },
      'Expired',
    ],
    [{ status: 'in_progress', runningSince: '2026-03-09T10:00:00.000Z' }, 'In progress'],
    [{ status: 'in_progress', runningSince: null }, 'Paused'],
  ] as const)('%o → %s', (overrides, expected) => {
    expect(sessionStatusLabel(view(overrides))).toBe(expected);
  });
});
