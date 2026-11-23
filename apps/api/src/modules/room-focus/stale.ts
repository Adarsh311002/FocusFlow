import type { FocusSessionView } from '@focus-flow/contracts';
import { and, asc, eq, gt, isNotNull, sql } from 'drizzle-orm';
import type { Logger } from 'pino';

import type { Db, Tx } from '../../db/client.js';
import { focusSessions } from '../../db/schema.js';
import { databaseNowMs } from '../focus-sessions/queries.js';
import { loadView } from '../focus-sessions/service.js';
import { timerMachine } from '../room-timer/machine.js';
import type { RoomTimerService } from '../room-timer/types.js';
import { settlementForStale } from './model.js';
import { lockRoomSessionSkipLocked } from './queries.js';
import { applySettlement } from './settle.js';
import {
  ROOM_STALE_AFTER_MS,
  ROOM_STALE_HARD_MAX_MS,
  type RoomFocusChange,
  type RunLedger,
} from './types.js';

// Stale room focus sessions (RF17; docs/architecture/focus-timing-protocol.md "Stale room
// sessions"). A room session still `in_progress` ROOM_STALE_AFTER_MS (12 h) after `started_at`
// is abandoned `expired`, so a paused or idle room can never hold a user's single session
// slot for ever. Rules:
//  - a session whose own run is still open with the timer RUNNING is left to finish its phase
//    (a phase lasts at most 4 h), and so is a closed run still waiting for its settlement,
//    but only until ROOM_STALE_HARD_MAX_MS (16 h): the absolute maximum;
//  - focused time is what the ledger and the timer prove (the elapsed time now, or frozen at
//    the run's close, never past a recorded disconnect); without a ledger entry it is 0;
//  - Redis is read first. If it cannot answer, nothing is decided (a transient failure never
//    discards focused time): the next sweep tries again;
//  - PostgreSQL decides under the row lock (`SKIP LOCKED`, the age re-checked with the
//    PostgreSQL clock), touches only an `in_progress` row of that run and is idempotent;
//  - ledger cleanup and announcements follow the commit. A cleanup that fails is kept in the
//    caller's backlog and retried by every sweep (a closed run settlement removes leftovers
//    too). Solo sessions are never selected (`room_id IS NOT NULL`).

const STALE_STATEMENT_TIMEOUT_MS = 5_000;

export type StaleRoomKey = {
  readonly id: string;
  readonly userId: string;
  readonly roomId: string;
  readonly focusRunId: string;
  /** PostgreSQL clock: milliseconds since `started_at` at the time of the read. */
  readonly ageMs: number;
};

/** A ledger entry of an expired session that is still to be removed. */
export type StaleCleanup = {
  readonly roomId: string;
  readonly focusRunId: string;
  readonly userId: string;
  readonly sessionId: string;
};

export type StaleRoomDeps = {
  readonly db: Db;
  readonly ledger: Pick<RunLedger, 'read' | 'removeParticipant' | 'finishRun'>;
  readonly timer: Pick<RoomTimerService, 'get'>;
  readonly notify: (change: RoomFocusChange) => void | Promise<void>;
  readonly logger: Logger;
  readonly staleAfterMs?: number;
  readonly hardMaxMs?: number;
};

export type StaleRoomOutcome =
  | 'expired'
  /** The session's own phase is still running (before the absolute maximum). */
  | 'running'
  /** Its run is closed and waiting for the settlement (before the absolute maximum). */
  | 'closed_run'
  /** Redis could not answer: nothing was decided. */
  | 'redis_unavailable'
  | 'not_stale'
  | 'ended'
  | 'locked';

