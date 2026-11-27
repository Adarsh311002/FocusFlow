import { z } from 'zod';

import { calendarDateSchema } from '../dates';
import { goalIdSchema } from '../ids';

// Goals (GL1–GL5, docs/decisions/decision-log.md): what a set of tasks is for. A goal is
// active, completed or archived; it is never deleted. Inbound schemas are strict.

export const GOAL_TITLE_MAX_LENGTH = 80;
export const GOAL_WHY_MAX_LENGTH = 280;
/** Active and completed goals one user may keep (archived ones do not count). */
export const GOALS_MAX = 50;

export const goalColorSchema = z.enum(['leaf', 'moss', 'fern', 'amber', 'berry', 'sky']);
export type GoalColor = z.infer<typeof goalColorSchema>;

export const goalStatusSchema = z.enum(['active', 'completed', 'archived']);
export type GoalStatus = z.infer<typeof goalStatusSchema>;

export const goalViewSchema = z.object({
  id: goalIdSchema,
  title: z.string().min(1).max(GOAL_TITLE_MAX_LENGTH),
  why: z.string().min(1).max(GOAL_WHY_MAX_LENGTH).nullable(),
  targetDate: calendarDateSchema.nullable(),
  color: goalColorSchema,
  status: goalStatusSchema,
  createdAt: z.iso.datetime(),
  /** When it was completed or archived; `null` while active. */
  endedAt: z.iso.datetime().nullable(),
  /** GL3: the goal's live (not deleted) tasks and the focus that went into them. */
  progress: z.object({
    openTasks: z.number().int().nonnegative(),
    completedTasks: z.number().int().nonnegative(),
    focusedSeconds: z.number().int().nonnegative(),
  }),
});
export type GoalView = z.infer<typeof goalViewSchema>;

const goalTitleSchema = z.string().trim().min(1).max(GOAL_TITLE_MAX_LENGTH);
/** Trimmed; blank means none. */
const goalWhySchema = z
  .string()
  .trim()
  .max(GOAL_WHY_MAX_LENGTH)
  .transform((why) => (why === '' ? null : why));

export const createGoalRequestSchema = z.strictObject({
  title: goalTitleSchema,
  why: goalWhySchema.optional(),
  targetDate: calendarDateSchema.optional(),
  color: goalColorSchema.optional(),
});
export type CreateGoalRequest = z.input<typeof createGoalRequestSchema>;

/** `PATCH /goals/:goalId`: at least one field; `null` clears `why` or `targetDate`. */
export const updateGoalRequestSchema = z
  .strictObject({
    title: goalTitleSchema.optional(),
    why: goalWhySchema.nullable().optional(),
    targetDate: calendarDateSchema.nullable().optional(),
    color: goalColorSchema.optional(),
    status: goalStatusSchema.optional(),
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: 'Give at least one field.',
  });
export type UpdateGoalRequest = z.input<typeof updateGoalRequestSchema>;

export const goalParamsSchema = z.strictObject({ goalId: goalIdSchema });

/** `GET /goals`: active and completed goals, active first then newest; `?archived=true` adds archived ones. */
export const listGoalsQuerySchema = z.strictObject({
  archived: z.enum(['true', 'false']).default('false'),
});

export const goalResponseSchema = z.object({ goal: goalViewSchema });
export type GoalResponse = z.infer<typeof goalResponseSchema>;
export const goalListResponseSchema = z.object({ goals: z.array(goalViewSchema) });
export type GoalListResponse = z.infer<typeof goalListResponseSchema>;
