import {
  addCalendarDays,
  calendarDatesFrom,
  calendarDaysBetween,
  type FocusSessionInsightsQuery,
  type FocusSessionInsightsResponse,
  INSIGHTS_TOP_TASKS,
  type InsightsBucket,
  type InsightsDay,
  type InsightsTask,
  type InsightsTotals,
  taskIdSchema,
} from '@focus-flow/contracts';

import type { InsightMinute, TaskLabel } from './review-queries.js';

// Dashboard insights (A1–A10): the pure part. Everything here works on rows already read
// from PostgreSQL, so the time zone, DST and ranking rules can be tested without a
// database. Calendar dates and the weekday/hour of a session come from `Intl`, never from
// offset arithmetic (V5, V7).

const WEEKDAYS: Readonly<Record<string, number>> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

export type LocalMoment = {
  readonly date: string;
  readonly weekday: number;
  readonly hour: number;
};

/** The local calendar date, weekday (Monday = 0) and hour of an instant in `timeZone`. */
export const createLocalMomentFormatter = (
  timeZone: string,
): ((instantMs: number) => LocalMoment) => {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  return (instantMs) => {
    const parts = format.formatToParts(instantMs);
    const part = (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find((candidate) => candidate.type === type)?.value ?? '';
    return {
      date: `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`,
      weekday: WEEKDAYS[part('weekday')] ?? 0,
      // `h23` never yields 24, but an engine quirk that does means midnight.
      hour: Number(part('hour')) % 24,
    };
  };
};

/**
 * Current and longest streak of consecutive local dates with a completed session (A3).
 * The current streak ends today, or yesterday while today has none yet (the day is not
 * over, so the streak is not broken); anything older makes it 0.
 */
export const computeStreak = (
  completedDates: ReadonlySet<string>,
  today: string,
): { current: number; longest: number; todayCompleted: boolean } => {
  const sorted = [...completedDates].sort();
  let longest = 0;
  let run = 0;
  let previous: string | undefined;
  for (const date of sorted) {
    run = previous !== undefined && calendarDaysBetween(previous, date) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = date;
  }

  const todayCompleted = completedDates.has(today);
  let cursor = todayCompleted ? today : addCalendarDays(today, -1);
  let current = 0;
  while (completedDates.has(cursor)) {
    current += 1;
    cursor = addCalendarDays(cursor, -1);
  }
  return { current, longest, todayCompleted };
};

type Counters = {
  sessionCount: number;
  completedCount: number;
  abandonedCount: number;
  completedFocusedSeconds: number;
  totalFocusedSeconds: number;
};

const emptyCounters = (): Counters => ({
  sessionCount: 0,
  completedCount: 0,
  abandonedCount: 0,
  completedFocusedSeconds: 0,
  totalFocusedSeconds: 0,
});

const addMinute = (counters: Counters, minute: InsightMinute): void => {
  counters.completedCount += minute.completedCount;
  counters.abandonedCount += minute.abandonedCount;
  counters.sessionCount += minute.completedCount + minute.abandonedCount;
  counters.completedFocusedSeconds += minute.completedFocusedSeconds;
  counters.totalFocusedSeconds += minute.totalFocusedSeconds;
};

const toTotals = (counters: Counters): InsightsTotals => ({
  ...counters,
  completionRate:
    counters.sessionCount === 0 ? null : counters.completedCount / counters.sessionCount,
});

const toBucket = (counters: Counters): InsightsBucket => ({
  sessionCount: counters.sessionCount,
  completedCount: counters.completedCount,
  totalFocusedSeconds: counters.totalFocusedSeconds,
});

/** Rounds a ratio to 4 decimals so the JSON stays short and stable. */
const ratio = (value: number): number => Math.round(value * 10_000) / 10_000;

export type InsightsInput = {
  readonly query: FocusSessionInsightsQuery;
  /** Ended-session minutes covering the current AND the previous period (with slack). */
  readonly minutes: readonly InsightMinute[];
  /** Every UTC minute in which a completed session started, over all history. */
  readonly completedMinutes: readonly number[];
  readonly dailyGoalSeconds: number;
  /** The current instant, only used to find "today" in `tz` for the streak. */
  readonly nowMs: number;
  /** Looks up the titles of the tasks that appear in the breakdown. */
  readonly labelsOf: (taskIds: readonly string[]) => Promise<readonly TaskLabel[]>;
};

/** The previous period: as many days as the range, ending the day before it (A7). */
export const previousPeriod = (query: {
  readonly from: string;
  readonly to: string;
}): { from: string; to: string; dayCount: number } => {
  const dayCount = calendarDaysBetween(query.from, query.to) + 1;
  return {
    from: addCalendarDays(query.from, -dayCount),
    to: addCalendarDays(query.from, -1),
    dayCount,
  };
};

export const buildInsights = async (
  input: InsightsInput,
): Promise<FocusSessionInsightsResponse> => {
  const { query, dailyGoalSeconds } = input;
  const localOf = createLocalMomentFormatter(query.tz);
  const previous = previousPeriod(query);
  const dates = calendarDatesFrom(query.from, query.to);

  const days = new Map<string, Counters>(dates.map((date) => [date, emptyCounters()]));
  const cells = Array.from({ length: 7 * 24 }, () => ({ sessionCount: 0, totalFocusedSeconds: 0 }));
  const taskTotals = new Map<string, Counters>();
  const noTask = emptyCounters();
  const solo = emptyCounters();
  const room = emptyCounters();
  const current = emptyCounters();
  const before = emptyCounters();

  for (const minute of input.minutes) {
    const local = localOf(minute.minuteStartMs);
    if (local.date >= previous.from && local.date <= previous.to) {
      addMinute(before, minute);
      continue;
    }
    const day = days.get(local.date);
    if (day === undefined) {
      continue;
    }
    addMinute(day, minute);
    addMinute(current, minute);
    addMinute(minute.isRoom ? room : solo, minute);

    const cell = cells[local.weekday * 24 + local.hour];
    if (cell !== undefined) {
      cell.sessionCount += minute.completedCount + minute.abandonedCount;
      cell.totalFocusedSeconds += minute.totalFocusedSeconds;
    }

    if (minute.taskId === null) {
      addMinute(noTask, minute);
    } else {
      const counters = taskTotals.get(minute.taskId) ?? emptyCounters();
      addMinute(counters, minute);
      taskTotals.set(minute.taskId, counters);
    }
  }

  // Tasks: rank by focused time, then by sessions, then by id so equal tasks never swap.
  const ranked = [...taskTotals.entries()].sort(
    ([idA, a], [idB, b]) =>
      b.totalFocusedSeconds - a.totalFocusedSeconds ||
      b.sessionCount - a.sessionCount ||
      idA.localeCompare(idB),
  );
  const top = ranked.slice(0, INSIGHTS_TOP_TASKS);
  const rest = ranked.slice(INSIGHTS_TOP_TASKS);
  const labels = new Map(
    (await input.labelsOf(top.map(([taskId]) => taskId))).map((label) => [label.id, label]),
  );
  const tasks: InsightsTask[] = top.flatMap(([taskId, counters]) => {
    const label = labels.get(taskId);
    // A session's task always exists (a plain foreign key, P1); a missing label can only
    // mean the row vanished between the two reads, so it is skipped rather than invented.
    return label === undefined
      ? []
      : [
          {
            taskId: taskIdSchema.parse(taskId),
            title: label.title,
            deleted: label.deleted,
            ...toBucket(counters),
          },
        ];
  });
  const otherTasks = rest.reduce(
    (sum, [, counters]) => ({
      taskCount: sum.taskCount + 1,
      sessionCount: sum.sessionCount + counters.sessionCount,
      completedCount: sum.completedCount + counters.completedCount,
      totalFocusedSeconds: sum.totalFocusedSeconds + counters.totalFocusedSeconds,
    }),
    { taskCount: 0, sessionCount: 0, completedCount: 0, totalFocusedSeconds: 0 },
  );

  const dayViews: InsightsDay[] = dates.map((date) => {
    const counters = days.get(date) ?? emptyCounters();
    return {
      date,
      sessionCount: counters.sessionCount,
      completedCount: counters.completedCount,
      completedFocusedSeconds: counters.completedFocusedSeconds,
      totalFocusedSeconds: counters.totalFocusedSeconds,
      goalProgress: ratio(counters.totalFocusedSeconds / dailyGoalSeconds),
      goalMet: counters.totalFocusedSeconds >= dailyGoalSeconds,
    };
  });

  const completedDates = new Set(input.completedMinutes.map((ms) => localOf(ms).date));
  const today = localOf(input.nowMs).date;
  const totals = toTotals(current);
  const previousTotals = toTotals(before);

  return {
    range: { from: query.from, to: query.to, tz: query.tz, dayCount: dates.length },
    dailyGoalSeconds,
    totals,
    days: dayViews,
    goalDaysMet: dayViews.filter((day) => day.goalMet).length,
    streak: { ...computeStreak(completedDates, today), today },
    heatmap: cells.map((cell, index) => ({
      weekday: Math.floor(index / 24),
      hour: index % 24,
      ...cell,
    })),
    tasks,
    otherTasks,
    noTask: toBucket(noTask),
    split: { solo: toBucket(solo), room: toBucket(room) },
    comparison: {
      previousFrom: previous.from,
      previousTo: previous.to,
      previous: previousTotals,
      delta: {
        sessionCount: totals.sessionCount - previousTotals.sessionCount,
        completedCount: totals.completedCount - previousTotals.completedCount,
        completedFocusedSeconds:
          totals.completedFocusedSeconds - previousTotals.completedFocusedSeconds,
        totalFocusedSeconds: totals.totalFocusedSeconds - previousTotals.totalFocusedSeconds,
        totalFocusedSecondsChange:
          previousTotals.totalFocusedSeconds === 0
            ? null
            : ratio(
                (totals.totalFocusedSeconds - previousTotals.totalFocusedSeconds) /
                  previousTotals.totalFocusedSeconds,
              ),
        completionRate:
          totals.completionRate === null || previousTotals.completionRate === null
            ? null
            : ratio(totals.completionRate - previousTotals.completionRate),
      },
    },
  };
};
