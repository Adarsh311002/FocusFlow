import { z } from 'zod';

import { goalIdSchema, taskIdSchema, taskStepIdSchema } from '../ids';

/** Matches the `ck_tasks_title_length` CHECK constraint (docs/domain/model.md). */
export const TASK_TITLE_MAX_LENGTH = 200;

export const TASK_LIST_DEFAULT_LIMIT = 50;
export const TASK_LIST_MAX_LIMIT = 100;

/**
 * Trimmed before the length check, so a title of only whitespace is rejected rather
 * than stored as an empty-looking task. Zod counts UTF-16 code units, which is never
 * more permissive than PostgreSQL's `char_length` (code points), so a title that passes
 * here cannot fail the database constraint.
 */
export const taskTitleSchema = z.string().trim().min(1).max(TASK_TITLE_MAX_LENGTH);

export const taskStatusSchema = z.enum(['open', 'completed']);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

/** ES1: how many sessions the user expects a task to take. */
export const TASK_ESTIMATE_MAX = 20;
export const estimatedSessionsSchema = z.number().int().min(1).max(TASK_ESTIMATE_MAX);

/** SP1: the steps one task may hold. */
export const TASK_STEPS_MAX = 30;

const taskViewBase = {
  id: taskIdSchema,
  title: z.string().min(1).max(TASK_TITLE_MAX_LENGTH),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  // Wave 3 fields are optional so older fixtures and cached answers still parse; the API
  // always sends them, and a client reads a missing one as "none".
  /** GL2: the goal it serves. */
  goalId: goalIdSchema.nullable().optional(),
  /** ES1. */
  estimatedSessions: estimatedSessionsSchema.nullable().optional(),
  /** ES2: sessions that went into it (completed, or stopped after ≥ 10 focused minutes). */
  sessionsSpent: z.number().int().nonnegative().optional(),
  /** SP3: how many steps it has, and how many are done. */
  steps: z
    .object({ total: z.number().int().nonnegative(), done: z.number().int().nonnegative() })
    .optional(),
};

/**
 * A task as the API returns it. Deleted tasks are never returned by the task routes
 * (D38), so there is no "deleted" variant here; `completedAt` exists only on completed
 * tasks, which makes an open task with a completion time unrepresentable.
 */
export const taskViewSchema = z.discriminatedUnion('status', [
  z.object({ ...taskViewBase, status: z.literal('open') }),
  z.object({ ...taskViewBase, status: z.literal('completed'), completedAt: z.iso.datetime() }),
]);
export type TaskView = z.infer<typeof taskViewSchema>;

// Inbound schemas are strict: unknown keys (for example a `userId`) are rejected, never
// silently dropped (docs/architecture/contracts.md, rule 7).

export const createTaskRequestSchema = z.strictObject({
  title: taskTitleSchema,
  goalId: goalIdSchema.optional(),
  estimatedSessions: estimatedSessionsSchema.optional(),
});
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;

/**
 * `PATCH /tasks/:taskId`: at least one field. Completed tasks may be changed too; `null`
 * detaches the goal or clears the estimate.
 */
export const updateTaskRequestSchema = z
  .strictObject({
    title: taskTitleSchema.optional(),
    goalId: goalIdSchema.nullable().optional(),
    estimatedSessions: estimatedSessionsSchema.nullable().optional(),
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: 'Give at least one field.',
  });
export type UpdateTaskRequest = z.infer<typeof updateTaskRequestSchema>;

/** Path parameters of every `/tasks/:taskId…` route. */
export const taskParamsSchema = z.strictObject({ taskId: taskIdSchema });
export type TaskParams = z.infer<typeof taskParamsSchema>;

/**
 * `GET /tasks` query. Query-string values arrive as strings, hence `coerce` for
 * `limit`. `cursor` is opaque to the client: it is whatever the previous page returned
 * as `nextCursor`, and only the API interprets it.
 */
export const listTasksQuerySchema = z.strictObject({
  status: taskStatusSchema.default('open'),
  /** GL4: only this goal's tasks. */
  goalId: goalIdSchema.optional(),
  cursor: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(TASK_LIST_MAX_LIMIT).default(TASK_LIST_DEFAULT_LIMIT),
});
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;

export const taskResponseSchema = z.object({ task: taskViewSchema });
export type TaskResponse = z.infer<typeof taskResponseSchema>;

/** Newest-created first; `nextCursor` is `null` on the last page. */
export const taskListResponseSchema = z.object({
  tasks: z.array(taskViewSchema),
  nextCursor: z.string().nullable(),
});
export type TaskListResponse = z.infer<typeof taskListResponseSchema>;

/** `PUT /me/current-task`. `null` clears the current task. */
export const setCurrentTaskRequestSchema = z.strictObject({
  taskId: taskIdSchema.nullable(),
});
export type SetCurrentTaskRequest = z.infer<typeof setCurrentTaskRequestSchema>;

// Steps (SP1–SP3): a small checklist inside a task.

export const taskStepViewSchema = z.object({
  id: taskStepIdSchema,
  title: z.string().min(1).max(TASK_TITLE_MAX_LENGTH),
  done: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type TaskStepView = z.infer<typeof taskStepViewSchema>;

export const taskStepParamsSchema = z.strictObject({
  taskId: taskIdSchema,
  stepId: taskStepIdSchema,
});

export const createTaskStepRequestSchema = z.strictObject({ title: taskTitleSchema });

export const updateTaskStepRequestSchema = z
  .strictObject({ title: taskTitleSchema.optional(), done: z.boolean().optional() })
  .refine((value) => value.title !== undefined || value.done !== undefined, {
    message: 'Give at least one field.',
  });
export type UpdateTaskStepRequest = z.infer<typeof updateTaskStepRequestSchema>;

export const taskStepResponseSchema = z.object({ step: taskStepViewSchema });
export const taskStepListResponseSchema = z.object({
  steps: z.array(taskStepViewSchema).max(TASK_STEPS_MAX),
});
export type TaskStepListResponse = z.infer<typeof taskStepListResponseSchema>;
