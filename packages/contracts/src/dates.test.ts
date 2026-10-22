import { describe, expect, it } from 'vitest';

import {
  addCalendarDays,
  calendarDateSchema,
  calendarDatesFrom,
  calendarDaysBetween,
  createCalendarDateFormatter,
  isIanaTimeZone,
} from './dates';

describe('calendar dates', () => {
  it('accepts real dates only', () => {
    expect(calendarDateSchema.safeParse('2028-02-29').success).toBe(true);
    for (const value of [
      '2026-02-29',
      '2026-04-31',
      '2026-13-01',
      '2026-1-01',
      '2026-10-07T00:00Z',
    ]) {
      expect(calendarDateSchema.safeParse(value).success).toBe(false);
    }
  });

  it('moves across months, years, leap days and DST changes without drifting', () => {
    expect(addCalendarDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(addCalendarDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(addCalendarDays('2026-11-01', 1)).toBe('2026-11-02');
    expect(addCalendarDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addCalendarDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addCalendarDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('counts and lists days with both ends included', () => {
    expect(calendarDaysBetween('2026-10-01', '2026-10-01')).toBe(0);
    expect(calendarDaysBetween('2026-10-07', '2026-10-01')).toBe(-6);
    expect(calendarDaysBetween('2027-01-01', '2028-01-01')).toBe(365);
    expect(calendarDatesFrom('2026-10-30', '2026-11-02')).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]);
    expect(calendarDatesFrom('2026-10-02', '2026-10-01')).toEqual([]);
  });
});

describe('isIanaTimeZone (V5)', () => {
  it.each([
    'UTC',
    'Europe/Berlin',
    'America/Argentina/Buenos_Aires',
    'Asia/Kolkata',
    'Asia/Calcutta',
    'Etc/GMT+5',
    'america/new_york',
  ])('accepts %s', (name) => {
    expect(isIanaTimeZone(name)).toBe(true);
  });

  it.each([
    '',
    '+05:30',
    '-03:00',
    'UTC+3',
    'GMT+3',
    'PST',
    'EST',
    'EST5EDT',
    'localtime',
    'posixrules',
    'Foo/Bar',
    'Europe/',
    "UTC'; --",
    `Europe/${'x'.repeat(80)}`,
  ])('rejects %j', (name) => {
    expect(isIanaTimeZone(name)).toBe(false);
  });
});

describe('createCalendarDateFormatter', () => {
  it('uses the given zone, never the process zone', () => {
    const instant = Date.parse('2026-10-16T10:30:00.000Z');
    expect(createCalendarDateFormatter('Pacific/Kiritimati')(instant)).toBe('2026-10-17');
    expect(createCalendarDateFormatter('Pacific/Pago_Pago')(instant)).toBe('2026-10-15');
    expect(createCalendarDateFormatter('UTC')(instant)).toBe('2026-10-16');
  });

  it('starts a day exactly at local midnight, across DST changes', () => {
    const newYork = createCalendarDateFormatter('America/New_York');
    expect(newYork(Date.parse('2026-03-08T04:59:59.999Z'))).toBe('2026-03-07');
    expect(newYork(Date.parse('2026-03-08T05:00:00.000Z'))).toBe('2026-03-08');
    expect(newYork(Date.parse('2026-11-02T04:59:59.999Z'))).toBe('2026-11-01');
    expect(newYork(Date.parse('2026-11-02T05:00:00.000Z'))).toBe('2026-11-02');
  });
});
