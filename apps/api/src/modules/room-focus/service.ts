import type { FocusSessionView } from '@focus-flow/contracts';
import type { Logger } from 'pino';
import { uuidv7 } from 'uuidv7';

import type { Db, Tx } from '../../db/client.js';
import { isUniqueViolation } from '../../db/pg-errors.js';
import { AppError, appError } from '../../platform/http/errors.js';
import { databaseNowMs, type FocusSessionRow } from '../focus-sessions/queries.js';
import { loadView } from '../focus-sessions/service.js';
import { timerMachine } from '../room-timer/machine.js';
import type { RoomTimerService, TimerState } from '../room-timer/types.js';
import { lockOwnedTaskForShare } from '../tasks/queries.js';
import {
  graceRemainingMs,
  pendingEndAtMs,
  plannedSecondsAtOptIn,
  settlementForClosedRun,
  settlementForDeparture,
  settlementForGraceExpiry,
  wasPresentThroughEnd,
} from './model.js';
import { toParticipants } from './participants.js';
import {
  deleteUnjoinedRoomSession,
  findAnyInProgressSession,
  findInProgressRoomSession,
  findInProgressRoomSessionForUpdate,
  findLatestRoomSession,
  findRoomSessionById,
  insertRoomSession,
  isMemberOfRoom,
  listRunSessions,
  lockMembershipForShare,
  lockRoomSession,
} from './queries.js';
import { applySettlement } from './settle.js';
import {
  type DepartureReason,
  type LedgerParticipant,
  ROOM_GRACE_MS,
  type RoomFocusChange,
  type RoomFocusService,
  type RoomGraceScheduler,
  type RoomPresenceCheck,
  type RunLedger,
  type RunRecord,
  type Settlement,
} from './types.js';
import { emptyFocusSnapshot, toFocusSnapshot } from './views.js';

// Room focus participation (Phase 8; RF4-RF10, docs/architecture/focus-timing-protocol.md
// "Focus runs"). PostgreSQL decides what is durable and is written FIRST; the Redis ledger
// follows, and announcements come last, each independent and never able to fail the request
// (persist, then emit). Every transition locks the session row (`FOR UPDATE`) and only
// touches rows still `in_progress`, so duplicates, concurrent workers and a crash between
// PostgreSQL and Redis are safe (RF6): a leftover ledger entry is harmless and a leftover
// session without one is repaired by a retry or abandoned by the reconciler (RF15).

export type RoomFocusServiceDeps = {
  readonly db: Db;
  /** The room timer, read only (`get`); the timer's own writes live in modules/room-timer. */
  readonly timer: Pick<RoomTimerService, 'get'>;
  readonly ledger: RunLedger;
  readonly grace: RoomGraceScheduler;
  /** Whether the person has a live socket in the room (room presence, Redis). */
  readonly isPresent: RoomPresenceCheck;
  readonly logger: Logger;
};

/**
 * A grace job that fires this much before the grace is over is treated as due: the job's
 * delay is computed from Redis TIME but BullMQ schedules with its own clock.
 */
export const GRACE_EARLY_TOLERANCE_MS = 1_000;

/** Attempts of the version-checked disconnect write (the timer may move meanwhile). */
const MAX_DISCONNECT_ATTEMPTS = 3;

/** A departure computed before the transaction: apply it inside, announce it after. */
export type PlannedDeparture = {
  /** Abandons the participant's session inside the caller's transaction (row locked). */
  readonly commit: (tx: Tx) => Promise<void>;
  /** After the commit: ledger removal and announcements. Never throws. */
  readonly afterCommit: () => Promise<void>;
  /** The ended session, once `commit` ran and changed it. */
  readonly session: () => FocusSessionView | undefined;
};

export type RoomFocusDepartures = {
  /** `undefined`: the person has no in-progress session in the room. */
  readonly beginDeparture: (
    userId: string,
    roomId: string,
    reason: Extract<DepartureReason, 'left_room' | 'removed'>,
  ) => Promise<PlannedDeparture | undefined>;
};

