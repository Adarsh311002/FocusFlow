import { calendarDatesFrom } from '@focus-flow/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { currentReviewRange, FALLBACK_TIME_ZONE, lastNDays, resolveTimeZone } from './review-range';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('lastNDays', () => {
  // 05:00 UTC on 9 March 2026: still the evening of 8 March in Los Angeles (PDT, the
  // day after the DST change) but already the evening of 9 March on Kiritimati (UTC+14).
  const instant = Date.parse('2026-03-09T05:00:00.000Z');

  it('ends today in the given zone, not in UTC or the machine zone', () => {
    expect(lastNDays(7, instant, 'America/Los_Angeles')).toEqual({
      from: '2026-03-02',
      to: '2026-03-08',
      tz: 'America/Los_Angeles',
    });
    expect(lastNDays(7, instant, 'Pacific/Kiritimati')).toEqual({
      from: '2026-03-03',
      to: '2026-03-09',
      tz: 'Pacific/Kiritimati',
    });
    expect(lastNDays(7, instant, 'UTC').to).toBe('2026-03-09');
  });

  it('always covers exactly N calendar days, across a DST change', () => {
    const range = lastNDays(7, instant, 'America/Los_Angeles');
    // 2026-03-08 is the US spring-forward day; the range still holds seven dates.
    expect(calendarDatesFrom(range.from, range.to)).toHaveLength(7);

    // The night the clocks go back in Berlin (25 October 2026, 25 hours long).
    const autumn = lastNDays(7, Date.parse('2026-10-25T22:30:00.000Z'), 'Europe/Berlin');
    expect(autumn).toEqual({ from: '2026-10-19', to: '2026-10-25', tz: 'Europe/Berlin' });
  });

  it('a one-day range starts and ends on the same date', () => {
    const range = lastNDays(1, instant, 'UTC');
    expect(range.from).toBe(range.to);
  });
});

describe('resolveTimeZone', () => {
  it('keeps an IANA zone name', () => {
    expect(resolveTimeZone('Europe/Berlin')).toEqual({
      timeZone: 'Europe/Berlin',
      fellBack: false,
    });
    expect(resolveTimeZone('UTC')).toEqual({ timeZone: 'UTC', fellBack: false });
  });

  it.each([undefined, '', 'EST5EDT', 'PST', '+05:30', 'Not/AZone'])(
    'falls back to UTC for %s',
    (candidate) => {
      expect(resolveTimeZone(candidate)).toEqual({
        timeZone: FALLBACK_TIME_ZONE,
        fellBack: true,
      });
    },
  );
});

describe('currentReviewRange', () => {
  it('uses the browser zone and reports a fallback when it is unusable', () => {
    const real = new Intl.DateTimeFormat().resolvedOptions();
    const spy = vi
      .spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
      .mockReturnValue({ ...real, timeZone: 'Pacific/Kiritimati' });
    const instant = Date.parse('2026-03-09T05:00:00.000Z');
    expect(currentReviewRange(instant)).toEqual({
      from: '2026-03-03',
      to: '2026-03-09',
      tz: 'Pacific/Kiritimati',
      fellBack: false,
    });

    spy.mockReturnValue({ ...real, timeZone: 'EST5EDT' });
    expect(currentReviewRange(instant)).toEqual({
      from: '2026-03-03',
      to: '2026-03-09',
      tz: 'UTC',
      fellBack: true,
    });
  });
});
