import {
  addCalendarDays,
  AI_REFLECTION_NOTES_MAX,
  type AiFirstStepInput,
  aiFirstStepInputSchema,
  type AiWeeklyInput,
  aiWeeklyInputSchema,
  type CheckInOutcome,
  createCalendarDateFormatter,
} from '@focus-flow/contracts';
import { and, asc, desc, eq, gte, isNotNull, lt } from 'drizzle-orm';

import type { Executor } from '../../db/client.js';
import { focusSessions, goals, tasks, taskSteps, weeklyPriorities } from '../../db/schema.js';
import { getFocusInsights } from '../focus-sessions/review.js';
import { findTaskExtras } from '../tasks/queries.js';

// AI4 (resolves D28): Node, which owns PostgreSQL, assembles a small, bounded context for
// each job and sends it in the request. The Python service holds no database credentials
// and never reads anything on its own. Only what the feature needs is sent: titles, steps,
// counts and the user's own check-in notes, never e-mail addresses or other people's data.

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

const DAY_MS = 86_400_000;

export const firstStepInput = async (
  db: Executor,
  userId: string,
  taskId: string,
): Promise<AiFirstStepInput> => {
  const [task] = await db
    .select({ title: tasks.title, estimatedSessions: tasks.estimatedSessions, goal: goals.title })
    .from(tasks)
    .leftJoin(goals, and(eq(goals.id, tasks.goalId), eq(goals.userId, tasks.userId)))
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)));
  if (task === undefined) {
    throw new Error('the job names a task the user does not have');
  }
  const [steps, checkIns, extras] = await Promise.all([
    db
      .select({ title: taskSteps.title, doneAt: taskSteps.doneAt })
      .from(taskSteps)
      .where(and(eq(taskSteps.taskId, taskId), eq(taskSteps.userId, userId)))
      .orderBy(asc(taskSteps.createdAt), asc(taskSteps.id))
      .limit(30),
    db
      .select({ outcome: focusSessions.checkInOutcome, note: focusSessions.checkInNote })
      .from(focusSessions)
      .where(
        and(
          eq(focusSessions.userId, userId),
          eq(focusSessions.taskId, taskId),
          isNotNull(focusSessions.checkInOutcome),
        ),
      )
      .orderBy(desc(focusSessions.checkedInAt))
      .limit(5),
    findTaskExtras(db, userId, [taskId]),
  ]);
  return aiFirstStepInputSchema.parse({
    task: {
      title: task.title,
      goal: task.goal === null ? null : clip(task.goal, 120),
      estimatedSessions: task.estimatedSessions,
      sessionsSpent: extras.get(taskId)?.sessionsSpent ?? 0,
      steps: steps.map((step) => ({ title: step.title, done: step.doneAt !== null })),
    },
    recentCheckIns: checkIns.map((row) => ({
      outcome: row.outcome as CheckInOutcome,
      note: row.note,
    })),
  });
};

export const weeklyInput = async (
  db: Executor,
  userId: string,
  weekStart: string,
  tz: string,
): Promise<AiWeeklyInput> => {
  const weekEnd = addCalendarDays(weekStart, 6);
  const localDateOf = createCalendarDateFormatter(tz);
  const fromMs = Date.parse(`${weekStart}T00:00:00Z`) - 2 * DAY_MS;
  const toMs = Date.parse(`${weekEnd}T00:00:00Z`) + 3 * DAY_MS;

  const [insights, noteRows, priorities] = await Promise.all([
    getFocusInsights({ db }, userId, { from: weekStart, to: weekEnd, tz }),
    db
      .select({ note: focusSessions.checkInNote, startedAt: focusSessions.startedAt })
      .from(focusSessions)
      .where(
        and(
          eq(focusSessions.userId, userId),
          isNotNull(focusSessions.checkInNote),
          gte(focusSessions.startedAt, new Date(fromMs)),
          lt(focusSessions.startedAt, new Date(toMs)),
        ),
      )
      .orderBy(desc(focusSessions.startedAt))
      .limit(100),
    db
      .select({ title: tasks.title, completedAt: tasks.completedAt, deletedAt: tasks.deletedAt })
      .from(weeklyPriorities)
      .innerJoin(
        tasks,
        and(eq(tasks.id, weeklyPriorities.taskId), eq(tasks.userId, weeklyPriorities.userId)),
      )
      .where(and(eq(weeklyPriorities.userId, userId), eq(weeklyPriorities.weekStart, weekStart)))
      .orderBy(asc(weeklyPriorities.position)),
  ]);

  const notes = noteRows
    .filter((row) => {
      const date = localDateOf(row.startedAt.getTime());
      return date >= weekStart && date <= weekEnd;
    })
    .flatMap((row) => (row.note === null ? [] : [row.note]))
    .slice(0, AI_REFLECTION_NOTES_MAX);

  const deepestHours = insights.quality.byHour
    .map((hour, index) => ({ index, ...hour }))
    .filter((hour) => hour.ratedCount > 0 && hour.average !== null)
    .sort((a, b) => (b.average ?? 0) - (a.average ?? 0) || b.ratedCount - a.ratedCount)
    .slice(0, 3)
    .map((hour) => hour.index);

  return aiWeeklyInputSchema.parse({
    weekStart,
    days: insights.days.map((day) => ({
      date: day.date,
      focusedSeconds: day.totalFocusedSeconds,
      completedSessions: day.completedCount,
    })),
    totals: {
      focusedSeconds: insights.totals.totalFocusedSeconds,
      completedSessions: insights.totals.completedCount,
      intentionsDone: insights.checkIns.done,
      stuck: insights.checkIns.stuck,
    },
    dailyGoalSeconds: insights.dailyGoalSeconds,
    currentStreak: insights.streak.current,
    notes,
    priorities: priorities
      .filter((row) => row.deletedAt === null)
      .map((row) => ({ title: row.title, done: row.completedAt !== null })),
    topTasks: insights.tasks
      .filter((task) => !task.deleted)
      .slice(0, 5)
      .map((task) => ({ title: task.title, focusedSeconds: task.totalFocusedSeconds })),
    deepestHours,
  });
};