export type RoomFocusServiceImpl = RoomFocusService & RoomFocusDepartures;

const roomNotFound = (): AppError => appError('ROOM_NOT_FOUND', 'Room not found.');

const liveUnavailable = (): AppError =>
  new AppError('INTERNAL', 503, 'Live room state is temporarily unavailable. Try again shortly.');

const conflict = (
  code: 'RUN_CHANGED' | 'RUN_ENDING' | 'NOT_PRESENT' | 'NOT_FOCUS_PHASE',
  message: string,
): AppError => new AppError(code, 409, message);

const byUser = (userId: string) => (participant: LedgerParticipant) =>
  participant.userId === userId;

export const createRoomFocusService = (deps: RoomFocusServiceDeps): RoomFocusServiceImpl => {
  const { db, ledger, logger } = deps;
  const listeners: ((change: RoomFocusChange) => void | Promise<void>)[] = [];

  const emit = async (change: RoomFocusChange): Promise<void> => {
    for (const listener of listeners) {
      try {
        await listener(change);
      } catch (error) {
        logger.error({ err: error, kind: change.kind }, 'room focus change listener failed');
      }
    }
  };
  const announceParticipants = (roomId: string) => emit({ kind: 'participants', roomId });
  const announceSession = (userId: string, session: FocusSessionView) =>
    emit({ kind: 'session', userId, session });

  /** Runs a Redis-backed step; any failure is a 503 and changes nothing durable. */
  const live = async <T>(what: string, step: () => Promise<T>): Promise<T> => {
    try {
      return await step();
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      logger.warn({ err: error, what }, 'live room state unavailable');
      throw liveUnavailable();
    }
  };

  /** Best-effort cleanup after a durable write: logged, never thrown. */
  const bestEffort = async (what: string, step: () => Promise<unknown>): Promise<void> => {
    try {
      await step();
    } catch (error) {
      logger.error({ err: error, what }, 'room focus follow-up failed after commit');
    }
  };

  const readTimer = async (roomId: string): Promise<{ state: TimerState; nowMs: number }> => {
    const timer = await live('timer', () => deps.timer.get(roomId));
    if (timer === undefined) {
      throw roomNotFound();
    }
    return timer;
  };

  const requireMember = async (userId: string, roomId: string): Promise<void> => {
    if (!(await isMemberOfRoom(db, roomId, userId))) {
      throw roomNotFound();
    }
  };

  // ---- Snapshot and participants ---------------------------------------------------------

  /** The current run and its participants; `runId` is `null` outside a focus phase. */
  const currentRun = async (
    roomId: string,
  ): Promise<
    { runId: string; participants: LedgerParticipant[]; participantsVersion: number } | undefined
  > => {
    const timer = await deps.timer.get(roomId);
    const runId = timer?.state.phase === 'focus' ? timer.state.focusRunId : null;
    if (runId === null) {
      return undefined;
    }
    // The list and its version come from one atomic ledger read, so they are a consistent pair.
    const snapshot = await ledger.read(roomId, runId);
    return {
      runId,
      participants: snapshot.run?.status === 'open' ? [...snapshot.participants] : [],
      participantsVersion: snapshot.participantsVersion,
    };
  };

  const snapshot: RoomFocusService['snapshot'] = async (userId, roomId) => {
    const run = await currentRun(roomId);
    if (run === undefined) {
      return emptyFocusSnapshot();
    }
    const mine = run.participants.find(byUser(userId));
    return toFocusSnapshot(
      run.runId,
      await toParticipants(db, run.participants),
      run.participantsVersion,
      mine?.sessionId,
    );
  };

  const participants: RoomFocusService['participants'] = async (roomId) => {
    const run = await currentRun(roomId);
    return run === undefined
      ? { focusRunId: null, participants: [], participantsVersion: 0 }
      : {
          focusRunId: run.runId,
          participants: await toParticipants(db, run.participants),
          participantsVersion: run.participantsVersion,
        };
  };

  const state: RoomFocusService['state'] = async (userId, roomId) => {
    await requireMember(userId, roomId);
    const [focus, row] = await Promise.all([
      live('snapshot', () => snapshot(userId, roomId)),
      findInProgressRoomSession(db, userId, roomId),
    ]);
    return { ...focus, session: row === undefined ? null : await loadView(db, row) };
  };

  // ---- Opt in ---------------------------------------------------------------------------

  /** Presence for the post-write re-check: an unknown answer counts as present (no action). */
  const isPresentOrUnknown = async (roomId: string, userId: string): Promise<boolean> => {
    try {
      return await deps.isPresent(roomId, userId);
    } catch {
      return true;
    }
  };

  const optInOnce = async (
    userId: string,
    roomId: string,
    taskId: string | undefined,
    settledRuns: Set<string>,
  ): Promise<{ session: FocusSessionView; created: boolean } | 'retry'> => {
    await requireMember(userId, roomId);
    const { state: timerState, nowMs } = await readTimer(roomId);
    if (timerState.phase !== 'focus') {
      throw conflict('NOT_FOCUS_PHASE', 'The room is not in a focus phase.');
    }
    const runId = timerState.focusRunId;
    if (runId === null) {
      // A focus timer without a run (written before runs existed): the next change opens one.
      throw conflict('RUN_CHANGED', 'The room timer changed. Try again.');
    }
    if (!(await live('presence', () => deps.isPresent(roomId, userId)))) {
      throw conflict('NOT_PRESENT', 'Open the room before joining its focus run.');
    }
    const elapsedMs = timerMachine.elapsedMs(timerState, nowMs);

    const existing = await findAnyInProgressSession(db, userId);
    let row: FocusSessionRow;
    let created: boolean;
    let optedElapsedMs = elapsedMs;
    if (existing !== undefined) {
      if (
        existing.roomId === roomId &&
        existing.focusRunId !== null &&
        existing.focusRunId !== runId &&
        !settledRuns.has(existing.focusRunId)
      ) {
        // The user's session of an earlier, closed run of this room that is not settled yet:
        // settle it now and look again once before refusing (Rev J4).
        settledRuns.add(existing.focusRunId);
        const oldRunId = existing.focusRunId;
        await bestEffort('settleRun', () => settleRun(roomId, oldRunId));
        return 'retry';
      }
      if (existing.roomId !== roomId || existing.focusRunId !== runId) {
        throw new AppError('SESSION_IN_PROGRESS', 409, 'A focus session is already in progress.', {
          session: await loadView(db, existing),
        });
      }
      // The user's own half-completed opt-in in this very run: repair its ledger entry.
      row = existing;
      created = false;
      optedElapsedMs = Math.max(0, timerState.durationMs - existing.plannedSeconds * 1_000);
    } else {
      const planned = plannedSecondsAtOptIn(timerState.durationMs, elapsedMs);
      if (!planned.ok) {
        throw conflict('RUN_ENDING', 'This focus run is about to end. Join the next one.');
      }
      try {
        row = await db.transaction(async (tx) => {
          // Serialises against leaving or removing the membership (Rev I M2).
          if (!(await lockMembershipForShare(tx, roomId, userId))) {
            throw roomNotFound();
          }
          if (taskId !== undefined) {
            const task = await lockOwnedTaskForShare(tx, userId, taskId);
            if (task === undefined || task.deletedAt !== null) {
              throw appError('TASK_NOT_FOUND', 'Task not found.');
            }
            if (task.completedAt !== null) {
              throw appError('TASK_NOT_OPEN', 'Only an open task can be focused on.');
            }
          }
          return insertRoomSession(tx, {
            id: uuidv7(),
            userId,
            taskId: taskId ?? null,
            roomId,
            focusRunId: runId,
            plannedSeconds: planned.plannedSeconds,
            startedAtMs: await databaseNowMs(tx),
          });
        });
      } catch (error) {
        // The partial unique index: a concurrent opt-in (or solo start) won. Look again.
        if (isUniqueViolation(error)) {
          return 'retry';
        }
        throw error;
      }
      created = true;
    }

    const participant: LedgerParticipant = {
      userId,
      sessionId: row.id,
      optedInAtMs: nowMs,
      elapsedAtOptInMs: optedElapsedMs,
      disconnectedAtMs: null,
      elapsedAtDisconnectMs: null,
    };
    let added = await live('ledger', () => ledger.addParticipant(roomId, runId, participant));
    if (added.result === 'exists' && added.participant.sessionId !== row.id) {
      // An entry of an earlier, already ended session of this user (its cleanup failed).
      const staleSessionId = added.participant.sessionId;
      await live('ledger', () => ledger.removeParticipant(roomId, runId, userId, staleSessionId));
      added = await live('ledger', () => ledger.addParticipant(roomId, runId, participant));
    }
    if (added.result === 'run_changed') {
      // Only a row THIS call created is deleted; a repaired row (created === false) was
      // opted in earlier and is settled with its closed run (Rev I M1).
      if (created) {
        await deleteUnjoinedRoomSession(db, row.id, roomId, runId);
      }
      throw conflict('RUN_CHANGED', 'The focus run changed before you could join. Try again.');
    }

    // The session may have ended (or the membership gone) while the ledger was written: a
    // removal that committed in between abandoned the row and could not see the entry that
    // is only now in the ledger. Take the entry back instead of announcing a stale session.
    const fresh = await findRoomSessionById(db, row.id);
    if (fresh?.status !== 'in_progress' || !(await isMemberOfRoom(db, roomId, userId))) {
      await bestEffort('removeParticipant', () =>
        ledger.removeParticipant(roomId, runId, userId, row.id),
      );
      await announceParticipants(roomId);
      if (fresh?.status === 'in_progress') {
        throw roomNotFound();
      }
      throw conflict('RUN_CHANGED', 'The focus session ended before you could join. Try again.');
    }
    const view = await loadView(db, fresh);
    await announceParticipants(roomId);
    await announceSession(userId, view);
    if (!(await isPresentOrUnknown(roomId, userId))) {
      // The last socket left between the check and the ledger write: nobody saw that as a
      // disconnect of a participant, so record it now (RF7).
      await bestEffort('userLeftRoom', () => userLeftRoom(userId, roomId));
    }
    return { session: view, created };
  };

  const optIn: RoomFocusService['optIn'] = async (userId, roomId, taskId) => {
    const settledRuns = new Set<string>();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = await optInOnce(userId, roomId, taskId, settledRuns);
      if (result !== 'retry') {
        return result;
      }
    }
    throw new AppError('INTERNAL', 503, 'Could not join the focus run right now. Try again.');
  };

  // ---- Departure (opt out, leave, removal) -----------------------------------------------

  const planDeparture = async (
    userId: string,
    roomId: string,
    reason: DepartureReason,
    /**
     * A leave or removal always gets a plan, even without a session yet: an opt-in racing the
     * membership delete commits first (it holds the membership FOR SHARE), and the plan's
     * commit then finds and abandons it inside the deleting transaction (Rev I M2).
     */
    always = false,
  ): Promise<PlannedDeparture | undefined> => {
    const row = await findInProgressRoomSession(db, userId, roomId);
    const runId = row?.focusRunId;
    if (row === undefined || runId === null || runId === undefined) {
      return always ? lateDeparture(userId, roomId, reason) : undefined;
    }

    // What the person focused is computed from the ledger and the timer's elapsed time
    // (RF5). If Redis cannot answer, the session still ends - leaving must not depend on
    // Redis - but nothing can be proven, so it counts 0 seconds.
    let settlement: Settlement;
    try {
      const [run, timer] = await Promise.all([ledger.read(roomId, runId), deps.timer.get(roomId)]);
      const current =
        timer !== undefined && timer.state.phase === 'focus' && timer.state.focusRunId === runId
          ? timer
          : undefined;
      const entry = run.participants.find(byUser(userId));
      const elapsedNowMs =
        current === undefined
          ? (run.run?.elapsedAtCloseMs ?? entry?.elapsedAtOptInMs ?? 0)
          : timerMachine.elapsedMs(current.state, current.nowMs);
      const participant: LedgerParticipant | undefined =
        entry ??
        (current === undefined
          ? undefined
          : {
              userId,
              sessionId: row.id,
              optedInAtMs: run.nowMs,
              elapsedAtOptInMs: Math.max(0, current.state.durationMs - row.plannedSeconds * 1_000),
              disconnectedAtMs: null,
              elapsedAtDisconnectMs: null,
            });
      settlement =
        participant === undefined
          ? { kind: 'abandon', reason, focusedSeconds: 0, endedAtMs: run.nowMs }
          : settlementForDeparture(
              reason,
              participant,
              elapsedNowMs,
              run.nowMs,
              row.plannedSeconds,
            );
    } catch (error) {
      logger.warn({ err: error, roomId, reason }, 'departure without live state: counting 0 s');
      settlement = { kind: 'abandon', reason, focusedSeconds: 0, endedAtMs: Date.now() };
    }

    return departureOf(userId, roomId, row.id, settlement);
  };

  /** The plan for a session: applied inside the caller's transaction, announced after. */
  const departureOf = (
    userId: string,
    roomId: string,
    sessionId: string | undefined,
    settlement: Settlement,
  ): PlannedDeparture => {
    let ended: { view: FocusSessionView; sessionId: string; runId: string } | undefined;
    return {
      commit: async (tx) => {
        // Without a session known beforehand, look one up now, under the membership change.
        const locked =
          sessionId === undefined
            ? await findInProgressRoomSessionForUpdate(tx, userId, roomId)
            : await lockRoomSession(tx, sessionId);
        if (locked === undefined) {
          return;
        }
        const saved = await applySettlement(tx, locked, settlement);
        if (saved?.focusRunId !== null && saved?.focusRunId !== undefined) {
          ended = { view: await loadView(tx, saved), sessionId: saved.id, runId: saved.focusRunId };
        }
      },
      afterCommit: async () => {
        if (ended === undefined) {
          return;
        }
        const done = ended;
        await bestEffort('removeParticipant', () =>
          ledger.removeParticipant(roomId, done.runId, userId, done.sessionId),
        );
        await bestEffort('finishRun', () => ledger.finishRun(roomId, done.runId));
        await announceParticipants(roomId);
        await announceSession(userId, done.view);
      },
      session: () => ended?.view,
    };
  };

  /** A departure for a session that did not exist when planned: nothing can be proven (0 s). */
  const lateDeparture = (
    userId: string,
    roomId: string,
    reason: DepartureReason,
  ): PlannedDeparture =>
    departureOf(userId, roomId, undefined, {
      kind: 'abandon',
      reason,
      focusedSeconds: 0,
      endedAtMs: Date.now(),
    });

  const departWith = async (
    userId: string,
    roomId: string,
    reason: DepartureReason,
  ): Promise<FocusSessionView | undefined> => {
    const plan = await planDeparture(userId, roomId, reason);
    if (plan === undefined) {
      return undefined;
    }
    await db.transaction((tx) => plan.commit(tx));
    await plan.afterCommit();
    return plan.session();
  };

  const depart: RoomFocusService['depart'] = async (userId, roomId, reason) => {
    await departWith(userId, roomId, reason);
  };

  const optOut: RoomFocusService['optOut'] = async (userId, roomId) => {
    await requireMember(userId, roomId);
    const ended = await departWith(userId, roomId, 'opted_out');
    if (ended !== undefined) {
      return { session: ended };
    }
    // Nothing in progress (a repeat, or already settled): answer the latest session, if any.
    const latest = await findLatestRoomSession(db, userId, roomId);
    return { session: latest === undefined ? null : await loadView(db, latest) };
  };

  // ---- Disconnect and reconnect (RF7) ---------------------------------------------------

  const ensureGrace = async (
    roomId: string,
    runId: string,
    participant: LedgerParticipant,
    nowMs: number,
  ): Promise<void> => {
    if (participant.disconnectedAtMs === null) {
      return;
    }
    await deps.grace.ensureGrace(
      {
        roomId,
        focusRunId: runId,
        userId: participant.userId,
        disconnectedAtMs: participant.disconnectedAtMs,
      },
      graceRemainingMs(participant, nowMs),
    );
  };

  const userLeftRoom: RoomFocusService['userLeftRoom'] = async (userId, roomId) => {
    const row = await findInProgressRoomSession(db, userId, roomId);
    const runId = row?.focusRunId;
    if (row === undefined || runId === null || runId === undefined) {
      return;
    }
    // A hint (H2): another socket of the user may still be in the room.
    try {
      if (await deps.isPresent(roomId, userId)) {
        return;
      }
    } catch {
      // Unknown presence: record the disconnect; the grace job re-checks before abandoning.
    }
    for (let attempt = 0; attempt < MAX_DISCONNECT_ATTEMPTS; attempt += 1) {
      const run = await ledger.read(roomId, runId);
      const participant = run.participants.find(byUser(userId));
      if (participant === undefined || run.run === undefined) {
        return;
      }
      if (run.run.status !== 'open') {
        // The run closed first, so the person was present when it ended: the close settles
        // their session (a completed run completes it, D35) instead of leaving it waiting for
        // a grace that was never started. A disconnect before the close whose hint was lost
        // is the reconciler's late grace (RF9).
        if (participant.disconnectedAtMs === null) {
          await settleRun(roomId, runId);
        }
        return;
      }
      if (participant.disconnectedAtMs !== null) {
        await ensureGrace(roomId, runId, participant, run.nowMs);
        return;
      }
      const timer = await deps.timer.get(roomId);
      if (timer === undefined || timer.state.focusRunId !== runId) {
        return; // The run changed: its settlement decides.
      }
      const disconnectedAtMs = timer.nowMs;
      const result = await ledger.markDisconnected(roomId, runId, userId, {
        disconnectedAtMs,
        elapsedAtDisconnectMs: timerMachine.elapsedMs(timer.state, timer.nowMs),
        timerVersion: timer.state.version,
      });
      if (result === 'marked') {
        await deps.grace.ensureGrace(
          { roomId, focusRunId: runId, userId, disconnectedAtMs },
          ROOM_GRACE_MS,
        );
        await announceParticipants(roomId);
        if (await isPresentOrUnknown(roomId, userId)) {
          // Back already (a join raced the write): take the reconnect right away.
          await userJoinedRoom(userId, roomId);
        }
        return;
      }
      if (result === 'not_participant' || result === 'run_closed') {
        return;
      }
      // 'conflict' or 'already_disconnected': read again.
    }
    throw new Error(`the disconnect of user ${userId} in room ${roomId} kept conflicting`);
  };

  /**
   * Settles one participant under the session row lock. `decide` gets the session's planned
   * seconds. The ledger entry is removed (and the run finished when empty) after the commit.
   */
  const settleParticipant = async (
    roomId: string,
    runId: string,
    participant: LedgerParticipant,
    decide: (plannedSeconds: number) => Settlement,
  ): Promise<'complete' | 'abandon' | 'pending' | 'gone'> => {
    const outcome = await db.transaction(
      async (
        tx,
      ): Promise<
        { kind: 'complete' | 'abandon'; view: FocusSessionView } | { kind: 'pending' | 'gone' }
      > => {
        const row = await lockRoomSession(tx, participant.sessionId);
        if (
          row === undefined ||
          row.userId !== participant.userId ||
          row.roomId !== roomId ||
          row.focusRunId !== runId ||
          row.status !== 'in_progress'
        ) {
          return { kind: 'gone' };
        }
        const settlement = decide(row.plannedSeconds);
        if (settlement.kind === 'wait_for_grace') {
          return { kind: 'pending' };
        }
        const saved = await applySettlement(tx, row, settlement);
        if (saved === undefined) {
          return { kind: 'gone' };
        }
        return { kind: settlement.kind, view: await loadView(tx, saved) };
      },
    );
    if (outcome.kind === 'pending') {
      return 'pending';
    }
    await bestEffort('removeParticipant', () =>
      ledger.removeParticipant(roomId, runId, participant.userId, participant.sessionId),
    );
    await bestEffort('finishRun', () => ledger.finishRun(roomId, runId));
    await announceParticipants(roomId);
    if ('view' in outcome) {
      await announceSession(participant.userId, outcome.view);
    }
    return outcome.kind;
  };

  const settleClosed = (
    roomId: string,
    runId: string,
    participant: LedgerParticipant,
    run: RunRecord,
    nowMs: number,
  ) =>
    settleParticipant(roomId, runId, participant, (planned) =>
      settlementForClosedRun(participant, run, planned, nowMs),
    );

  /**
   * Grace boundaries, one rule for every caller (Rev J6, J9): a disconnect is over once it is
   * more than the grace PLUS the early tolerance old (the grace job's delay is computed from
   * Redis TIME but BullMQ fires with its own clock, so a job within the tolerance of the
   * boundary must still decide, and a reconnect inside it still counts).
   */
  const graceIsOver = (participant: LedgerParticipant, nowMs: number): boolean =>
    participant.disconnectedAtMs !== null &&
    nowMs - participant.disconnectedAtMs > ROOM_GRACE_MS + GRACE_EARLY_TOLERANCE_MS;

  /** A person back after their completed run closed: complete unless the grace was over (RF7). */
  const settleReconnectAfterClose = (
    roomId: string,
    runId: string,
    participant: LedgerParticipant,
    run: RunRecord,
    nowMs: number,
  ) =>
    settleParticipant(roomId, runId, participant, (planned) =>
      !wasPresentThroughEnd(participant, run) && graceIsOver(participant, nowMs)
        ? settlementForGraceExpiry(participant, planned)
        : { kind: 'complete', endedAtMs: run.closedAtMs ?? nowMs },
    );

  const userJoinedRoom: RoomFocusService['userJoinedRoom'] = async (userId, roomId) => {
    const row = await findInProgressRoomSession(db, userId, roomId);
    const runId = row?.focusRunId;
    if (row === undefined || runId === null || runId === undefined) {
      return;
    }
    // The timer is read BEFORE the ledger (G3): a run closed in between shows as closed.
    const timer = await deps.timer.get(roomId);
    const read = await ledger.read(roomId, runId);
    const participant = read.participants.find(byUser(userId));
    const run = read.run;
    if (participant === undefined || run === undefined || participant.disconnectedAtMs === null) {
      return;
    }
    if (run.status === 'open') {
      if (graceIsOver(participant, read.nowMs)) {
        // Back too late: a reconnect after the grace never revives the session (D19), unless
        // the disconnect came after the phase's true end (G3).
        await settleOpenGraceOver(roomId, runId, participant, timer?.state);
        return;
      }
      if (await ledger.clearDisconnected(roomId, runId, userId, participant.disconnectedAtMs)) {
        await announceParticipants(roomId);
      }
      return;
    }
    if (run.closeReason === 'completed') {
      await settleReconnectAfterClose(roomId, runId, participant, run, read.nowMs);
    } else {
      await settleClosed(roomId, runId, participant, run, read.nowMs);
    }
  };

  /**
   * The grace of a disconnect from a still OPEN run is over (D19). If the disconnect came at or
   * after the phase's true end although the phase-end job has not closed the run yet, the
   * person was present at the end (D35, G3): completed at the true end, the same outcome the
   * closed-run path gives. Otherwise `grace_expired`.
   */
  const settleOpenGraceOver = (
    roomId: string,
    runId: string,
    participant: LedgerParticipant,
    timerState: TimerState | undefined,
  ) => {
    const endsAtMs = pendingEndAtMs(participant, runId, timerState);
    return settleParticipant(roomId, runId, participant, (planned) =>
      endsAtMs !== null
        ? { kind: 'complete', endedAtMs: endsAtMs }
        : settlementForGraceExpiry(participant, planned),
    );
  };

  const graceExpired: RoomFocusService['graceExpired'] = async (
    roomId,
    runId,
    userId,
    disconnectedAtMs,
  ) => {
    // The timer is read BEFORE the ledger (G3): a run closed in between shows as closed.
    const timer = await deps.timer.get(roomId);
    const read = await ledger.read(roomId, runId);
    const participant = read.participants.find(byUser(userId));
    const run = read.run;
    if (
      participant === undefined ||
      run === undefined ||
      participant.disconnectedAtMs !== disconnectedAtMs
    ) {
      return 'stale';
    }
    // Errors propagate: the job is retried, the decision is never guessed.
    if (await deps.isPresent(roomId, userId)) {
      // The same age rule as userJoinedRoom: back after the grace never revives a session.
      if (run.status === 'open') {
        if (graceIsOver(participant, read.nowMs)) {
          const late = await settleOpenGraceOver(roomId, runId, participant, timer?.state);
          return late === 'abandon' ? 'abandoned' : late === 'complete' ? 'completed' : 'stale';
        }
        if (await ledger.clearDisconnected(roomId, runId, userId, disconnectedAtMs)) {
          await announceParticipants(roomId);
          return 'reconnected';
        }
        return 'stale';
      }
      const result =
        run.closeReason === 'completed'
          ? await settleReconnectAfterClose(roomId, runId, participant, run, read.nowMs)
          : await settleClosed(roomId, runId, participant, run, read.nowMs);
      return result === 'complete' ? 'completed' : result === 'abandon' ? 'abandoned' : 'stale';
    }
    if (graceRemainingMs(participant, read.nowMs) > GRACE_EARLY_TOLERANCE_MS) {
      return 'stale'; // Early: the reconciler settles it when the grace is really over.
    }
    const result =
      run.status === 'open'
        ? await settleOpenGraceOver(roomId, runId, participant, timer?.state)
        : // Within the tolerance of the boundary the grace counts as over, also for a completed
          // run (settleClosed would still wait for it, and nothing would fire again).
          await settleParticipant(roomId, runId, participant, (planned) =>
            run.closeReason === 'completed'
              ? wasPresentThroughEnd(participant, run)
                ? { kind: 'complete', endedAtMs: run.closedAtMs ?? read.nowMs }
                : settlementForGraceExpiry(participant, planned)
              : settlementForClosedRun(participant, run, planned, read.nowMs),
          );
    return result === 'complete' ? 'completed' : result === 'abandon' ? 'abandoned' : 'stale';
  };

  // ---- Settlement of a closed run (RF3, RF6) ---------------------------------------------

  const settleRun: RoomFocusService['settleRun'] = async (roomId, runId) => {
    const read = await ledger.read(roomId, runId);
    const run = read.run;
    if (run === undefined) {
      // A lost run record can leave an index member or participant hash behind (Rev J5).
      await ledger.finishRun(roomId, runId);
      return 'gone';
    }
    if (run.status !== 'closed') {
      return 'gone';
    }
    const sessions = new Map(
      (await listRunSessions(db, roomId, runId)).map((row) => [row.id, row]),
    );
    let pending = 0;
    let failure: unknown;
    for (const participant of read.participants) {
      try {
        if (!sessions.has(participant.sessionId)) {
          // Ended already (or never durable): only the ledger entry is left to remove.
          await ledger.removeParticipant(roomId, runId, participant.userId, participant.sessionId);
          continue;
        }
        const result = await settleClosed(roomId, runId, participant, run, read.nowMs);
        if (result === 'pending') {
          pending += 1;
          await ensureGrace(roomId, runId, participant, read.nowMs);
        }
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) {
      throw failure instanceof Error ? failure : new Error('settling a room run failed');
    }
    if (pending > 0) {
      return 'pending_grace';
    }
    await ledger.finishRun(roomId, runId);
    return 'settled';
  };

  return {
    optIn,
    optOut,
    state,
    snapshot,
    participants,
    depart,
    userLeftRoom,
    userJoinedRoom,
    graceExpired,
    settleRun,
    onChange: (listener) => {
      listeners.push(listener);
    },
    beginDeparture: (userId, roomId, reason) => planDeparture(userId, roomId, reason, true),
  };
};
