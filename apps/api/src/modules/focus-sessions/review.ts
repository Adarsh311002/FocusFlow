import {
  calendarDatesFrom,
  createCalendarDateFormatter,
  type FocusSessionInsightsQuery,
  type FocusSessionInsightsResponse,
  type FocusSessionListResponse,
  type FocusSessionSummaryQuery,
  type FocusSessionSummaryResponse,
  type ListFocusSessionsQuery,
  REVIEW_MAX_INSTANT_MS,
} from '@focus-flow/contracts';

import type { Executor } from '../../db/client.js';
import { buildInsights, previousPeriod } from './insights.js';
import { decodeHistoryCursor, encodeHistoryCursor, invalidHistoryCursor } from './review-cursor.js';
import {
  countUnbrokenDeepFocusRun,
  findDailyGoalSeconds,
  findTaskLabels,
  listCompletedSessionMinutes,
  listOwnSessions,
  ownSessionExists,
  sumEndedSessionsByMinute,
  sumEndedSessionsByMinuteDetailed,
} from './review-queries.js';
import { toFocusSessionView } from './views.js';

// Review: history and summary (Phase 5; docs/api/rest.md "Focus sessions", V1–V8).
// Read-only and PostgreSQL only: no Redis, no locks, no events.

export type ReviewDeps = {
  readonly db: Executor;
  /** The clock for "today" in the insights streak; defaults to `Date.now` (tests inject it). */
  readonly now?: () => number;
};

/** One page of the user's history, newest-started first (V1, V2). */
export const listFocusSessionHistory = async (
  deps: ReviewDeps,
  userId: string,
  query: ListFocusSessionsQuery,
): Promise<FocusSessionListResponse> => {
  const afterSessionId = query.cursor === undefined ? undefined : decodeHistoryCursor(query.cursor);
  if (afterSessionId !== undefined && !(await ownSessionExists(deps.db, userId, afterSessionId))) {
    throw invalidHistoryCursor();
  }
  // One extra row tells whether another page exists without a separate COUNT.
  const rows = await listOwnSessions(deps.db, userId, {
    fromMs: query.from === undefined ? undefined : Date.parse(query.from),
    toMs: query.to === undefined ? undefined : Date.parse(query.to),
    afterSessionId,
    limit: query.limit + 1,
  });
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    sessions: page.map(({ session, task }) => toFocusSessionView(session, task ?? undefined)),
    nextCursor:
      rows.length > query.limit && last !== undefined ? encodeHistoryCursor(last.session.id) : null,
  };
};

const DAY_MS = 86_400_000;

/**
 * UTC midnight of `date`, moved by `days` whole days. The shift is milliseconds rather
 * than a re-formatted date string: widening the range past 9999-12-31 would leave the
 * four-digit ISO year behind, and how `Date.parse` reads such a string is up to the
 * engine. UTC has no daylight saving, so a day is always 86 400 000 ms here.
 */
const utcMidnightMs = (date: string, days: number): number =>
  Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS;

/**
 * Totals of the user's ended sessions whose start falls on a calendar date in
 * `[from, to]` in `tz` (V3–V7). The instant range read from PostgreSQL is widened by two
 * days on each side, which covers every UTC offset (−12 h to +14 h); the exact calendar
 * date of each minute then decides, with `Intl`, so DST changes and midnights that do not
 * exist are handled by the time zone database rather than by offset arithmetic.
 */
export const summarizeFocusSessions = async (
  deps: ReviewDeps,
  userId: string,
  query: FocusSessionSummaryQuery,
): Promise<FocusSessionSummaryResponse> => {
  const minutes = await sumEndedSessionsByMinute(deps.db, userId, {
    fromMs: utcMidnightMs(query.from, -2),
    // `to` may be 9999-12-31, three days past which no longer fits a four-digit ISO year,
    // and the driver would send PostgreSQL the expanded `+010000-…` spelling. Clamping
    // loses nothing: the widening is only slack for the extreme UTC offsets, and no
    // session can have started beyond the last supported instant. The bound is exclusive,
    // but even `MAX + 1` would be a year-10000 `Date`, so the clamp stays on the last
    // representable millisecond (a session starting in exactly that millisecond of year
    // 9999 cannot exist: `started_at` is written from the server clock).
    toMs: Math.min(utcMidnightMs(query.to, 3), REVIEW_MAX_INSTANT_MS),
  });

  const days = new Map(
    calendarDatesFrom(query.from, query.to).map((date) => [
      date,
      { date, completedFocusedSeconds: 0, totalFocusedSeconds: 0 },
    ]),
  );
  const calendarDateOf = createCalendarDateFormatter(query.tz);
  let completedCount = 0;
  for (const minute of minutes) {
    const day = days.get(calendarDateOf(minute.minuteStartMs));
    if (day === undefined) {
      continue;
    }
    completedCount += minute.completedCount;
    day.completedFocusedSeconds += minute.completedFocusedSeconds;
    day.totalFocusedSeconds += minute.totalFocusedSeconds;
  }

  const dayList = [...days.values()];
  return {
    completedCount,
    completedFocusedSeconds: dayList.reduce((sum, day) => sum + day.completedFocusedSeconds, 0),
    totalFocusedSeconds: dayList.reduce((sum, day) => sum + day.totalFocusedSeconds, 0),
    days: dayList,
  };
};

/**
 * The dashboard's insights for `[from, to]` in `tz` (A1–A10): the summary's rules (V3–V7)
 * plus streaks, the daily goal, the hour heatmap, the task breakdown, the completion rate,
 * the previous equal-length period and the solo/room split. Two aggregate reads cover the
 * current and the previous period together (widened by two days like the summary, then
 * decided by the calendar date of each minute through `Intl`); a third reads the minutes
 * of every completed session for the streak.
 */
export const getFocusInsights = async (
  deps: ReviewDeps,
  userId: string,
  query: FocusSessionInsightsQuery,
): Promise<FocusSessionInsightsResponse> => {
  const previous = previousPeriod(query);
  const [minutes, completedMinutes, dailyGoalSeconds, deepUnbrokenRun] = await Promise.all([
    sumEndedSessionsByMinuteDetailed(deps.db, userId, {
      // No session can predate 1970, whatever the previous period's dates say.
      fromMs: Math.max(0, utcMidnightMs(previous.from, -2)),
      toMs: Math.min(utcMidnightMs(query.to, 3), REVIEW_MAX_INSTANT_MS),
    }),
    listCompletedSessionMinutes(deps.db, userId),
    findDailyGoalSeconds(deps.db, userId),
    countUnbrokenDeepFocusRun(deps.db, userId),
  ]);
  return buildInsights({
    query,
    minutes,
    completedMinutes,
    dailyGoalSeconds,
    deepUnbrokenRun,
    nowMs: (deps.now ?? Date.now)(),
    labelsOf: (taskIds) => findTaskLabels(deps.db, userId, taskIds),
  });
};
