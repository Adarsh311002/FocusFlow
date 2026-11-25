import { z } from 'zod';

import { calendarDateSchema, timeZoneSchema } from '../dates';
import { taskIdSchema } from '../ids';
import { focusSessionSummaryQuerySchema } from './focus-sessions';
import { TASK_TITLE_MAX_LENGTH } from './tasks';

// Dashboard insights (docs/api/rest.md "Focus sessions", decisions A1–A10). A richer
// sibling of `GET /focus-sessions/summary`: it keeps the review semantics V1–V8 (calendar
// dates in the user's `tz` through `Intl`, a session counts on the local date it STARTED,
// ended sessions only) and answers everything the dashboard draws in one request.

/** How many tasks the per-task breakdown lists before folding the rest into `otherTasks` (A6). */
export const INSIGHTS_TOP_TASKS = 10;

/** `GET /focus-sessions/insights` takes the same range as the summary: `from`, `to`, `tz`. */
export const focusSessionInsightsQuerySchema = focusSessionSummaryQuerySchema;
export type FocusSessionInsightsQuery = z.infer<typeof focusSessionInsightsQuerySchema>;

const countSchema = z.number().int().nonnegative();
const secondsSchema = z.number().int().nonnegative();

/**
 * Totals of the ended sessions that started in a period. `completionRate` is
 * `completedCount / sessionCount` (0..1), `null` when nothing ended (A5).
 */
export const insightsTotalsSchema = z.object({
  sessionCount: countSchema,
  completedCount: countSchema,
  abandonedCount: countSchema,
  completionRate: z.number().min(0).max(1).nullable(),
  completedFocusedSeconds: secondsSchema,
  totalFocusedSeconds: secondsSchema,
});
export type InsightsTotals = z.infer<typeof insightsTotalsSchema>;

export const insightsDaySchema = z.object({
  date: calendarDateSchema,
  sessionCount: countSchema,
  completedCount: countSchema,
  completedFocusedSeconds: secondsSchema,
  totalFocusedSeconds: secondsSchema,
  /** `totalFocusedSeconds / dailyGoalSeconds`, uncapped (1 = goal reached), 4 decimals (A2). */
  goalProgress: z.number().nonnegative(),
  goalMet: z.boolean(),
});
export type InsightsDay = z.infer<typeof insightsDaySchema>;

/** Streaks are counted over all history, not only the requested range (A3). */
export const insightsStreakSchema = z.object({
  /** Consecutive days with a completed session, ending today or, if today has none yet, yesterday. */
  current: countSchema,
  longest: countSchema,
  /** Today in `tz`: the date the current streak is measured from. */
  today: calendarDateSchema,
  todayCompleted: z.boolean(),
});
export type InsightsStreak = z.infer<typeof insightsStreakSchema>;

/** One cell of the weekday x hour heatmap; sessions count on their local START hour (A4). */
export const insightsHeatmapCellSchema = z.object({
  /** 0 = Monday ... 6 = Sunday. */
  weekday: z.number().int().min(0).max(6),
  /** Local hour, 0..23. */
  hour: z.number().int().min(0).max(23),
  sessionCount: countSchema,
  totalFocusedSeconds: secondsSchema,
});
export type InsightsHeatmapCell = z.infer<typeof insightsHeatmapCellSchema>;

export const insightsBucketSchema = z.object({
  sessionCount: countSchema,
  completedCount: countSchema,
  totalFocusedSeconds: secondsSchema,
});
export type InsightsBucket = z.infer<typeof insightsBucketSchema>;

/** A task of the breakdown; a soft-deleted task is flagged, never hidden (D38, A6). */
export const insightsTaskSchema = insightsBucketSchema.extend({
  taskId: taskIdSchema,
  title: z.string().min(1).max(TASK_TITLE_MAX_LENGTH),
  deleted: z.boolean(),
});
export type InsightsTask = z.infer<typeof insightsTaskSchema>;

export const insightsOtherTasksSchema = insightsBucketSchema.extend({ taskCount: countSchema });
export type InsightsOtherTasks = z.infer<typeof insightsOtherTasksSchema>;

/** Change against the previous period of equal length: `current - previous` (A7). */
export const insightsDeltaSchema = z.object({
  sessionCount: z.number().int(),
  completedCount: z.number().int(),
  completedFocusedSeconds: z.number().int(),
  totalFocusedSeconds: z.number().int(),
  /** Relative change of `totalFocusedSeconds` (0.25 = +25 %); `null` when the previous was 0. */
  totalFocusedSecondsChange: z.number().nullable(),
  /** Percentage points as a fraction (current - previous rate); `null` when either is `null`. */
  completionRate: z.number().nullable(),
});
export type InsightsDelta = z.infer<typeof insightsDeltaSchema>;

export const focusSessionInsightsResponseSchema = z.object({
  range: z.object({
    from: calendarDateSchema,
    to: calendarDateSchema,
    tz: timeZoneSchema,
    dayCount: z.number().int().min(1),
  }),
  dailyGoalSeconds: z.number().int().positive(),
  totals: insightsTotalsSchema,
  /** Every date of the range, oldest first, zeros included. */
  days: z.array(insightsDaySchema),
  goalDaysMet: countSchema,
  streak: insightsStreakSchema,
  /** All 7 x 24 cells, weekday-major (Monday 00 first), zeros included. */
  heatmap: z.array(insightsHeatmapCellSchema).length(168),
  /** Top tasks by focused time, largest first (at most `INSIGHTS_TOP_TASKS`). */
  tasks: z.array(insightsTaskSchema).max(INSIGHTS_TOP_TASKS),
  otherTasks: insightsOtherTasksSchema,
  /** Sessions started without a task. */
  noTask: insightsBucketSchema,
  /** Solo sessions against room focus sessions (A8). */
  split: z.object({ solo: insightsBucketSchema, room: insightsBucketSchema }),
  /**
   * CI5: how the user's intentions went. Ended sessions of the range that had a task, by
   * their check-in; `unrecorded` were never checked in. The four counts sum to
   * `withIntention`.
   */
  /**
   * FQ3: how deep the user rated their ended sessions of the range (FQ1). `byHour` has 24
   * entries, local start hour 0–23; `average` is `null` where nothing was rated.
   */
  quality: z.object({
    ratedCount: countSchema,
    average: z.number().min(1).max(5).nullable(),
    byHour: z
      .array(z.object({ ratedCount: countSchema, average: z.number().min(1).max(5).nullable() }))
      .length(24),
  }),
  checkIns: z.object({
    withIntention: countSchema,
    done: countSchema,
    progress: countSchema,
    stuck: countSchema,
    unrecorded: countSchema,
  }),
  comparison: z.object({
    previousFrom: calendarDateSchema,
    previousTo: calendarDateSchema,
    previous: insightsTotalsSchema,
    delta: insightsDeltaSchema,
  }),
});
export type FocusSessionInsightsResponse = z.infer<typeof focusSessionInsightsResponseSchema>;
