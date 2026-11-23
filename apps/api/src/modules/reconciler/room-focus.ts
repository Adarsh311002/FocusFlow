import type { Logger } from 'pino';

import type { Db } from '../../db/client.js';
import { graceRemainingMs } from '../room-focus/model.js';
import {
  abandonTimerLost,
  listInProgressRoomSessions,
  type RoomSessionKey,
} from '../room-focus/recovery.js';
import {
  ORPHAN_RECOVERY_MS,
  type RoomFocusChange,
  type RoomFocusService,
  type RoomGraceScheduler,
  type RoomPresenceCheck,
  type RunLedger,
} from '../room-focus/types.js';
import type { RoomTimerService } from '../room-timer/types.js';

// Reconciler steps 3, 4 and 7 (RF9, RF15; docs/architecture/focus-timing-protocol.md,
// "Reconciler"):
//   3. closed runs in the unsettled set are settled (a lost follow-up, a crash);
//   4+7. one PostgreSQL-driven sweep of in-progress ROOM sessions, in keyset batches, each
//        decided on its own and never fatal to the run:
//          - no ledger entry for the session, older than ORPHAN_RECOVERY_MS -> timer_lost;
//          - the run is closed -> settle it (a disconnected participant still inside the
//            grace gets its grace job ensured);
//          - disconnected and the grace is over -> grace_expired;
//          - disconnected inside the grace -> its grace job ensured;
//          - recorded as connected but absent from the room -> the disconnect is recorded
//            late (the service re-checks presence) and its grace starts.
// Every transition goes through the service (or the row-locked, `SKIP LOCKED`
// `abandonTimerLost`), which touches only sessions still `in_progress`, so overlapping runs
// across instances are harmless. At most `concurrency` sessions are decided at once.

export const ROOM_FOCUS_SWEEP_BATCH = 100;
export const ROOM_FOCUS_SWEEP_CONCURRENCY = 4;

export type RoomFocusSweepDeps = {
  readonly db: Db;
  readonly ledger: Pick<RunLedger, 'read' | 'unsettled' | 'removeParticipant' | 'finishRun'>;
  readonly service: Pick<RoomFocusService, 'settleRun' | 'graceExpired' | 'userLeftRoom'>;
  readonly scheduler: RoomGraceScheduler;
  readonly isPresent: RoomPresenceCheck;
  /** The room timer, read only: the stale-session step (RF17, 6b) needs it; absent -> that step is off. */
  readonly timer?: Pick<RoomTimerService, 'get'>;
  /** Announces committed changes (a session abandoned `timer_lost`, the room's list). */
  readonly notify: (change: RoomFocusChange) => void | Promise<void>;
  readonly logger: Logger;
  readonly batchSize?: number;
  readonly concurrency?: number;
  readonly orphanAfterMs?: number;
  /**
   * Where the next sweep starts (users are visited in id order). A sweep stopped by its
   * time budget leaves the start of its unfinished batch here, so the next sweep resumes
   * there and high user ids are not starved; a sweep that reaches the end resets it.
   * Owned by the caller (one per process), mutated by the sweep.
   */
  readonly cursor?: { afterUserId: string | null };
};

export type UnsettledRunsSummary = {
  readonly settled: number;
  /** Runs still waiting for a participant's grace. */
  readonly pendingGrace: number;
  /** Runs already gone from Redis (cleaned up). */
  readonly gone: number;
  readonly failed: number;
};

/** Step 3. A run waiting for a grace stays in the set, so it is not asked twice in one run. */
export const settleUnsettledRuns = async (
  deps: Pick<RoomFocusSweepDeps, 'ledger' | 'service' | 'logger' | 'batchSize'>,
  shouldContinue: () => boolean = () => true,
): Promise<UnsettledRunsSummary> => {
  const { ledger, service, logger } = deps;
  const batchSize = deps.batchSize ?? ROOM_FOCUS_SWEEP_BATCH;
  let settled = 0;
  let pendingGrace = 0;
  let gone = 0;
  let failed = 0;
  const seen = new Set<string>();
  while (shouldContinue()) {
    // Handled runs that stay in the set are counted into the page size, so they never hide
    // the ones behind them (the same device as the room timer sweep).
    const page = (await ledger.unsettled(batchSize + seen.size)).filter(
      ({ roomId, runId }) => !seen.has(`${roomId}:${runId}`),
    );
    if (page.length === 0) {
      break;
    }
    for (const { roomId, runId } of page) {
      if (!shouldContinue()) {
        break;
      }
      seen.add(`${roomId}:${runId}`);
      try {
        const outcome = await service.settleRun(roomId, runId);
        if (outcome === 'settled') {
          settled += 1;
        } else if (outcome === 'pending_grace') {
          pendingGrace += 1;
        } else {
          gone += 1;
        }
      } catch (error) {
        failed += 1;
        logger.warn({ err: error, roomId, runId }, 'Could not settle a closed room focus run');
      }
    }
  }
  return { settled, pendingGrace, gone, failed };
};

export type RoomSessionSweepSummary = {
  /** Sessions per outcome, for example `timer_lost`, `grace_expired`, `grace_ensured`. */
  readonly outcomes: Readonly<Record<string, number>>;
  readonly failed: number;
  /** False when `shouldContinue` stopped the sweep before it reached the end. */
  readonly complete: boolean;
};

