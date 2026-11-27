import { type TaskView, taskViewSchema } from '@focus-flow/contracts';

import type { TaskRow } from './queries.js';

/**
 * Persistence (`TaskRow`) never becomes the API response directly: every field is mapped
 * explicitly and the result is validated against the contract, so the branded id comes
 * from parsing rather than a cast. A row that fails (for example a deleted one reaching a
 * read path) is a server bug and surfaces as a 500. `deletedAt` and `userId` never leave
 * the API.
 */
/** What a task's view adds from other tables (ES2, SP3); read in one batch for a page. */
export type TaskExtras = {
  readonly sessionsSpent: number;
  readonly steps: { readonly total: number; readonly done: number };
};

const NO_EXTRAS: TaskExtras = { sessionsSpent: 0, steps: { total: 0, done: 0 } };

export const toTaskView = (row: TaskRow, extras: TaskExtras = NO_EXTRAS): TaskView => {
  const base = {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    goalId: row.goalId,
    estimatedSessions: row.estimatedSessions,
    sessionsSpent: extras.sessionsSpent,
    steps: extras.steps,
  };
  return taskViewSchema.parse(
    row.completedAt === null
      ? { ...base, status: 'open' }
      : { ...base, status: 'completed', completedAt: row.completedAt.toISOString() },
  );
};
