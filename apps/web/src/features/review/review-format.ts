import type { FocusSessionView } from '@focus-flow/contracts';

// Display formatting for the Review page. Pure functions; the locale defaults to the
// browser's, and tests pass one explicitly.

const MINUTE = 60;
const HOUR = 3_600;

/**
 * Whole seconds as "1 h 25 min", "12 min" or "45 s". Rounded down, like focused time
 * itself (E14), so the page never shows more focus than was recorded.
 */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  if (total < MINUTE) {
    return total === 0 ? '0 min' : `${String(total)} s`;
  }
  const hours = Math.floor(total / HOUR);
  const minutes = Math.floor((total % HOUR) / MINUTE);
  if (hours === 0) {
    return `${String(minutes)} min`;
  }
  return minutes === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(minutes)} min`;
}

/** An instant as a short date and time in `timeZone` (the zone the summary uses). */
export function formatDateTime(iso: string, timeZone: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(new Date(iso));
}

/**
 * A calendar date `YYYY-MM-DD` as "Mon, Mar 9". The date has no zone of its own, so it is
 * formatted at UTC noon in UTC: the label can never drift to a neighbouring day.
 */
export function formatDayLabel(date: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T12:00:00.000Z`));
}

/** What happened to a session, in the words the history list shows. */
export function sessionStatusLabel(session: FocusSessionView): string {
  switch (session.status) {
    case 'completed':
      return 'Completed';
    case 'in_progress':
      return session.runningSince === null ? 'Paused' : 'In progress';
    case 'abandoned':
      switch (session.abandonReason) {
        case 'stopped':
          return 'Stopped early';
        case 'grace_expired':
          return 'Disconnected';
        case 'expired':
          return 'Expired';
      }
  }
}
