import {
  FOCUS_SESSION_PLANNED_SECONDS_MAX,
  FOCUS_SESSION_PLANNED_SECONDS_MIN,
  type FocusSessionView,
} from '@focus-flow/contracts';

// Display arithmetic for a focus session (D6). Everything here is for showing a clock only:
// the server alone decides when a session is completed or abandoned, so the browser never
// derives an outcome from these numbers.

export const MIN_CUSTOM_MINUTES = FOCUS_SESSION_PLANNED_SECONDS_MIN / 60;
export const MAX_CUSTOM_MINUTES = FOCUS_SESSION_PLANNED_SECONDS_MAX / 60;

type InProgressSession = Extract<FocusSessionView, { status: 'in_progress' }>;

/**
 * Focused seconds at the (server-synced) instant: the accumulated value plus the running
 * stretch, if any. Clamped to `[0, plannedSeconds]` so a slightly early or late clock
 * estimate never shows an impossible value.
 */
export function focusedSecondsAt(session: InProgressSession, serverNowMs: number): number {
  const stretch =
    session.runningSince === null
      ? 0
      : Math.floor((serverNowMs - Date.parse(session.runningSince)) / 1000);
  return Math.min(session.plannedSeconds, Math.max(0, session.focusedSeconds + stretch));
}

export function remainingSecondsAt(session: InProgressSession, serverNowMs: number): number {
  return session.plannedSeconds - focusedSecondsAt(session, serverNowMs);
}

/** `MM:SS`, or `H:MM:SS` from one hour up. Negative and fractional input is floored at 0. */
export function formatClock(totalSeconds: number): string {
  const whole = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;
  const two = (value: number): string => String(value).padStart(2, '0');
  return hours > 0
    ? `${String(hours)}:${two(minutes)}:${two(seconds)}`
    : `${two(minutes)}:${two(seconds)}`;
}

/** Whole minutes for sentences such as "25 min recorded"; rounds down like the server (E14). */
export function wholeMinutes(seconds: number): number {
  return Math.floor(Math.max(0, seconds) / 60);
}

export type DurationParse =
  | { readonly ok: true; readonly plannedSeconds: number }
  | { readonly ok: false; readonly error: string };

export const INVALID_DURATION = `Enter a whole number of minutes from ${String(MIN_CUSTOM_MINUTES)} to ${String(MAX_CUSTOM_MINUTES)}.`;

/** Minutes typed by the user to `plannedSeconds`, within the same bounds as E1. */
export function parseDurationMinutes(text: string): DurationParse {
  const trimmed = text.trim();
  if (!/^\d{1,4}$/.test(trimmed)) {
    return { ok: false, error: INVALID_DURATION };
  }
  const minutes = Number(trimmed);
  if (minutes < MIN_CUSTOM_MINUTES || minutes > MAX_CUSTOM_MINUTES) {
    return { ok: false, error: INVALID_DURATION };
  }
  return { ok: true, plannedSeconds: minutes * 60 };
}