/** One keyset page (by user id) of room sessions in progress for at least `staleAfterMs`. */
export const listStaleRoomSessions = async (
  db: Db,
  page: {
    readonly afterUserId: string | null;
    readonly limit: number;
    readonly staleAfterMs: number;
  },
): Promise<StaleRoomKey[]> => {
  const ageMs = sql<number>`floor(extract(epoch from (clock_timestamp() - ${focusSessions.startedAt})) * 1000)::float8`;
  const rows = await db
    .select({
      id: focusSessions.id,
      userId: focusSessions.userId,
      roomId: focusSessions.roomId,
      focusRunId: focusSessions.focusRunId,
      ageMs,
    })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.status, 'in_progress'),
        isNotNull(focusSessions.roomId),
        isNotNull(focusSessions.focusRunId),
        sql`${focusSessions.startedAt} <= clock_timestamp() - ${String(Math.trunc(page.staleAfterMs))}::float8 * interval '1 millisecond'`,
        page.afterUserId === null ? undefined : gt(focusSessions.userId, page.afterUserId),
      ),
    )
    .orderBy(asc(focusSessions.userId))
    .limit(page.limit);
  const keys: StaleRoomKey[] = [];
  for (const row of rows) {
    if (row.roomId !== null && row.focusRunId !== null) {
      keys.push({ ...row, roomId: row.roomId, focusRunId: row.focusRunId });
    }
  }
  return keys;
};

type Committed = {
  readonly view: FocusSessionView;
  readonly cleanup: StaleCleanup;
};

/** Removes the ledger entry and tells the room; false when the ledger could not be reached. */
export const cleanUpExpired = async (
  deps: Pick<StaleRoomDeps, 'ledger' | 'notify' | 'logger'>,
  cleanup: StaleCleanup,
): Promise<boolean> => {
  const { ledger, notify, logger } = deps;
  try {
    await ledger.removeParticipant(
      cleanup.roomId,
      cleanup.focusRunId,
      cleanup.userId,
      cleanup.sessionId,
    );
    await ledger.finishRun(cleanup.roomId, cleanup.focusRunId);
  } catch (error) {
    logger.warn({ err: error, ...cleanup }, 'Could not clean the ledger of an expired session');
    return false;
  }
  try {
    await notify({ kind: 'participants', roomId: cleanup.roomId });
  } catch (error) {
    logger.warn({ err: error, roomId: cleanup.roomId }, 'Could not announce the participants');
  }
  return true;
};

/**
 * Decides one stale room session (RF17). `cleanups` receives the ledger entry of a session
 * that expired but whose ledger cleanup failed, for the caller to retry.
 */
export const expireStaleRoomSession = async (
  deps: StaleRoomDeps,
  key: StaleRoomKey,
  cleanups: StaleCleanup[],
): Promise<StaleRoomOutcome> => {
  const { db, ledger, timer, notify, logger } = deps;
  const staleAfterMs = deps.staleAfterMs ?? ROOM_STALE_AFTER_MS;
  const hardMaxMs = deps.hardMaxMs ?? ROOM_STALE_HARD_MAX_MS;
  const beyondMaximum = key.ageMs >= hardMaxMs;

  // 1. What Redis proves. Any failure here defers the whole decision.
  let read;
  let current;
  try {
    [read, current] = await Promise.all([
      ledger.read(key.roomId, key.focusRunId),
      timer.get(key.roomId),
    ]);
  } catch (error) {
    logger.warn(
      { err: error, sessionId: key.id },
      'Stale room session deferred: Redis unavailable',
    );
    return 'redis_unavailable';
  }
  const ownTimer =
    current !== undefined &&
    current.state.phase === 'focus' &&
    current.state.focusRunId === key.focusRunId
      ? current
      : undefined;
  if (!beyondMaximum && ownTimer?.state.status === 'running') {
    return 'running';
  }
  if (!beyondMaximum && read.run?.status === 'closed') {
    return 'closed_run';
  }
  const participant = read.participants.find(
    (entry) => entry.userId === key.userId && entry.sessionId === key.id,
  );
  const elapsedEndMs =
    ownTimer !== undefined
      ? timerMachine.elapsedMs(ownTimer.state, ownTimer.nowMs)
      : (read.run?.elapsedAtCloseMs ?? participant?.elapsedAtOptInMs ?? 0);

  // 2. PostgreSQL decides under the row lock.
  const outcome = await db.transaction(
    async (tx: Tx): Promise<Committed | Exclude<StaleRoomOutcome, 'expired'>> => {
      await tx.execute(
        sql.raw(`SET LOCAL statement_timeout = ${String(STALE_STATEMENT_TIMEOUT_MS)}`),
      );
      const row = await lockRoomSessionSkipLocked(tx, key.id);
      if (row === undefined) {
        return 'locked';
      }
      if (
        row.status !== 'in_progress' ||
        row.roomId !== key.roomId ||
        row.focusRunId !== key.focusRunId
      ) {
        return 'ended';
      }
      if ((await databaseNowMs(tx)) < row.startedAt.getTime() + staleAfterMs) {
        return 'not_stale';
      }
      const settlement = settlementForStale(
        participant,
        elapsedEndMs,
        read.nowMs,
        row.plannedSeconds,
      );
      const saved = await applySettlement(tx, row, settlement);
      if (saved === undefined) {
        return 'ended';
      }
      return {
        view: await loadView(tx, saved),
        cleanup: {
          roomId: key.roomId,
          focusRunId: key.focusRunId,
          userId: key.userId,
          sessionId: key.id,
        },
      };
    },
  );
  if (typeof outcome === 'string') {
    return outcome;
  }

  // 3. After the commit: the ledger, then the announcements.
  if (!(await cleanUpExpired({ ledger, notify, logger }, outcome.cleanup))) {
    cleanups.push(outcome.cleanup);
  }
  try {
    await notify({ kind: 'session', userId: key.userId, session: outcome.view });
  } catch (error) {
    logger.warn({ err: error, sessionId: key.id }, 'Could not announce an expired room session');
  }
  return 'expired';
};

