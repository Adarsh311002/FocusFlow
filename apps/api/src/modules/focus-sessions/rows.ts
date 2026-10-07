import { abandonReasonSchema, focusSessionStatusSchema } from '@focus-flow/contracts';

import type { FocusSessionRow, SessionChanges } from './queries.js';
import type { SoloSession } from './timing.js';

// The bridge between the stored row and the pure timing model. Values are validated as
// they are read: a row that breaks the model (which the CHECK constraints should make
// impossible) is a server bug and surfaces as a 500, never as a guess.

const requireTime = (value: Date | null, column: string, sessionId: string): number => {
  if (value === null) {
    throw new Error(`focus session ${sessionId}: ${column} is unexpectedly NULL`);
  }
  return value.getTime();
};

export const toSoloSession = (row: FocusSessionRow): SoloSession => {
  const base = {
    plannedSeconds: row.plannedSeconds,
    focusedSeconds: row.focusedSeconds,
    startedAtMs: row.startedAt.getTime(),
  };
  const status = focusSessionStatusSchema.parse(row.status);
  switch (status) {
    case 'in_progress':
      return {
        ...base,
        status,
        runningSinceMs: row.runningSince === null ? null : row.runningSince.getTime(),
      };
    case 'completed':
      return {
        ...base,
        status,
        runningSinceMs: null,
        endedAtMs: requireTime(row.endedAt, 'ended_at', row.id),
      };
    case 'abandoned':
      return {
        ...base,
        status,
        runningSinceMs: null,
        endedAtMs: requireTime(row.endedAt, 'ended_at', row.id),
        abandonReason: abandonReasonSchema.parse(row.abandonReason),
      };
  }
};

/** The columns a transition writes. `plannedSeconds` and `startedAt` never change. */
export const toSessionChanges = (session: SoloSession): SessionChanges => ({
  status: session.status,
  abandonReason: session.status === 'abandoned' ? session.abandonReason : null,
  focusedSeconds: session.focusedSeconds,
  runningSince: session.runningSinceMs === null ? null : new Date(session.runningSinceMs),
  endedAt: session.status === 'in_progress' ? null : new Date(session.endedAtMs),
});
