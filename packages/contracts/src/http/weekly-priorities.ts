import { z } from 'zod';

import { calendarDateSchema } from '../dates';
import { taskIdSchema } from '../ids';
import { TASK_TITLE_MAX_LENGTH, taskStatusSchema } from './tasks';

// Weekly priorities (WR1–WR5, docs/decisions/decision-log.md): the user's top three tasks of
// one week, chosen in the weekly review. The week is the Monday of the user's local week,
// computed by the client in its own time zone (WR3); the server checks only that it is a
// Monday. Inbound schemas are strict.

export const WEEKLY_PRIORITIES_MAX = 3;

/** A calendar date that is a Monday (ISO weekday 1). */
export const weekStartSchema = calendarDateSchema.refine(
  (date) => new Date(`${date}T00:00:00Z`).getUTCDay() === 1,
  { message: 'Must be a Monday.' },
);

export const weeklyPriorityViewSchema = z.object({
  position: z.number().int().min(1).max(WEEKLY_PRIORITIES_MAX),
  task: z.object({
    id: taskIdSchema,
    title: z.string().min(1).max(TASK_TITLE_MAX_LENGTH),
    status: taskStatusSchema,
  }),
});
export type WeeklyPriorityView = z.infer<typeof weeklyPriorityViewSchema>;

/** `GET /weekly-priorities?week=` and the answer of `PUT`: in position order. */
export const weeklyPrioritiesResponseSchema = z.object({
  week: calendarDateSchema,
  priorities: z.array(weeklyPriorityViewSchema).max(WEEKLY_PRIORITIES_MAX),
});
export type WeeklyPrioritiesResponse = z.infer<typeof weeklyPrioritiesResponseSchema>;

export const weeklyPrioritiesQuerySchema = z.strictObject({ week: weekStartSchema });

/**
 * `PUT /weekly-priorities`: replaces the week's list with these tasks, in order (WR2). Each
 * must be the caller's own, not deleted and open; no task twice.
 */
export const setWeeklyPrioritiesRequestSchema = z.strictObject({
  week: weekStartSchema,
  taskIds: z
    .array(taskIdSchema)
    .max(WEEKLY_PRIORITIES_MAX)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'A task may appear once.' }),
});
export type SetWeeklyPrioritiesRequest = z.infer<typeof setWeeklyPrioritiesRequestSchema>;