export type StaleRoomSweepSummary = {
  readonly outcomes: Readonly<Record<string, number>>;
  readonly failed: number;
  /** Ledger cleanups still waiting for a retry after this sweep. */
  readonly cleanupsPending: number;
  readonly complete: boolean;
};

export type StaleRoomSweepDeps = StaleRoomDeps & {
  readonly batchSize?: number;
  /** Ledger cleanups that failed earlier; owned by the caller (one per process), mutated here. */
  readonly cleanups?: StaleCleanup[];
};

/** Reconciler step 6b: retries failed cleanups, then expires stale room sessions. */
export const sweepStaleRoomSessions = async (
  deps: StaleRoomSweepDeps,
  shouldContinue: () => boolean = () => true,
): Promise<StaleRoomSweepSummary> => {
  const batchSize = deps.batchSize ?? 100;
  const staleAfterMs = deps.staleAfterMs ?? ROOM_STALE_AFTER_MS;
  const backlog = deps.cleanups ?? [];
  const outcomes: Record<string, number> = {};
  let failed = 0;
  let complete = true;

  // Earlier cleanups first: take the backlog, put back what still fails.
  for (const cleanup of backlog.splice(0)) {
    if (!(await cleanUpExpired(deps, cleanup))) {
      backlog.push(cleanup);
    }
  }

  let afterUserId: string | null = null;
  for (;;) {
    if (!shouldContinue()) {
      complete = false;
      break;
    }
    const keys = await listStaleRoomSessions(deps.db, {
      afterUserId,
      limit: batchSize,
      staleAfterMs,
    });
    for (const key of keys) {
      if (!shouldContinue()) {
        complete = false;
        break;
      }
      try {
        const label = await expireStaleRoomSession(deps, key, backlog);
        outcomes[label] = (outcomes[label] ?? 0) + 1;
      } catch (error) {
        failed += 1;
        deps.logger.warn(
          { err: error, sessionId: key.id, roomId: key.roomId },
          'Could not expire a stale room focus session',
        );
      }
    }
    const last = keys.at(-1);
    if (!complete || last === undefined || keys.length < batchSize) {
      break;
    }
    afterUserId = last.userId;
  }
  return { outcomes, failed, cleanupsPending: backlog.length, complete };
};
