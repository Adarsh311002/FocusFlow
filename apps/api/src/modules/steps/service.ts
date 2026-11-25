import { TASK_STEPS_MAX, type TaskStepView, taskStepViewSchema } from '@focus-flow/contracts';
import { and, asc, count, eq, isNull } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import type { Db, Executor } from '../../db/client.js';
import { tasks, taskSteps } from '../../db/schema.js';
import { AppError } from '../../platform/http/errors.js';

// Steps (SP1–SP2): a checklist inside a task, PostgreSQL only. The task must be the caller's
// own and not deleted (else 404 TASK_NOT_FOUND, like every task route); an unknown step of a
// real task is 404 NOT_FOUND.

export type StepsDeps = { readonly db: Db };

type StepRow = typeof taskSteps.$inferSelect;

const toView = (row: StepRow): TaskStepView =>
  taskStepViewSchema.parse({
    id: row.id,
    title: row.title,
    done: row.doneAt !== null,
    createdAt: row.createdAt.toISOString(),
  });

/** The live task, or 404 TASK_NOT_FOUND. `lock` holds its row for the transaction. */
const requireTask = async (
  db: Executor,
  userId: string,
  taskId: string,
  lock: boolean,
): Promise<void> => {
  const query = db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId), isNull(tasks.deletedAt)))
    .limit(1);
  const [row] = lock ? await query.for('update') : await query;
  if (row === undefined) {
    throw new AppError('TASK_NOT_FOUND', 404, 'Task not found.');
  }
};

const stepOf = (userId: string, taskId: string, stepId: string) =>
  and(eq(taskSteps.id, stepId), eq(taskSteps.taskId, taskId), eq(taskSteps.userId, userId));

const stepNotFound = (): AppError => new AppError('NOT_FOUND', 404, 'Step not found.');

export const listSteps = async (
  deps: StepsDeps,
  userId: string,
  taskId: string,
): Promise<TaskStepView[]> => {
  await requireTask(deps.db, userId, taskId, false);
  const rows = await deps.db
    .select()
    .from(taskSteps)
    .where(and(eq(taskSteps.taskId, taskId), eq(taskSteps.userId, userId)))
    .orderBy(asc(taskSteps.id));
  return rows.map(toView);
};

/** At most TASK_STEPS_MAX per task (`409 STEPS_FULL`), counted while the task is locked. */
export const addStep = (
  deps: StepsDeps,
  userId: string,
  taskId: string,
  title: string,
): Promise<TaskStepView> =>
  deps.db.transaction(async (tx) => {
    await requireTask(tx, userId, taskId, true);
    const [held] = await tx
      .select({ total: count() })
      .from(taskSteps)
      .where(and(eq(taskSteps.taskId, taskId), eq(taskSteps.userId, userId)));
    if ((held?.total ?? 0) >= TASK_STEPS_MAX) {
      throw new AppError('STEPS_FULL', 409, 'A task can hold 30 steps.');
    }
    const [row] = await tx
      .insert(taskSteps)
      .values({ id: uuidv7(), taskId, userId, title })
      .returning();
    if (row === undefined) {
      throw new Error('addStep: insert returned no row');
    }
    return toView(row);
  });

export const updateStep = async (
  deps: StepsDeps,
  userId: string,
  taskId: string,
  stepId: string,
  changes: { readonly title?: string | undefined; readonly done?: boolean | undefined },
): Promise<TaskStepView> => {
  await requireTask(deps.db, userId, taskId, false);
  const [row] = await deps.db
    .update(taskSteps)
    .set({
      ...(changes.title === undefined ? {} : { title: changes.title }),
      ...(changes.done === undefined ? {} : { doneAt: changes.done ? new Date() : null }),
    })
    .where(stepOf(userId, taskId, stepId))
    .returning();
  if (row === undefined) {
    throw stepNotFound();
  }
  return toView(row);
};

export const removeStep = async (
  deps: StepsDeps,
  userId: string,
  taskId: string,
  stepId: string,
): Promise<void> => {
  await requireTask(deps.db, userId, taskId, false);
  const removed = await deps.db
    .delete(taskSteps)
    .where(stepOf(userId, taskId, stepId))
    .returning({ id: taskSteps.id });
  if (removed.length === 0) {
    throw stepNotFound();
  }
};
