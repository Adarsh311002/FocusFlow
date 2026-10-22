import {
  addCalendarDays,
  createCalendarDateFormatter,
  isIanaTimeZone,
} from '@focus-flow/contracts';

// The summary range of the Review page: the last N calendar days ending today, in the
// browser's time zone (D18: the client passes `tz`; a stored per-user zone comes later).

/** The zone the server can take for granted, used when the browser's is unusable. */
export const FALLBACK_TIME_ZONE = 'UTC';

export const REVIEW_RANGE_DAYS = 7;

export type ReviewTimeZone = {
  readonly timeZone: string;
  /** True when the browser's zone was missing or not an IANA name the API accepts. */
  readonly fellBack: boolean;
};

/** The browser's IANA zone, or `undefined` when the runtime cannot report one. */
export function readBrowserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/** Accepts only a name the summary contract accepts (`UTC` or `Area/Location`). */
export function resolveTimeZone(candidate: string | undefined): ReviewTimeZone {
  if (candidate !== undefined && isIanaTimeZone(candidate)) {
    return { timeZone: candidate, fellBack: false };
  }
  return { timeZone: FALLBACK_TIME_ZONE, fellBack: true };
}

export type ReviewRange = {
  /** Calendar dates `YYYY-MM-DD` in `tz`, both included. */
  readonly from: string;
  readonly to: string;
  readonly tz: string;
};

/** `days` calendar days ending on today's date in `timeZone` (dates, so DST cannot shift them). */
export function lastNDays(days: number, nowMs: number, timeZone: string): ReviewRange {
  const to = createCalendarDateFormatter(timeZone)(nowMs);
  return { from: addCalendarDays(to, -(days - 1)), to, tz: timeZone };
}

export type CurrentReviewRange = ReviewRange & { readonly fellBack: boolean };

/** The range the page asks for: the last `REVIEW_RANGE_DAYS` days in the browser's zone. */
export function currentReviewRange(nowMs: number = Date.now()): CurrentReviewRange {
  const { timeZone, fellBack } = resolveTimeZone(readBrowserTimeZone());
  return { ...lastNDays(REVIEW_RANGE_DAYS, nowMs, timeZone), fellBack };
}
