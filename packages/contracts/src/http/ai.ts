import { z } from 'zod';

import { calendarDateSchema, timeZoneSchema } from '../dates';
import { taskIdSchema } from '../ids';
import { checkInOutcomeSchema } from './focus-sessions';
import { weekStartSchema } from './weekly-priorities';

// AI features (Wave 5, AI1–AI8 in docs/decisions/decision-log.md): "Help me start" turns a
// task into a first step, and the weekly reflection reads one week back. Node owns the
// public API, the `ai_jobs` table and the queue; the Python service (services/ai) owns the
// prompts, the model call and checking the answer. Inbound schemas are strict.

export const AI_STEP_MAX_LENGTH = 140;
export const AI_STEPS_MAX = 5;
export const AI_LINE_MAX_LENGTH = 220;
export const AI_LIST_MAX = 3;

export const aiJobKindSchema = z.enum(['first_step', 'weekly_reflection']);
export type AiJobKind = z.infer<typeof aiJobKindSchema>;

export const aiJobStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed']);
export type AiJobStatus = z.infer<typeof aiJobStatusSchema>;

/** AI5: why a job failed. `unavailable` and `timed_out` are worth trying again later. */
export const aiFailureSchema = z.enum(['unavailable', 'declined', 'invalid_output', 'timed_out']);
export type AiFailure = z.infer<typeof aiFailureSchema>;

/** Who wrote a result: a real model, or the mock provider used when none is configured. */
export const aiSourceSchema = z.enum(['model', 'mock']);
export type AiSource = z.infer<typeof aiSourceSchema>;

const line = z.string().min(1).max(AI_LINE_MAX_LENGTH);

export const firstStepResultSchema = z.object({
  firstStep: z.string().min(1).max(AI_STEP_MAX_LENGTH),
  steps: z.array(z.string().min(1).max(AI_STEP_MAX_LENGTH)).min(1).max(AI_STEPS_MAX),
  encouragement: line,
});
export type FirstStepResult = z.infer<typeof firstStepResultSchema>;

export const weeklyReflectionResultSchema = z.object({
  headline: line,
  wins: z.array(line).max(AI_LIST_MAX),
  patterns: z.array(line).max(AI_LIST_MAX),
  suggestion: line,
});
export type WeeklyReflectionResult = z.infer<typeof weeklyReflectionResultSchema>;

const jobBase = {
  id: z.uuid(),
  status: aiJobStatusSchema,
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  failure: aiFailureSchema.nullable(),
  source: aiSourceSchema.nullable(),
};

export const aiJobViewSchema = z.discriminatedUnion('kind', [
  z.object({
    ...jobBase,
    kind: z.literal('first_step'),
    taskId: taskIdSchema,
    result: firstStepResultSchema.nullable(),
  }),
  z.object({
    ...jobBase,
    kind: z.literal('weekly_reflection'),
    weekStart: calendarDateSchema,
    result: weeklyReflectionResultSchema.nullable(),
  }),
]);
export type AiJobView = z.infer<typeof aiJobViewSchema>;

// ---- Public API (AI2) ---------------------------------------------------------------------

/** `POST /ai/first-step`. */
export const createFirstStepRequestSchema = z.strictObject({ taskId: taskIdSchema });
export type CreateFirstStepRequest = z.infer<typeof createFirstStepRequestSchema>;

/** `POST /ai/weekly-reflection`: `week` is the local Monday (WR3), `tz` the user's zone. */
export const createWeeklyReflectionRequestSchema = z.strictObject({
  week: weekStartSchema,
  tz: timeZoneSchema,
});
export type CreateWeeklyReflectionRequest = z.infer<typeof createWeeklyReflectionRequestSchema>;

export const aiJobParamsSchema = z.strictObject({ jobId: z.uuid() });
export const weeklyReflectionQuerySchema = z.strictObject({ week: weekStartSchema });

/** `202` for a new job, `200` when one of that kind was already under way (AI3). */
export const aiJobResponseSchema = z.object({ job: aiJobViewSchema });
export type AiJobResponse = z.infer<typeof aiJobResponseSchema>;

/** `GET /ai/weekly-reflection?week=`: the newest reflection asked for that week, if any. */
export const weeklyReflectionResponseSchema = z.object({ job: aiJobViewSchema.nullable() });
export type WeeklyReflectionResponse = z.infer<typeof weeklyReflectionResponseSchema>;

// ---- Node → Python (AI4) ------------------------------------------------------------------
// Bounded context Node assembles from PostgreSQL. Mirrors services/ai/app/schemas.py.

export const aiFirstStepInputSchema = z.strictObject({
  task: z.strictObject({
    title: z.string().min(1).max(200),
    goal: z.string().min(1).max(120).nullable(),
    estimatedSessions: z.number().int().min(1).max(20).nullable(),
    sessionsSpent: z.number().int().nonnegative(),
    steps: z
      .array(z.strictObject({ title: z.string().min(1).max(200), done: z.boolean() }))
      .max(30),
  }),
  recentCheckIns: z
    .array(z.strictObject({ outcome: checkInOutcomeSchema, note: z.string().max(280).nullable() }))
    .max(5),
});
export type AiFirstStepInput = z.infer<typeof aiFirstStepInputSchema>;

export const AI_REFLECTION_NOTES_MAX = 20;

export const aiWeeklyInputSchema = z.strictObject({
  weekStart: calendarDateSchema,
  days: z
    .array(
      z.strictObject({
        date: calendarDateSchema,
        focusedSeconds: z.number().int().nonnegative(),
        completedSessions: z.number().int().nonnegative(),
      }),
    )
    .length(7),
  totals: z.strictObject({
    focusedSeconds: z.number().int().nonnegative(),
    completedSessions: z.number().int().nonnegative(),
    intentionsDone: z.number().int().nonnegative(),
    stuck: z.number().int().nonnegative(),
  }),
  dailyGoalSeconds: z.number().int().nonnegative(),
  currentStreak: z.number().int().nonnegative(),
  notes: z.array(z.string().min(1).max(280)).max(AI_REFLECTION_NOTES_MAX),
  priorities: z
    .array(z.strictObject({ title: z.string().min(1).max(200), done: z.boolean() }))
    .max(3),
  topTasks: z
    .array(
      z.strictObject({
        title: z.string().min(1).max(200),
        focusedSeconds: z.number().int().nonnegative(),
      }),
    )
    .max(5),
  deepestHours: z.array(z.number().int().min(0).max(23)).max(3),
});
export type AiWeeklyInput = z.infer<typeof aiWeeklyInputSchema>;

/** What the Python service answers on success. */
export const aiServiceAnswerSchema = z.object({ source: aiSourceSchema, result: z.unknown() });

/** What it answers on failure (HTTP 4xx/5xx). */
export const aiServiceErrorSchema = z.object({
  code: z.enum(['declined', 'invalid_output', 'unavailable', 'provider_error', 'unauthorized']),
  message: z.string(),
});
