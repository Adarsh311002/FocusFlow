import { type TaskView, taskViewSchema } from '@focus-flow/contracts';

import type { TaskRow } from './queries.js';

/**
 * Persistence (`TaskRow`) never becomes the API response directly: every field is mapped
 * explicitly and the result is validated against the contract, so the branded id comes
 * from parsing rather than a cast. A row that fails (for example a deleted one reaching a
 * read path) is a server bug and surfaces as a 500. `deletedAt` and `userId` never leave
 * the API.
 */
export const toTaskView = (row: TaskRow): TaskView => {
  const base = {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  return taskViewSchema.parse(
    row.completedAt === null
      ? { ...base, status: 'open' }
      : { ...base, status: 'completed', completedAt: row.completedAt.toISOString() },
  );
};
