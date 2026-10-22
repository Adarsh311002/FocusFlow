import { z } from 'zod';

// Calendar dates and time zones shared by the API and the web app (Phase 5 review,
// docs/api/rest.md "Focus sessions", V1–V8). A calendar date is a plain `YYYY-MM-DD`
// with no time zone of its own: arithmetic on it uses UTC midnight purely as a
// counter, so a daylight-saving change can never move a date.

/** A real calendar date `YYYY-MM-DD` (leap years and month lengths checked). */
export const calendarDateSchema = z.iso.date();
export type CalendarDate = z.infer<typeof calendarDateSchema>;

const DAY_MS = 86_400_000;

const dateToUtcMs = (date: string): number => Date.parse(`${date}T00:00:00.000Z`);

/** `date` moved by `days` calendar days (negative moves back). */
export const addCalendarDays = (date: string, days: number): string =>
  new Date(dateToUtcMs(date) + days * DAY_MS).toISOString().slice(0, 10);

/** Whole days from `from` to `to`: 0 for the same date, negative when `to` is earlier. */
export const calendarDaysBetween = (from: string, to: string): number =>
  Math.round((dateToUtcMs(to) - dateToUtcMs(from)) / DAY_MS);

/** Every date from `from` to `to`, both included, oldest first; empty when `to < from`. */
export const calendarDatesFrom = (from: string, to: string): string[] => {
  const count = calendarDaysBetween(from, to) + 1;
  return Array.from({ length: Math.max(0, count) }, (_, index) => addCalendarDays(from, index));
};

/**
 * Only `UTC` and `Area/Location` names (`Europe/Berlin`, `America/Argentina/Buenos_Aires`,
 * `Etc/GMT+5`). Offsets (`+05:30`, `UTC+3`), abbreviations (`PST`) and POSIX rules
 * (`EST5EDT`) are refused even where `Intl` accepts them: other engines read several of
 * them differently (PostgreSQL inverts the sign of `+05:30`), and a browser always reports
 * a region name (V5).
 */
const TIME_ZONE_NAME = /^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)$/;

/** True for a time zone name the runtime's IANA database (via `Intl`) recognises. */
export const isIanaTimeZone = (name: string): boolean => {
  if (name.length > 64 || !TIME_ZONE_NAME.test(name)) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
};

export const timeZoneSchema = z
  .string()
  .refine(isIanaTimeZone, { message: 'Must be an IANA time zone name such as Europe/Berlin.' });

/**
 * The calendar date of `instantMs` in `timeZone`. Uses `Intl` (the same IANA database
 * that validated the name), never the process's own time zone.
 */
export const createCalendarDateFormatter = (timeZone: string): ((instantMs: number) => string) => {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hourCycle: 'h23',
  });
  return (instantMs) => {
    const parts = format.formatToParts(instantMs);
    const part = (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find((candidate) => candidate.type === type)?.value ?? '';
    return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
  };
};
