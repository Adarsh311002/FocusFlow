import {
  type CreateGoalRequest,
  GOALS_MAX,
  type GoalStatus,
  type GoalView,
  goalViewSchema,
  type UpdateGoalRequest,
} from '@focus-flow/contracts';
import { and, count, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import type { Db, Executor } from '../../db/client.js';
import { focusSessions, goals, tasks, users } from '../../db/schema.js';
import { AppError } from '../../platform/http/errors.js';

// Goals (GL1–GL4): PostgreSQL only, the caller's own. Another user's and an unknown goal
// answer the same 404 GOAL_NOT_FOUND.

export type GoalsDeps = { readonly db: Db };

type GoalRow = typeof goals.$inferSelect;

const notFound = (): AppError => new AppError('GOAL_NOT_FOUND', 404, 'Goal not found.');

const statusOf = (row: GoalRow): GoalStatus =>
  row.archivedAt !== null ? 'archived' : row.completedAt !== null ? 'completed' : 'active';

/** GL3: the goals' live tasks (open and completed) and the focus spent on them. */
const progressOf = async (db: Executor, userId: string, goalIds: readonly string[]) => {
  if (goalIds.length === 0) {
    return new Map<string, GoalView['progress']>();
  }
  const [taskCounts, focus] = await Promise.all([
    db
      .select({
        goalId: tasks.goalId,
        open: sql`count(*) FILTER (WHERE ${tasks.completedAt} IS NULL)`.mapWith(Number),
        completed: sql`count(*) FILTER (WHERE ${tasks.completedAt} IS NOT NULL)`.mapWith(Number),
      })
      .from(tasks)
      .where(
        and(eq(tasks.userId, userId), inArray(tasks.goalId, [...goalIds]), isNull(tasks.deletedAt)),
      )
      .groupBy(tasks.goalId),
    db
      .select({
        goalId: tasks.goalId,
        seconds: sql`coalesce(sum(${focusSessions.focusedSeconds}), 0)`.mapWith(Number),
      })
      .from(focusSessions)
      .innerJoin(
        tasks,
        and(eq(tasks.id, focusSessions.taskId), eq(tasks.userId, focusSessions.userId)),
      )
      .where(
        and(
          eq(focusSessions.userId, userId),
          inArray(tasks.goalId, [...goalIds]),
          ne(focusSessions.status, 'in_progress'),
        ),
      )
      .groupBy(tasks.goalId),
  ]);
  return new Map(
    goalIds.map((goalId) => {
      const counted = taskCounts.find((row) => row.goalId === goalId);
      return [
        goalId,
        {
          openTasks: counted?.open ?? 0,
          completedTasks: counted?.completed ?? 0,
          focusedSeconds: focus.find((row) => row.goalId === goalId)?.seconds ?? 0,
        },
      ];
    }),
  );
};

const toViews = async (db: Executor, userId: string, rows: readonly GoalRow[]) => {
  const progress = await progressOf(
    db,
    userId,
    rows.map((row) => row.id),
  );
  return rows.map((row) =>
    goalViewSchema.parse({
      id: row.id,
      title: row.title,
      why: row.why,
      targetDate: row.targetDate,
      color: row.color,
      status: statusOf(row),
      createdAt: row.createdAt.toISOString(),
      endedAt: (row.archivedAt ?? row.completedAt)?.toISOString() ?? null,
      progress: progress.get(row.id),
    }),
  );
};

/** Active goals first, then completed; newest first within each (UUIDv7). */
export const listGoals = async (
  deps: GoalsDeps,
  userId: string,
  includeArchived: boolean,
): Promise<GoalView[]> => {
  const rows = await deps.db
    .select()
    .from(goals)
    .where(and(eq(goals.userId, userId), includeArchived ? undefined : isNull(goals.archivedAt)))
    .orderBy(desc(goals.id));
  const rank = (row: GoalRow) =>
    statusOf(row) === 'active' ? 0 : statusOf(row) === 'completed' ? 1 : 2;
  return toViews(
    deps.db,
    userId,
    [...rows].sort((a, b) => rank(a) - rank(b)),
  );
};

/** GL3: at most GOALS_MAX active and completed goals, checked under the user's row lock. */
export const createGoal = (
  deps: GoalsDeps,
  userId: string,
  input: {
    readonly title: string;
    readonly why?: string | null | undefined;
    readonly targetDate?: string | undefined;
    readonly color?: CreateGoalRequest['color'];
  },
): Promise<GoalView> =>
  deps.db.transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
    const [held] = await tx
      .select({ total: count() })
      .from(goals)
      .where(and(eq(goals.userId, userId), isNull(goals.archivedAt)));
    if ((held?.total ?? 0) >= GOALS_MAX) {
      throw new AppError('GOALS_FULL', 409, 'You have many goals. Complete or archive some first.');
    }
    const [row] = await tx
      .insert(goals)
      .values({
        id: uuidv7(),
        userId,
        title: input.title,
        why: input.why ?? null,
        targetDate: input.targetDate ?? null,
        color: input.color ?? 'leaf',
      })
      .returning();
    if (row === undefined) {
      throw new Error('createGoal: insert returned no row');
    }
    const [view] = await toViews(tx, userId, [row]);
    if (view === undefined) {
      throw new Error('createGoal: no view');
    }
    return view;
  });

/**
 * GL3: changes the given fields. `status` moves between active, completed and archived;
 * its tasks keep their goal whatever the status (they stay part of its history).
 */
export const updateGoal = async (
  deps: GoalsDeps,
  userId: string,
  goalId: string,
  input: {
    readonly title?: string | undefined;
    readonly why?: string | null | undefined;
    readonly targetDate?: string | null | undefined;
    readonly color?: UpdateGoalRequest['color'];
    readonly status?: GoalStatus | undefined;
  },
): Promise<GoalView> => {
  const now = sql`now()`;
  const [row] = await deps.db
    .update(goals)
    .set({
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.why === undefined ? {} : { why: input.why }),
      ...(input.targetDate === undefined ? {} : { targetDate: input.targetDate }),
      ...(input.color === undefined ? {} : { color: input.color }),
      ...(input.status === undefined
        ? {}
        : input.status === 'active'
          ? { completedAt: null, archivedAt: null }
          : input.status === 'completed'
            ? { completedAt: sql`coalesce(${goals.completedAt}, ${now})`, archivedAt: null }
            : { archivedAt: sql`coalesce(${goals.archivedAt}, ${now})`, completedAt: null }),
    })
    .where(and(eq(goals.id, goalId), eq(goals.userId, userId)))
    .returning();
  if (row === undefined) {
    throw notFound();
  }
  const [view] = await toViews(deps.db, userId, [row]);
  if (view === undefined) {
    throw new Error('updateGoal: no view');
  }
  return view;
};
