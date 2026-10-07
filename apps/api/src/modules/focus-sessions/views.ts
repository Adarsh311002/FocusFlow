import { type FocusSessionView, focusSessionViewSchema } from '@focus-flow/contracts';

import type { FocusSessionRow, SessionTaskRow } from './queries.js';

/**
 * Persistence never becomes the API response directly (F3): every field is mapped
 * explicitly and the result is validated against the contract, so branded ids come from
 * parsing rather than casts. `userId` never leaves the API; a task's `deletedAt` becomes
 * the `deleted` flag (D38).
 */
export const toFocusSessionView = (
  row: FocusSessionRow,
  task: SessionTaskRow | undefined,
): FocusSessionView => {
  const base = {
    id: row.id,
    context: { kind: 'solo' },
    task:
      task === undefined
        ? null
        : { id: task.id, title: task.title, deleted: task.deletedAt !== null },
    plannedSeconds: row.plannedSeconds,
    focusedSeconds: row.focusedSeconds,
    startedAt: row.startedAt.toISOString(),
  };
  switch (row.status) {
    case 'in_progress':
      return focusSessionViewSchema.parse({
        ...base,
        status: 'in_progress',
        runningSince: row.runningSince?.toISOString() ?? null,
      });
    case 'completed':
      return focusSessionViewSchema.parse({
        ...base,
        status: 'completed',
        endedAt: row.endedAt?.toISOString(),
      });
    default:
      return focusSessionViewSchema.parse({
        ...base,
        status: row.status,
        endedAt: row.endedAt?.toISOString(),
        abandonReason: row.abandonReason,
      });
  }
};
