import type { Tx } from '../../db/client.js';
import { databaseNowMs, type FocusSessionRow, saveSession } from '../focus-sessions/queries.js';
import type { Settlement } from './types.js';

// The PostgreSQL side of every room session outcome (RF5, RF6). The caller has locked the
// row (`lockRoomSession`, `FOR UPDATE`); nothing here reads Redis. An outcome is written
// only to a row that is still `in_progress`, so a duplicate, a concurrent worker and a
// settlement repeated after a crash all end the same way: the first writer wins and the
// others see an ended row and change nothing.

/**
 * Applies a settlement to the locked row. Returns the saved row, or `undefined` when the
 * row already ended (or the settlement is `wait_for_grace`, which writes nothing).
 *
 * `ended_at` is the Redis instant of the event clamped into `[started_at, PostgreSQL now]`
 * (RF5), so stored timestamps stay ordered even when the two clocks disagree slightly.
 */
export const applySettlement = async (
  tx: Tx,
  row: FocusSessionRow,
  settlement: Settlement,
): Promise<FocusSessionRow | undefined> => {
  if (row.status !== 'in_progress' || settlement.kind === 'wait_for_grace') {
    return undefined;
  }
  const nowMs = await databaseNowMs(tx);
  const startedAtMs = row.startedAt.getTime();
  const endedAtMs = Math.max(
    startedAtMs,
    Math.min(settlement.endedAtMs, Math.max(nowMs, startedAtMs)),
  );
  if (settlement.kind === 'complete') {
    return saveSession(tx, row.id, {
      status: 'completed',
      abandonReason: null,
      focusedSeconds: row.plannedSeconds,
      runningSince: null,
      endedAt: new Date(endedAtMs),
    });
  }
  return saveSession(tx, row.id, {
    status: 'abandoned',
    abandonReason: settlement.reason,
    focusedSeconds: Math.min(Math.max(0, settlement.focusedSeconds), row.plannedSeconds),
    runningSince: null,
    endedAt: new Date(endedAtMs),
  });
};
