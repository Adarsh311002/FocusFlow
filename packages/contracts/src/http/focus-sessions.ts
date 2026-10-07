import { z } from 'zod';

import { focusSessionIdSchema, taskIdSchema } from '../ids';
import { TASK_TITLE_MAX_LENGTH } from './tasks';

// Solo focus sessions (Phase 4B; docs/architecture/contracts.md "Key contract shapes",
// docs/api/rest.md "Focus sessions", decisions E1–E16). Room sessions arrive in Phase 6,
// which widens `AbandonReason` and `FocusSessionContext` (E4, E5).

/** Matches the `ck_focus_sessions_planned_seconds` CHECK constraint (E1). */
export const FOCUS_SESSION_PLANNED_SECONDS_MIN = 60;
export const FOCUS_SESSION_PLANNED_SECONDS_MAX = 14_400;

export const plannedSecondsSchema = z
  .number()
  .int()
  .min(FOCUS_SESSION_PLANNED_SECONDS_MIN)
  .max(FOCUS_SESSION_PLANNED_SECONDS_MAX);

export const focusSessionStatusSchema = z.enum(['in_progress', 'completed', 'abandoned']);
export type FocusSessionStatus = z.infer<typeof focusSessionStatusSchema>;

/** Phase 4B allows only the solo reasons (E5); Phase 6 adds the room-only ones. */
export const abandonReasonSchema = z.enum(['stopped', 'grace_expired', 'expired']);
export type AbandonReason = z.infer<typeof abandonReasonSchema>;

/** Where a session runs. Solo only in Phase 4B (E4). */
export const focusSessionContextSchema = z.object({ kind: z.literal('solo') });
export type FocusSessionContext = z.infer<typeof focusSessionContextSchema>;

/**
 * The task a session was started with. Unlike the task routes, a session keeps showing
 * its task after the task is soft-deleted (D38), marked `deleted`.
 */
export const focusSessionTaskSchema = z.object({
  id: taskIdSchema,
  title: z.string().min(1).max(TASK_TITLE_MAX_LENGTH),
  deleted: z.boolean(),
});
export type FocusSessionTask = z.infer<typeof focusSessionTaskSchema>;

const focusSessionViewBase = {
  id: focusSessionIdSchema,
  context: focusSessionContextSchema,
  task: focusSessionTaskSchema.nullable(),
  plannedSeconds: plannedSecondsSchema,
  /** Accumulated before the current running stretch (D6); whole seconds. */
  focusedSeconds: z.number().int().nonnegative(),
  startedAt: z.iso.datetime(),
};

/**
 * A focus session as the API returns it. The lifecycle is a discriminated union, so an
 * in-progress session with an end time, or an abandoned one without a reason, cannot
 * be represented. `runningSince` is `null` while the session is paused.
 */
export const focusSessionViewSchema = z.discriminatedUnion('status', [
  z.object({
    ...focusSessionViewBase,
    status: z.literal('in_progress'),
    runningSince: z.iso.datetime().nullable(),
  }),
  z.object({ ...focusSessionViewBase, status: z.literal('completed'), endedAt: z.iso.datetime() }),
  z.object({
    ...focusSessionViewBase,
    status: z.literal('abandoned'),
    endedAt: z.iso.datetime(),
    abandonReason: abandonReasonSchema,
  }),
]);
export type FocusSessionView = z.infer<typeof focusSessionViewSchema>;

// Inbound schemas are strict: unknown keys (for example a `userId`) are rejected
// (docs/architecture/contracts.md, rule 7).

/**
 * `POST /focus-sessions`. `taskId` is optional; the server never fills in the user's
 * current task (E3).
 */
export const startFocusSessionRequestSchema = z.strictObject({
  plannedSeconds: plannedSecondsSchema,
  taskId: taskIdSchema.optional(),
});
export type StartFocusSessionRequest = z.infer<typeof startFocusSessionRequestSchema>;

/** Path parameters of every `/focus-sessions/:sessionId/…` route. */
export const focusSessionParamsSchema = z.strictObject({ sessionId: focusSessionIdSchema });
export type FocusSessionParams = z.infer<typeof focusSessionParamsSchema>;

/** `201` from start; `200` from pause, resume and stop (repeats included, E11). */
export const focusSessionResponseSchema = z.object({ session: focusSessionViewSchema });
export type FocusSessionResponse = z.infer<typeof focusSessionResponseSchema>;

export const startFocusSessionResponseSchema = focusSessionResponseSchema;
export type StartFocusSessionResponse = FocusSessionResponse;
export const pauseFocusSessionResponseSchema = focusSessionResponseSchema;
export type PauseFocusSessionResponse = FocusSessionResponse;
export const resumeFocusSessionResponseSchema = focusSessionResponseSchema;
export type ResumeFocusSessionResponse = FocusSessionResponse;
export const stopFocusSessionResponseSchema = focusSessionResponseSchema;
export type StopFocusSessionResponse = FocusSessionResponse;

/** `GET /focus-sessions/current`: the in-progress session, or `null`. */
export const currentFocusSessionResponseSchema = z.object({
  session: focusSessionViewSchema.nullable(),
});
export type CurrentFocusSessionResponse = z.infer<typeof currentFocusSessionResponseSchema>;

/**
 * `details` of a `409 SESSION_IN_PROGRESS` error: the existing in-progress session, so a
 * retried start can recover it.
 */
export const sessionInProgressDetailsSchema = z.object({ session: focusSessionViewSchema });
export type SessionInProgressDetails = z.infer<typeof sessionInProgressDetailsSchema>;
