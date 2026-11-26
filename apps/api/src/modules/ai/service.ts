import {
  type AiFailure,
  type AiJobKind,
  type AiJobView,
  aiJobViewSchema,
  createCalendarDateFormatter,
  firstStepResultSchema,
  weeklyReflectionResultSchema,
} from '@focus-flow/contracts';
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { uuidv7 } from 'uuidv7';

import type { Db, Executor } from '../../db/client.js';
import { isUniqueViolation } from '../../db/pg-errors.js';
import { aiJobs, tasks } from '../../db/schema.js';
import { AppError, appError } from '../../platform/http/errors.js';
import type { AiClient } from './client.js';
import { firstStepInput, weeklyInput } from './context.js';

// AI jobs (AI1–AI5). A request writes a `queued` row and then ensures its queue job; the
// worker claims the row, asks the Python service and writes the outcome. PostgreSQL is the
// record: the queue is only the wake-up. Two systems are written without an outbox, so
// every read repairs what a lost enqueue or a dead worker left behind (AI3).

/** AI3: a job still under way this long after it was asked for has failed (`timed_out`). */
export const AI_JOB_STALE_MS = 5 * 60_000;
/** AI3: a job still queued this long after it was asked for has its queue job ensured again. */
export const AI_JOB_REENSURE_MS = 20_000;

export type AiDeps = {
  readonly db: Db;
  /** Ensures the queue job of an `ai_jobs` row (idempotent, E20 semantics). */
  readonly schedule: (jobId: string) => Promise<unknown>;
  /** AI6: per-user quota of new jobs of a kind; false refuses with RATE_LIMITED. */
  readonly allow: (userId: string, kind: AiJobKind) => Promise<boolean>;
  readonly logger: Logger;
  readonly now?: () => number;
};

type Row = typeof aiJobs.$inferSelect;
const ACTIVE = ['queued', 'running'] as const;

export const toAiJobView = (row: Row): AiJobView => {
  const base = {
    id: row.id,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    failure: row.failure,
    source: row.source,
    result: row.status === 'succeeded' ? row.result : null,
  };
  return aiJobViewSchema.parse(
    row.kind === 'first_step'
      ? { ...base, kind: 'first_step', taskId: row.taskId }
      : { ...base, kind: 'weekly_reflection', weekStart: row.weekStart },
  );
};

/** AI3: a job the worker never finished fails, so it no longer blocks a new one. */
const expireStale = async (db: Executor, userId: string): Promise<void> => {
  await db
    .update(aiJobs)
    .set({ status: 'failed', failure: 'timed_out', finishedAt: sql`now()` })
    .where(
      and(
        eq(aiJobs.userId, userId),
        inArray(aiJobs.status, [...ACTIVE]),
        lt(aiJobs.createdAt, sql`now() - make_interval(secs => ${AI_JOB_STALE_MS / 1000})`),
      ),
    );
};

const findActive = async (db: Executor, userId: string, kind: AiJobKind) =>
  (
    await db
      .select()
      .from(aiJobs)
      .where(
        and(eq(aiJobs.userId, userId), eq(aiJobs.kind, kind), inArray(aiJobs.status, [...ACTIVE])),
      )
  )[0];

/** Re-ensures the queue job of a row that has waited too long (a lost enqueue). */
const repairQueued = (deps: AiDeps, row: Row): void => {
  const nowMs = (deps.now ?? Date.now)();
  if (row.status === 'queued' && nowMs - row.createdAt.getTime() >= AI_JOB_REENSURE_MS) {
    void deps.schedule(row.id).catch((error: unknown) => {
      deps.logger.warn({ err: error, jobId: row.id }, 'Could not re-ensure an AI job');
    });
  }
};

const ensure = async (deps: AiDeps, jobId: string): Promise<void> => {
  try {
    await deps.schedule(jobId);
  } catch (error) {
    // The row is committed; the next read of it re-ensures the queue job (AI3).
    deps.logger.warn({ err: error, jobId }, 'Could not enqueue an AI job');
  }
};

type Subject =
  | { readonly kind: 'first_step'; readonly taskId: string }
  | { readonly kind: 'weekly_reflection'; readonly weekStart: string; readonly tz: string };

const sameSubject = (row: Row, subject: Subject): boolean =>
  subject.kind === 'first_step'
    ? row.taskId === subject.taskId
    : row.weekStart === subject.weekStart;

const create = async (
  deps: AiDeps,
  userId: string,
  subject: Subject,
): Promise<{ job: AiJobView; created: boolean }> => {
  const { db } = deps;
  await expireStale(db, userId);
  const existing = async () => {
    const active = await findActive(db, userId, subject.kind);
    if (active === undefined) {
      return undefined;
    }
    if (!sameSubject(active, subject)) {
      throw new AppError('AI_JOB_BUSY', 409, 'Another request of this kind is still running.');
    }
    repairQueued(deps, active);
    return { job: toAiJobView(active), created: false };
  };

  const already = await existing();
  if (already !== undefined) {
    return already;
  }
  if (!(await deps.allow(userId, subject.kind))) {
    throw appError('RATE_LIMITED', 'That is enough AI help for now. Try again later.');
  }
  let row: Row | undefined;
  try {
    [row] = await db
      .insert(aiJobs)
      .values({
        id: uuidv7(),
        userId,
        kind: subject.kind,
        ...(subject.kind === 'first_step'
          ? { taskId: subject.taskId }
          : { weekStart: subject.weekStart, input: { tz: subject.tz } }),
      })
      .returning();
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
    // A parallel request of the same kind won the slot (AI3).
    const raced = await existing();
    if (raced !== undefined) {
      return raced;
    }
    throw error;
  }
  if (row === undefined) {
    throw new Error('insert returned no row');
  }
  await ensure(deps, row.id);
  return { job: toAiJobView(row), created: true };
};

