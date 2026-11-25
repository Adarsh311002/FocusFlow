import { z } from 'zod';

import { focusSessionIdSchema, parkedThoughtIdSchema } from '../ids';
import { TASK_TITLE_MAX_LENGTH, taskTitleSchema, taskViewSchema } from './tasks';

// Parked thoughts (PT1–PT4, docs/decisions/decision-log.md): a distraction written down
// during a session so it does not break the focus, later turned into a task or let go.
// Inbound schemas are strict: unknown keys (a `userId`, say) are rejected.

/** The open thoughts one user may keep (PT2); one more answers `409 THOUGHTS_FULL`. */
export const PARKED_THOUGHTS_MAX = 200;

export const parkedThoughtViewSchema = z.object({
  id: parkedThoughtIdSchema,
  body: z.string().min(1).max(TASK_TITLE_MAX_LENGTH),
  /** The session it was parked during, if any. */
  sessionId: focusSessionIdSchema.nullable(),
  createdAt: z.iso.datetime(),
});
export type ParkedThoughtView = z.infer<typeof parkedThoughtViewSchema>;

/** `POST /parked-thoughts`. The body is trimmed; it has a task title's limits (PT1). */
export const createParkedThoughtRequestSchema = z.strictObject({
  body: taskTitleSchema,
  sessionId: focusSessionIdSchema.optional(),
});
export type CreateParkedThoughtRequest = z.infer<typeof createParkedThoughtRequestSchema>;

export const parkedThoughtResponseSchema = z.object({ thought: parkedThoughtViewSchema });
export type ParkedThoughtResponse = z.infer<typeof parkedThoughtResponseSchema>;

/** `GET /parked-thoughts`: every open thought of the user, newest first. */
export const listParkedThoughtsResponseSchema = z.object({
  thoughts: z.array(parkedThoughtViewSchema).max(PARKED_THOUGHTS_MAX),
});
export type ListParkedThoughtsResponse = z.infer<typeof listParkedThoughtsResponseSchema>;

export const parkedThoughtParamsSchema = z.strictObject({ thoughtId: parkedThoughtIdSchema });

/** `POST /parked-thoughts/:thoughtId/task`: the new task; the thought is gone (PT3). */
export const parkedThoughtToTaskResponseSchema = z.object({ task: taskViewSchema });
export type ParkedThoughtToTaskResponse = z.infer<typeof parkedThoughtToTaskResponseSchema>;
