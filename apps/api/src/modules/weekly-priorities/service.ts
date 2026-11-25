import {
  type WeeklyPrioritiesResponse,
  weeklyPrioritiesResponseSchema,
} from '@focus-flow/contracts';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import type { Db, Executor } from '../../db/client.js';
import { tasks, users, weeklyPriorities } from '../../db/schema.js';
import { AppError } from '../../platform/http/errors.js';

// Weekly priorities (WR1–WR3): PostgreSQL only, always the caller's own. A deleted task drops
// out of the list it was in (D38); a completed one stays, shown as completed.

export type WeeklyPrioritiesDeps = { readonly db: Db };

const read = async (
  db: Executor,
  userId: string,
  week: string,
): Promise<WeeklyPrioritiesResponse> => {
  const rows = await db
    .select({
      position: weeklyPriorities.position,
      taskId: tasks.id,
      title: tasks.title,
      completedAt: tasks.completedAt,
    })
    .from(weeklyPriorities)
    .innerJoin(
      tasks,
      and(eq(tasks.id, weeklyPriorities.taskId), eq(tasks.userId, weeklyPriorities.userId)),
    )
    .where(
      and(
        eq(weeklyPriorities.userId, userId),
        eq(weeklyPriorities.weekStart, week),
        isNull(tasks.deletedAt),
      ),
    )
    .orderBy(asc(weeklyPriorities.position));
  return weeklyPrioritiesResponseSchema.parse({
    week,
    priorities: rows.map((row) => ({
      position: row.position,
      task: {
        id: row.taskId,
        title: row.title,
        status: row.completedAt === null ? 'open' : 'completed',
      },
    })),
  });
};

export const getWeeklyPriorities = (
  deps: WeeklyPrioritiesDeps,
  userId: string,
  week: string,
): Promise<WeeklyPrioritiesResponse> => read(deps.db, userId, week);

/**
 * WR2: replaces the week's list, in order. Every task must be the caller's own and not
 * deleted (else `404 TASK_NOT_FOUND`); a task new to the list must be open (`409
 * TASK_NOT_OPEN`), while one already in it may have been completed since. The user row is
 * locked, so two saves of the same week queue instead of colliding on the unique indexes.
 */
export const setWeeklyPriorities = (
  deps: WeeklyPrioritiesDeps,
  userId: string,
  week: string,
  taskIds: readonly string[],
): Promise<WeeklyPrioritiesResponse> =>
  deps.db.transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
    const found =
      taskIds.length === 0
        ? []
        : await tx
            .select({ id: tasks.id, completedAt: tasks.completedAt })
            .from(tasks)
            .where(
              and(
                eq(tasks.userId, userId),
                inArray(tasks.id, [...taskIds]),
                isNull(tasks.deletedAt),
              ),
            )
            .for('share');
    if (found.length !== taskIds.length) {
      throw new AppError('TASK_NOT_FOUND', 404, 'Task not found.');
    }
    const kept = new Set(
      (
        await tx
          .select({ taskId: weeklyPriorities.taskId })
          .from(weeklyPriorities)
          .where(and(eq(weeklyPriorities.userId, userId), eq(weeklyPriorities.weekStart, week)))
      ).map((row) => row.taskId),
    );
    if (found.some((task) => task.completedAt !== null && !kept.has(task.id))) {
      throw new AppError('TASK_NOT_OPEN', 409, 'Only an open task can become a weekly priority.');
    }
    await tx
      .delete(weeklyPriorities)
      .where(and(eq(weeklyPriorities.userId, userId), eq(weeklyPriorities.weekStart, week)));
    if (taskIds.length > 0) {
      await tx.insert(weeklyPriorities).values(
        taskIds.map((taskId, index) => ({
          id: uuidv7(),
          userId,
          weekStart: week,
          position: index + 1,
          taskId,
        })),
      );
    }
    return read(tx, userId, week);
  });
