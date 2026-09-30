import { and, desc, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';

import type { Executor } from '../../db/client.js';
import { tasks, users } from '../../db/schema.js';
import type { UserRow } from '../auth/queries.js';

export type TaskRow = typeof tasks.$inferSelect;

export type TaskListStatus = 'open' | 'completed';

// Every query here is scoped by BOTH the task id and the owning user id, so a task that
// belongs to someone else is indistinguishable from one that does not exist. "Live"
// means not soft-deleted (D38): only the delete path ever looks at deleted rows.

const ownedBy = (userId: string, taskId: string) =>
  and(eq(tasks.id, taskId), eq(tasks.userId, userId));

const liveOwnedBy = (userId: string, taskId: string) =>
  and(ownedBy(userId, taskId), isNull(tasks.deletedAt));

export type NewTask = { id: string; userId: string; title: string };

export const insertTask = async (db: Executor, values: NewTask): Promise<TaskRow> => {
  const [row] = await db.insert(tasks).values(values).returning();
  if (row === undefined) {
    throw new Error('insertTask: insert returned no row');
  }
  return row;
};

export const findLiveTask = async (
  db: Executor,
  userId: string,
  taskId: string,
): Promise<TaskRow | undefined> => {
  const [row] = await db.select().from(tasks).where(liveOwnedBy(userId, taskId)).limit(1);
  return row;
};

/** Includes soft-deleted rows; only for the delete path's "already deleted" answer. */
export const findOwnedTaskIncludingDeleted = async (
  db: Executor,
  userId: string,
  taskId: string,
): Promise<TaskRow | undefined> => {
  const [row] = await db.select().from(tasks).where(ownedBy(userId, taskId)).limit(1);
  return row;
};

/**
 * One page of the user's live tasks, newest-created first. UUIDv7 ids sort by creation
 * time, so `id DESC` is the order and `id < afterId` is the keyset condition, both served
 * by `ix_tasks_user_id_id`.
 */
export const listLiveTasks = async (
  db: Executor,
  userId: string,
  status: TaskListStatus,
  afterId: string | undefined,
  limit: number,
): Promise<TaskRow[]> => {
  return db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        isNull(tasks.deletedAt),
        status === 'open' ? isNull(tasks.completedAt) : isNotNull(tasks.completedAt),
        afterId === undefined ? undefined : lt(tasks.id, afterId),
      ),
    )
    .orderBy(desc(tasks.id))
    .limit(limit);
};

export const updateTaskTitle = async (
  db: Executor,
  userId: string,
  taskId: string,
  title: string,
): Promise<TaskRow | undefined> => {
  const [row] = await db
    .update(tasks)
    .set({ title })
    .where(liveOwnedBy(userId, taskId))
    .returning();
  return row;
};

/** Open → completed. Matches nothing if the task is already completed, deleted or not the user's. */
export const markTaskCompleted = async (
  db: Executor,
  userId: string,
  taskId: string,
): Promise<TaskRow | undefined> => {
  const [row] = await db
    .update(tasks)
    .set({ completedAt: sql`now()` })
    .where(and(liveOwnedBy(userId, taskId), isNull(tasks.completedAt)))
    .returning();
  return row;
};

/** Completed → open. Matches nothing if the task is already open, deleted or not the user's. */
export const markTaskOpen = async (
  db: Executor,
  userId: string,
  taskId: string,
): Promise<TaskRow | undefined> => {
  const [row] = await db
    .update(tasks)
    .set({ completedAt: null })
    .where(and(liveOwnedBy(userId, taskId), isNotNull(tasks.completedAt)))
    .returning();
  return row;
};

/** Soft delete (D38). Matches nothing if the task is already deleted or not the user's. */
export const markTaskDeleted = async (
  db: Executor,
  userId: string,
  taskId: string,
): Promise<TaskRow | undefined> => {
  const [row] = await db
    .update(tasks)
    .set({ deletedAt: sql`now()` })
    .where(liveOwnedBy(userId, taskId))
    .returning();
  return row;
};

/**
 * Reads the user's task (deleted or not) with a FOR SHARE row lock, for the current-task
 * check. The lock makes a concurrent complete/delete of the same task wait for this
 * transaction (and vice versa): under READ COMMITTED a locking read returns the latest
 * committed version, so the open / not-deleted check cannot act on a stale row.
 */
export const lockOwnedTaskForShare = async (
  db: Executor,
  userId: string,
  taskId: string,
): Promise<TaskRow | undefined> => {
  const [row] = await db.select().from(tasks).where(ownedBy(userId, taskId)).limit(1).for('share');
  return row;
};

export const setUserCurrentTask = async (
  db: Executor,
  userId: string,
  taskId: string | null,
): Promise<UserRow | undefined> => {
  const [row] = await db
    .update(users)
    .set({ currentTaskId: taskId })
    .where(eq(users.id, userId))
    .returning();
  return row;
};

/**
 * Conditional clear (D38, D43): only touches the user row if it still points at this
 * task, so it never overwrites a different current task chosen meanwhile.
 */
export const clearCurrentTaskIfMatches = async (
  db: Executor,
  userId: string,
  taskId: string,
): Promise<void> => {
  await db
    .update(users)
    .set({ currentTaskId: null })
    .where(and(eq(users.id, userId), eq(users.currentTaskId, taskId)));
};
