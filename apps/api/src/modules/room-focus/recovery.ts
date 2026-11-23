import type { FocusSessionView } from '@focus-flow/contracts';
import { and, asc, eq, gt, isNotNull, sql } from 'drizzle-orm';
import type { Logger } from 'pino';

import type { Db, Tx } from '../../db/client.js';
import { focusSessions } from '../../db/schema.js';
import { findSessionTask } from '../focus-sessions/queries.js';
import { toFocusSessionView } from '../focus-sessions/views.js';
import type { RoomFocusChange, RunLedger } from './types.js';

// Orphaned and lost room sessions (RF10, RF15; docs/architecture/focus-timing-protocol.md,
// "Redis state loss" and "Reconciler" step 7). A room session whose participant entry is gone
// from the Redis ledger can never be settled by a run, a grace job or a departure, so it is
// abandoned `timer_lost` with 0 focused seconds (D37 default) at the recovery time.
//
// Two callers share `abandonTimerLost`:
//  - the global recovery below (the SET NX winner of a new epoch: Redis lost its data), for
//    every room session whose ledger entry is missing and that is older than a few seconds;
//  - the reconciler's step 7, for the same sessions after ORPHAN_RECOVERY_MS (it also covers
//    a recovery that never ran, and an opt-in that crashed between PostgreSQL and Redis).
// Solo sessions (`room_id IS NULL`) are never selected. Every transition is one row-locked
// transaction that touches only a session still `in_progress`, so repeated and concurrent
// runs abandon each session exactly once and only the winner notifies.

/**
 * Global recovery leaves alone sessions younger than this: they may be an opt-in between its
 * PostgreSQL insert and its ledger add. The reconciler's orphan rule picks up any that remain.
 */
export const RECOVERY_SETTLE_MS = 10_000;
export const RECOVERY_BATCH_SIZE = 100;
const RECOVERY_STATEMENT_TIMEOUT_MS = 5_000;

export type RoomSessionKey = {
  readonly id: string;
  readonly userId: string;
  readonly roomId: string;
  readonly focusRunId: string;
  /** PostgreSQL clock: milliseconds since `started_at` at the time of the read. */
  readonly ageMs: number;
};

/**
 * One keyset page of in-progress ROOM sessions ordered by user (one in-progress session per
 * user, so `user_id` is a unique cursor). Nothing is locked.
 */
export const listInProgressRoomSessions = async (
  db: Db,
  page: { readonly afterUserId: string | null; readonly limit: number },
): Promise<RoomSessionKey[]> => {
  const rows = await db
    .select({
      id: focusSessions.id,
      userId: focusSessions.userId,
      roomId: focusSessions.roomId,
      focusRunId: focusSessions.focusRunId,
      ageMs: sql<number>`floor(extract(epoch from (clock_timestamp() - ${focusSessions.startedAt})) * 1000)::float8`,
    })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.status, 'in_progress'),
        isNotNull(focusSessions.roomId),
        isNotNull(focusSessions.focusRunId),
        page.afterUserId === null ? undefined : gt(focusSessions.userId, page.afterUserId),
      ),
    )
    .orderBy(asc(focusSessions.userId))
    .limit(page.limit);
  const keys: RoomSessionKey[] = [];
  for (const row of rows) {
    if (row.roomId !== null && row.focusRunId !== null) {
      keys.push({ ...row, roomId: row.roomId, focusRunId: row.focusRunId });
    }
  }
  return keys;
};

export type TimerLostOutcome =
  /** Abandoned now by this call; `session` is the committed view to announce. */
  | { readonly kind: 'abandoned'; readonly session: FocusSessionView; readonly roomId: string }
  /** Ended meanwhile, not a room session, too young, or held by another transaction. */
  | { readonly kind: 'skipped'; readonly reason: 'not_in_progress' | 'too_young' | 'locked' };

/**
 * Abandons one room session as `timer_lost` (`focused_seconds = 0`, `ended_at` = the
 * PostgreSQL clock now), only while it is still in progress, at least `minAgeMs` old (by
 * the PostgreSQL clock) and not locked by someone else (`SKIP LOCKED`: its holder decides).
 */
