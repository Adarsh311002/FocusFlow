import type { ForestResponse } from '@focus-flow/contracts';
import { and, eq, isNotNull, ne } from 'drizzle-orm';

import type { Db } from '../../db/client.js';
import { focusSessions } from '../../db/schema.js';
import { findDailyGoalSeconds } from '../focus-sessions/review-queries.js';
import { buildForest, type ForestSession } from './build.js';

// GF5: one read of the user's ended sessions (all history, the columns the forest needs) and
// the goal; the rest is the pure builder. Read-only, PostgreSQL only, the caller's own.

export type ForestDeps = {
  readonly db: Db;
  /** The clock for "today"; tests inject it. */
  readonly nowMs?: () => number;
};

export const getForest = async (
  deps: ForestDeps,
  userId: string,
  tz: string,
): Promise<ForestResponse> => {
  const [rows, dailyGoalSeconds] = await Promise.all([
    deps.db
      .select({
        id: focusSessions.id,
        startedAt: focusSessions.startedAt,
        endedAt: focusSessions.endedAt,
        status: focusSessions.status,
        plannedSeconds: focusSessions.plannedSeconds,
        focusedSeconds: focusSessions.focusedSeconds,
        roomId: focusSessions.roomId,
        outcome: focusSessions.checkInOutcome,
        quality: focusSessions.checkInQuality,
      })
      .from(focusSessions)
      .where(
        and(
          eq(focusSessions.userId, userId),
          ne(focusSessions.status, 'in_progress'),
          isNotNull(focusSessions.endedAt),
        ),
      ),
    findDailyGoalSeconds(deps.db, userId),
  ]);
  const sessions: ForestSession[] = rows.map((row) => ({
    id: row.id,
    startedAtMs: row.startedAt.getTime(),
    endedAtMs: row.endedAt?.getTime() ?? row.startedAt.getTime(),
    status: row.status === 'completed' ? 'completed' : 'abandoned',
    plannedSeconds: row.plannedSeconds,
    focusedSeconds: row.focusedSeconds,
    isRoom: row.roomId !== null,
    outcome:
      row.outcome === 'done' || row.outcome === 'progress' || row.outcome === 'stuck'
        ? row.outcome
        : null,
    quality: row.quality,
  }));
  return buildForest({ sessions, tz, dailyGoalSeconds, nowMs: (deps.nowMs ?? Date.now)() });
};