/** `POST /ai/first-step` (AI2): only an open task of the caller's own. */
export const requestFirstStep = async (deps: AiDeps, userId: string, taskId: string) => {
  const [task] = await deps.db
    .select({ completedAt: tasks.completedAt })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId), isNull(tasks.deletedAt)));
  if (task === undefined) {
    throw new AppError('TASK_NOT_FOUND', 404, 'Task not found.');
  }
  if (task.completedAt !== null) {
    throw new AppError('TASK_NOT_OPEN', 409, 'This task is already done.');
  }
  return create(deps, userId, { kind: 'first_step', taskId });
};

/** `POST /ai/weekly-reflection` (AI2): this week (so far) or an earlier one. */
export const requestWeeklyReflection = async (
  deps: AiDeps,
  userId: string,
  week: string,
  tz: string,
) => {
  const today = createCalendarDateFormatter(tz)((deps.now ?? Date.now)());
  if (week > today) {
    throw appError('VALIDATION_FAILED', 'That week has not started yet.');
  }
  return create(deps, userId, { kind: 'weekly_reflection', weekStart: week, tz });
};

export const getAiJob = async (deps: AiDeps, userId: string, jobId: string) => {
  await expireStale(deps.db, userId);
  const [row] = await deps.db
    .select()
    .from(aiJobs)
    .where(and(eq(aiJobs.id, jobId), eq(aiJobs.userId, userId)));
  if (row === undefined) {
    throw new AppError('AI_JOB_NOT_FOUND', 404, 'AI request not found.');
  }
  repairQueued(deps, row);
  return toAiJobView(row);
};

/** The newest reflection asked for `week`, or null. */
export const getWeeklyReflection = async (deps: AiDeps, userId: string, week: string) => {
  await expireStale(deps.db, userId);
  const [row] = await deps.db
    .select()
    .from(aiJobs)
    .where(
      and(
        eq(aiJobs.userId, userId),
        eq(aiJobs.kind, 'weekly_reflection'),
        eq(aiJobs.weekStart, week),
      ),
    )
    .orderBy(desc(aiJobs.createdAt))
    .limit(1);
  if (row === undefined) {
    return null;
  }
  repairQueued(deps, row);
  return toAiJobView(row);
};

// ---- The worker side --------------------------------------------------------------------

export type AiRunDeps = { readonly db: Db; readonly client: AiClient; readonly logger: Logger };

/** Thrown to let the queue try the job again (the service or the model was unreachable). */
export class AiRetryLater extends Error {}

export type AiRunOutcome = 'skipped' | 'succeeded' | 'failed';

const finishFailed = async (db: Executor, jobId: string, failure: AiFailure) => {
  await db
    .update(aiJobs)
    .set({ status: 'failed', failure, finishedAt: sql`now()` })
    .where(and(eq(aiJobs.id, jobId), inArray(aiJobs.status, [...ACTIVE])));
};

export const markAiJobFailed = (deps: Pick<AiRunDeps, 'db'>, jobId: string, failure: AiFailure) =>
  finishFailed(deps.db, jobId, failure);

/**
 * Runs one job (AI3, AI5). `finalAttempt` says the queue will not try again: an
 * unreachable service then fails the job instead of asking for a retry.
 */
export const runAiJob = async (
  deps: AiRunDeps,
  jobId: string,
  finalAttempt: boolean,
): Promise<AiRunOutcome> => {
  const { db, client } = deps;
  const [row] = await db
    .update(aiJobs)
    .set({ status: 'running', startedAt: sql`coalesce(${aiJobs.startedAt}, now())` })
    .where(and(eq(aiJobs.id, jobId), inArray(aiJobs.status, [...ACTIVE])))
    .returning();
  if (row === undefined) {
    return 'skipped';
  }

  const outcome =
    row.kind === 'first_step'
      ? await client.firstStep(await firstStepInput(db, row.userId, row.taskId ?? ''))
      : await client.weeklyReflection(
          await weeklyInput(
            db,
            row.userId,
            row.weekStart ?? '',
            typeof row.input.tz === 'string' ? row.input.tz : 'UTC',
          ),
        );

  if (!outcome.ok) {
    if (outcome.retryable && !finalAttempt) {
      throw new AiRetryLater(`AI job ${jobId}: ${outcome.failure}, will retry`);
    }
    await finishFailed(db, jobId, outcome.failure);
    return 'failed';
  }
  const schema = row.kind === 'first_step' ? firstStepResultSchema : weeklyReflectionResultSchema;
  const result = schema.safeParse(outcome.result);
  if (!result.success) {
    deps.logger.warn(
      { jobId, issues: result.error.issues },
      'AI answer did not match the contract',
    );
    await finishFailed(db, jobId, 'invalid_output');
    return 'failed';
  }
  await db
    .update(aiJobs)
    .set({
      status: 'succeeded',
      result: result.data,
      source: outcome.source,
      finishedAt: sql`now()`,
    })
    .where(and(eq(aiJobs.id, jobId), eq(aiJobs.status, 'running')));
  return 'succeeded';
};