export const abandonTimerLost = async (
  db: Db,
  sessionId: string,
  minAgeMs: number,
): Promise<TimerLostOutcome> =>
  db.transaction(async (tx: Tx): Promise<TimerLostOutcome> => {
    await tx.execute(
      sql.raw(`SET LOCAL statement_timeout = ${String(RECOVERY_STATEMENT_TIMEOUT_MS)}`),
    );
    // Age first, without a lock: a young session is reported as such even while another
    // transaction (a concurrent sweep) holds its row, so "locked" always means "eligible".
    const [peek] = await tx
      .select({
        id: focusSessions.id,
        status: focusSessions.status,
        roomId: focusSessions.roomId,
        tooYoung: sql<boolean>`${focusSessions.startedAt} > clock_timestamp() - ${String(Math.trunc(minAgeMs))}::float8 * interval '1 millisecond'`,
      })
      .from(focusSessions)
      .where(eq(focusSessions.id, sessionId))
      .limit(1);
    if (peek?.status === 'in_progress' && peek.roomId !== null && peek.tooYoung) {
      return { kind: 'skipped', reason: 'too_young' };
    }
    const [row] = await tx
      .select({
        id: focusSessions.id,
        status: focusSessions.status,
        roomId: focusSessions.roomId,
        tooYoung: sql<boolean>`${focusSessions.startedAt} > clock_timestamp() - ${String(Math.trunc(minAgeMs))}::float8 * interval '1 millisecond'`,
      })
      .from(focusSessions)
      .where(eq(focusSessions.id, sessionId))
      .limit(1)
      .for('update', { skipLocked: true });
    if (row === undefined) {
      // Gone, or held by another transaction: indistinguishable here, and both are fine.
      return { kind: 'skipped', reason: 'locked' };
    }
    if (row.status !== 'in_progress' || row.roomId === null) {
      return { kind: 'skipped', reason: 'not_in_progress' };
    }
    if (row.tooYoung) {
      return { kind: 'skipped', reason: 'too_young' };
    }
    const [updated] = await tx
      .update(focusSessions)
      .set({
        status: 'abandoned',
        abandonReason: 'timer_lost',
        focusedSeconds: 0,
        runningSince: null,
        endedAt: sql`date_trunc('milliseconds', clock_timestamp())`,
      })
      .where(eq(focusSessions.id, sessionId))
      .returning();
    if (updated === undefined) {
      throw new Error('abandonTimerLost: update returned no row');
    }
    const task =
      updated.taskId === null
        ? undefined
        : await findSessionTask(tx, updated.userId, updated.taskId);
    return {
      kind: 'abandoned',
      session: toFocusSessionView(updated, task),
      roomId: row.roomId,
    };
  });

/** Whether the ledger still holds this session's participant entry. */
export const ledgerHoldsSession = async (ledger: Pick<RunLedger, 'read'>, key: RoomSessionKey) => {
  const snapshot = await ledger.read(key.roomId, key.focusRunId);
  return snapshot.participants.some(
    (participant) => participant.userId === key.userId && participant.sessionId === key.id,
  );
};

export type RoomFocusRecoverySummary = {
  readonly scanned: number;
  readonly abandoned: number;
  /** Still tracked by the ledger (opted in after the loss), too young or held elsewhere. */
  readonly skipped: number;
  readonly failed: number;
};

export type RoomFocusRecoveryDeps = {
  readonly db: Db;
  readonly ledger: Pick<RunLedger, 'read'>;
  /**
   * Announces committed changes (a `session` change per abandoned user, a `participants`
   * change per affected room): the same announcers the service's `onChange` feeds.
   * A failure is logged and never undoes the commit.
   */
  readonly notify: (change: RoomFocusChange) => void | Promise<void>;
  readonly logger: Logger;
  readonly batchSize?: number;
  readonly settleMs?: number;
  /** Checked before each session; false stops the run (shutdown). */
  readonly shouldContinue?: () => boolean;
};

/**
 * Global recovery (RF10): Redis lost its data, so every in-progress room session that the
 * (new) ledger does not know is abandoned `timer_lost`. Idempotent and safe to run twice or
 * concurrently: a session abandoned by one run is no longer in progress for the other, and a
 * session that opted in after the loss has a ledger entry and is kept. Solo sessions are
 * never touched. One session's failure is logged and counted, never fatal.
 */
export const recoverRoomFocusAfterRedisLoss = async (
  deps: RoomFocusRecoveryDeps,
): Promise<RoomFocusRecoverySummary> => {
  const { db, ledger, notify, logger } = deps;
  const batchSize = deps.batchSize ?? RECOVERY_BATCH_SIZE;
  const settleMs = deps.settleMs ?? RECOVERY_SETTLE_MS;
  const shouldContinue = deps.shouldContinue ?? (() => true);
  let scanned = 0;
  let abandoned = 0;
  let skipped = 0;
  let failed = 0;
  const rooms = new Set<string>();

  const tell = async (change: RoomFocusChange): Promise<void> => {
    try {
      await notify(change);
    } catch (error) {
      logger.warn({ err: error, change: change.kind }, 'Room focus recovery notification failed');
    }
  };

  let afterUserId: string | null = null;
  while (shouldContinue()) {
    const keys = await listInProgressRoomSessions(db, { afterUserId, limit: batchSize });
    for (const key of keys) {
      if (!shouldContinue()) {
        break;
      }
      scanned += 1;
      try {
        if (key.ageMs < settleMs || (await ledgerHoldsSession(ledger, key))) {
          skipped += 1;
          continue;
        }
        const outcome = await abandonTimerLost(db, key.id, settleMs);
        if (outcome.kind === 'abandoned') {
          abandoned += 1;
          rooms.add(outcome.roomId);
          await tell({ kind: 'session', userId: key.userId, session: outcome.session });
        } else {
          skipped += 1;
        }
      } catch (error) {
        failed += 1;
        logger.warn({ err: error, sessionId: key.id }, 'Could not recover a room focus session');
      }
    }
    const last = keys.at(-1);
    if (last === undefined || keys.length < batchSize) {
      break;
    }
    afterUserId = last.userId;
  }
  for (const roomId of rooms) {
    await tell({ kind: 'participants', roomId });
  }
  const summary = { scanned, abandoned, skipped, failed };
  (abandoned > 0 || failed > 0 ? logger.warn : logger.info).call(
    logger,
    summary,
    'Room focus recovery after Redis data loss finished',
  );
  if (failed > 0) {
    throw new Error(`room focus recovery: ${String(failed)} session(s) failed`);
  }
  return summary;
};