/**
 * What one session needs. Reads the ledger once (one `MULTI`, Redis TIME included) and
 * acts; returns the outcome label.
 */
const decideSession = async (
  deps: RoomFocusSweepDeps,
  key: RoomSessionKey,
  settled: Map<string, Promise<'settled' | 'pending_grace' | 'gone'>>,
): Promise<string> => {
  const { db, ledger, service, scheduler, isPresent, notify, logger } = deps;
  const { run, participants, nowMs } = await ledger.read(key.roomId, key.focusRunId);
  const participant = participants.find(
    (candidate) => candidate.userId === key.userId && candidate.sessionId === key.id,
  );

  if (participant === undefined) {
    // RF15: no ledger entry. Recent ones may be an opt-in still being written.
    const outcome = await abandonTimerLost(db, key.id, deps.orphanAfterMs ?? ORPHAN_RECOVERY_MS);
    if (outcome.kind !== 'abandoned') {
      return `orphan_${outcome.reason}`;
    }
    try {
      await notify({ kind: 'session', userId: key.userId, session: outcome.session });
      await notify({ kind: 'participants', roomId: key.roomId });
    } catch (error) {
      logger.warn({ err: error, sessionId: key.id }, 'Could not announce a timer_lost session');
    }
    return 'timer_lost';
  }

  if (run?.status === 'closed') {
    // A closed run with N participants is settled once per sweep: the service settles every
    // participant of the run in one call.
    const runKey = `${key.roomId}:${key.focusRunId}`;
    let pending = settled.get(runKey);
    if (pending === undefined) {
      pending = service.settleRun(key.roomId, key.focusRunId);
      settled.set(runKey, pending);
    }
    const settledResult = await pending;
    if (settledResult === 'pending_grace' && participant.disconnectedAtMs !== null) {
      await scheduler.ensureGrace(
        {
          roomId: key.roomId,
          focusRunId: key.focusRunId,
          userId: key.userId,
          disconnectedAtMs: participant.disconnectedAtMs,
        },
        graceRemainingMs(participant, nowMs),
      );
    }
    return `run_${settledResult}`;
  }

  if (participant.disconnectedAtMs !== null) {
    const remainingMs = graceRemainingMs(participant, nowMs);
    if (remainingMs === 0) {
      const result = await service.graceExpired(
        key.roomId,
        key.focusRunId,
        key.userId,
        participant.disconnectedAtMs,
      );
      return `grace_${result}`;
    }
    await scheduler.ensureGrace(
      {
        roomId: key.roomId,
        focusRunId: key.focusRunId,
        userId: key.userId,
        disconnectedAtMs: participant.disconnectedAtMs,
      },
      remainingMs,
    );
    return 'grace_ensured';
  }

  // Recorded as connected: the user must still be in the room. A missed disconnect (a lost
  // hint, a crashed instance) is recorded late and gets a normal grace from now (H3).
  if (!(await isPresent(key.roomId, key.userId))) {
    await service.userLeftRoom(key.userId, key.roomId);
    return 'late_grace';
  }
  return 'connected';
};

/** Runs `task` over `items` with at most `concurrency` in flight. */
const forEachBounded = async <T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
): Promise<void> => {
  let next = 0;
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      const item = items[index];
      if (item !== undefined) {
        await task(item);
      }
    }
  });
  await Promise.all(lanes);
};

/** Steps 4 and 7. */
export const sweepRoomSessions = async (
  deps: RoomFocusSweepDeps,
  shouldContinue: () => boolean = () => true,
): Promise<RoomSessionSweepSummary> => {
  const batchSize = deps.batchSize ?? ROOM_FOCUS_SWEEP_BATCH;
  const outcomes: Record<string, number> = {};
  let failed = 0;
  const status = { complete: true };
  let afterUserId: string | null = deps.cursor?.afterUserId ?? null;
  const settled = new Map<string, Promise<'settled' | 'pending_grace' | 'gone'>>();

  for (;;) {
    if (!shouldContinue()) {
      status.complete = false;
      if (deps.cursor !== undefined) {
        deps.cursor.afterUserId = afterUserId;
      }
      break;
    }
    const batchStart = afterUserId;
    const keys = await listInProgressRoomSessions(deps.db, { afterUserId, limit: batchSize });
    await forEachBounded(keys, deps.concurrency ?? ROOM_FOCUS_SWEEP_CONCURRENCY, async (key) => {
      if (!shouldContinue()) {
        status.complete = false;
        return;
      }
      try {
        const label = await decideSession(deps, key, settled);
        outcomes[label] = (outcomes[label] ?? 0) + 1;
      } catch (error) {
        failed += 1;
        deps.logger.warn(
          { err: error, sessionId: key.id, roomId: key.roomId },
          'Could not reconcile a room focus session',
        );
      }
    });
    if (!status.complete) {
      // Stopped inside this batch: resume at its start (every decision is idempotent).
      if (deps.cursor !== undefined) {
        deps.cursor.afterUserId = batchStart;
      }
      break;
    }
    const last = keys.at(-1);
    if (last === undefined || keys.length < batchSize) {
      break;
    }
    afterUserId = last.userId;
  }
  if (status.complete && deps.cursor !== undefined) {
    deps.cursor.afterUserId = null;
  }
  return { outcomes, failed, complete: status.complete };
};
