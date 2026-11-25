import type { ListTasksQuery } from '@focus-flow/contracts';
import { uuidv7 } from 'uuidv7';

import type { Db, Executor } from '../../db/client.js';
import { AppError } from '../../platform/http/errors.js';
import type { UserRow } from '../auth/queries.js';
import { decodeTaskCursor, encodeTaskCursor } from './cursor.js';
import {
  clearCurrentTaskIfMatches,
  findLiveTask,
  findOwnedTaskIncludingDeleted,
  insertTask,
  listLiveTasks,
  lockGoalForShare,
  lockOwnedTaskForShare,
  markTaskCompleted,
  markTaskDeleted,
  markTaskOpen,
  setUserCurrentTask,
  type TaskRow,
  updateTaskFields,
} from './queries.js';

export type TasksDeps = {
  readonly db: Db;
};

/**
 * One answer for "not yours", "deleted" and "does not exist", so the API never reveals
 * whether another user's task id is real (docs/api/rest.md, "Ownership").
 */
const taskNotFound = (): AppError => new AppError('TASK_NOT_FOUND', 404, 'Task not found.');

const requireFound = (row: TaskRow | undefined): TaskRow => {
  if (row === undefined) {
    throw taskNotFound();
  }
  return row;
};

/** GL4: a goal a task is attached to must be the user's own and active (locked FOR SHARE). */
const requireActiveGoal = async (tx: Executor, userId: string, goalId: string): Promise<void> => {
  const goal = await lockGoalForShare(tx, userId, goalId);
  if (goal === undefined) {
    throw new AppError('GOAL_NOT_FOUND', 404, 'Goal not found.');
  }
  if (goal.completedAt !== null || goal.archivedAt !== null) {
    throw new AppError('GOAL_NOT_ACTIVE', 409, 'Only an active goal can take tasks.');
  }
};

export type TaskOptions = {
  readonly goalId?: string | undefined;
  readonly estimatedSessions?: number | undefined;
};

export const createTask = (
  deps: TasksDeps,
  userId: string,
  title: string,
  options: TaskOptions = {},
): Promise<TaskRow> =>
  options.goalId === undefined
    ? insertTask(deps.db, {
        id: uuidv7(),
        userId,
        title,
        estimatedSessions: options.estimatedSessions ?? null,
      })
    : deps.db.transaction(async (tx) => {
        await requireActiveGoal(tx, userId, options.goalId ?? '');
        return insertTask(tx, {
          id: uuidv7(),
          userId,
          title,
          goalId: options.goalId ?? null,
          estimatedSessions: options.estimatedSessions ?? null,
        });
      });

export const getTask = async (deps: TasksDeps, userId: string, taskId: string): Promise<TaskRow> =>
  requireFound(await findLiveTask(deps.db, userId, taskId));

export type TaskPage = {
  readonly tasks: readonly TaskRow[];
  readonly nextCursor: string | null;
};

export const listTasks = async (
  deps: TasksDeps,
  userId: string,
  query: ListTasksQuery,
): Promise<TaskPage> => {
  const afterId = query.cursor === undefined ? undefined : decodeTaskCursor(query.cursor);
  // One extra row tells whether another page exists without a separate COUNT.
  const rows = await listLiveTasks(
    deps.db,
    userId,
    query.status,
    afterId,
    query.limit + 1,
    query.goalId,
  );
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    tasks: page,
    nextCursor: rows.length > query.limit && last !== undefined ? encodeTaskCursor(last.id) : null,
  };
};

/**
 * Completed tasks may be changed too; deleted ones may not. A goal being attached must be
 * active (GL4); `null` detaches it or clears the estimate.
 */
export const updateTask = (
  deps: TasksDeps,
  userId: string,
  taskId: string,
  changes: {
    readonly title?: string | undefined;
    readonly goalId?: string | null | undefined;
    readonly estimatedSessions?: number | null | undefined;
  },
): Promise<TaskRow> =>
  deps.db.transaction(async (tx) => {
    if (changes.goalId !== undefined && changes.goalId !== null) {
      await requireActiveGoal(tx, userId, changes.goalId);
    }
    return requireFound(await updateTaskFields(tx, userId, taskId, changes));
  });

/**
 * Open → completed, and D43: if it was the user's current task, it stops being current in
 * the same transaction. Already completed → returned unchanged (keeping the original
 * completion time), so a retried request is harmless.
 *
 * Lock order is task row, then user row, the same as every other path that touches the
 * current task, so concurrent requests queue instead of deadlocking.
 */
export const completeTask = (deps: TasksDeps, userId: string, taskId: string): Promise<TaskRow> =>
  deps.db.transaction(async (tx) => {
    const completed = await markTaskCompleted(tx, userId, taskId);
    if (completed !== undefined) {
      await clearCurrentTaskIfMatches(tx, userId, taskId);
      return completed;
    }
    return requireFound(await findLiveTask(tx, userId, taskId));
  });

/** Completed → open. Never makes the task current again (D43). Already open → unchanged. */
export const reopenTask = async (
  deps: TasksDeps,
  userId: string,
  taskId: string,
): Promise<TaskRow> => {
  const reopened = await markTaskOpen(deps.db, userId, taskId);
  if (reopened !== undefined) {
    return reopened;
  }
  return requireFound(await findLiveTask(deps.db, userId, taskId));
};

/**
 * `PUT /me/current-task` (D3, D43). `null` clears it; otherwise the task must be the
 * user's own (TASK_NOT_FOUND for another user's, a deleted or a nonexistent task) and
 * open (TASK_NOT_OPEN). Setting the same task again is harmless.
 *
 * The task row is locked (FOR SHARE) before the user row is written — the same order as
 * complete/delete — so a concurrent complete or delete either waits and then clears this
 * choice, or wins first and makes this check fail. The current task can therefore never
 * end up pointing at a completed or deleted task.
 */
export const setCurrentTask = (
  deps: TasksDeps,
  userId: string,
  taskId: string | null,
): Promise<UserRow> =>
  deps.db.transaction(async (tx) => {
    if (taskId !== null) {
      const task = await lockOwnedTaskForShare(tx, userId, taskId);
      if (task === undefined || task.deletedAt !== null) {
        throw taskNotFound();
      }
      if (task.completedAt !== null) {
        throw new AppError('TASK_NOT_OPEN', 409, 'Only an open task can be the current task.');
      }
    }
    const user = await setUserCurrentTask(tx, userId, taskId);
    if (user === undefined) {
      // The authenticated user no longer exists; mirrors GET /me.
      throw new AppError('NOT_FOUND', 404, 'User not found.');
    }
    return user;
  });

/**
 * Soft delete (D38), clearing the current task in the same transaction if it pointed
 * here. Deleting one's own already-deleted task succeeds again (idempotent); another
 * user's task, or an id that never existed, is TASK_NOT_FOUND.
 */
export const deleteTask = (deps: TasksDeps, userId: string, taskId: string): Promise<void> =>
  deps.db.transaction(async (tx) => {
    const deleted = await markTaskDeleted(tx, userId, taskId);
    if (deleted !== undefined) {
      await clearCurrentTaskIfMatches(tx, userId, taskId);
      return;
    }
    requireFound(await findOwnedTaskIncludingDeleted(tx, userId, taskId));
  });
