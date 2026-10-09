import type { FocusSessionView, StartFocusSessionRequest } from '@focus-flow/contracts';
import { uuidv7 } from 'uuidv7';

import type { Db, Executor, Tx } from '../../db/client.js';
import { isUniqueViolation } from '../../db/pg-errors.js';
import { AppError } from '../../platform/http/errors.js';
import type { PresenceCheck } from '../presence/store.js';
import { lockOwnedTaskForShare } from '../tasks/queries.js';
import type { FocusSessionChanges, FocusSessionTransition } from './changes.js';
import {
  decideRunningSession,
  type DisconnectMarker,
  type PresenceObservation,
} from './decision.js';
import type { DisconnectMarkerStore } from './marker-store.js';
import {
  databaseNowMs,
  findInProgressSession,
  findOwnedSession,
  findSessionTask,
  type FocusSessionRow,
  insertRunningSession,
  lockOwnedSession,
  saveSession,
} from './queries.js';
import { toSessionChanges, toSoloSession } from './rows.js';
import {
  complete,
  hasReachedPlannedEnd,
  isPaused,
  isRunning,
  pause,
  plannedEndMs,
  resume,
  type RunningSession,
  startSession,
  stop,
  type Transition,
} from './timing.js';
import { toFocusSessionView } from './views.js';

// Solo focus sessions over REST (docs/architecture/focus-timing-protocol.md, "Solo
// sessions"; docs/api/rest.md, "Focus sessions"; E1–E16).
//
// Transaction rules:
// - Every change locks the session row (`SELECT … FOR UPDATE`) for its whole transaction,
//   so concurrent pause/resume/stop requests on one session queue instead of racing.
// - PostgreSQL now() is the clock for every stored value (E9).
// - Redis is read only for the presence checks the protocol requires: before the
//   transaction for start and resume ("user connected"), and inside it only at the
//   approved point — the decision for a running session (the disconnect marker and
//   checkUser) when a pause or stop arrives at or after the planned end (E7). Nothing is
//   written to Redis here.
// - Follow-up work (events, jobs, markers) runs only after the commit (`changes`).

export type FocusSessionsDeps = {
  readonly db: Db;
  /** The authoritative presence check (H2): one atomic Redis read with Redis TIME. */
  readonly checkUser: (userId: string) => Promise<PresenceCheck>;
  /** The current Redis epoch's creation time (Redis TIME), if known. */
  readonly epochCreatedAtMs: () => number | undefined;
  /** The disconnect marker (E10), read by the decision at or after the planned end. */
  readonly markers: Pick<DisconnectMarkerStore, 'read'>;
  readonly changes: FocusSessionChanges;
};

const sessionNotFound = (): AppError => new AppError('NOT_FOUND', 404, 'Focus session not found.');

const presenceUnavailable = (): AppError =>
  new AppError('INTERNAL', 503, 'Presence is temporarily unavailable. Try again shortly.');

const notConnected = (): AppError =>
  new AppError(
    'NOT_CONNECTED',
    409,
    'Focus Flow must be open and connected to start or resume a focus session.',
  );

/** A failed check is `undefined`: the protocol never decides on an unknown state (H2). */
export const observePresence = async (
  deps: FocusSessionsDeps,
  userId: string,
): Promise<PresenceObservation | undefined> => {
  try {
    const { online, checkedAtMs } = await deps.checkUser(userId);
    return { online, checkedAtMs };
  } catch {
    return undefined;
  }
};

/** Start and resume require a connected user (`409 NOT_CONNECTED`); unknown → 503. */
const requireConnected = async (deps: FocusSessionsDeps, userId: string): Promise<void> => {
  const presence = await observePresence(deps, userId);
  if (presence === undefined) {
    throw presenceUnavailable();
  }
  if (!presence.online) {
    throw notConnected();
  }
};

export const loadView = async (db: Executor, row: FocusSessionRow): Promise<FocusSessionView> =>
  toFocusSessionView(
    row,
    row.taskId === null ? undefined : await findSessionTask(db, row.userId, row.taskId),
  );

type Committed = {
  readonly view: FocusSessionView;
  /** `null` for a harmless repeat (E11): nothing changed, nothing is published. */
  readonly transition: FocusSessionTransition | null;
  readonly runningStretch: {
    readonly runningSinceMs: number;
    readonly plannedEndMs: number;
  } | null;
};

const publishCommitted = async (
  deps: FocusSessionsDeps,
  userId: string,
  committed: Committed,
): Promise<FocusSessionView> => {
  if (committed.transition !== null) {
    await deps.changes.publish({
      userId,
      transition: committed.transition,
      session: committed.view,
      runningStretch: committed.runningStretch,
    });
  }
  return committed.view;
};

const stretchOf = (session: RunningSession) => ({
  runningSinceMs: session.runningSinceMs,
  plannedEndMs: plannedEndMs(session),
});

/** Writes a changed transition and reads the view back, inside the caller's transaction. */
const commitTransition = async (
  tx: Tx,
  row: FocusSessionRow,
  transition: Transition,
  name: FocusSessionTransition,
): Promise<Committed> => {
  if (transition.outcome !== 'changed') {
    return { view: await loadView(tx, row), transition: null, runningStretch: null };
  }
  const saved = await saveSession(tx, row.id, toSessionChanges(transition.session));
  return {
    view: await loadView(tx, saved),
    transition: name,
    runningStretch: isRunning(transition.session) ? stretchOf(transition.session) : null,
  };
};

/**
 * `POST /focus-sessions`. The user must be connected; the optional task must be the
 * user's own, not deleted and open, and stays locked `FOR SHARE` until the session is
 * inserted (the same task-first lock order as the task routes), so a concurrent delete or
 * complete cannot slip in between (E3). The server never fills in the current task.
 *
 * The partial unique index decides "one in-progress session per user": the loser of a
 * race gets `409 SESSION_IN_PROGRESS` carrying the existing session, so a retried start
 * can recover it.
 */
export const startFocusSession = async (
  deps: FocusSessionsDeps,
  userId: string,
  request: StartFocusSessionRequest,
): Promise<FocusSessionView> => {
  await requireConnected(deps, userId);

  // One retry covers the in-progress session ending between the conflict and the read.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const committed = await deps.db.transaction(async (tx): Promise<Committed> => {
        const taskId = request.taskId ?? null;
        if (taskId !== null) {
          const task = await lockOwnedTaskForShare(tx, userId, taskId);
          if (task === undefined || task.deletedAt !== null) {
            throw new AppError('TASK_NOT_FOUND', 404, 'Task not found.');
          }
          if (task.completedAt !== null) {
            throw new AppError('TASK_NOT_OPEN', 409, 'Only an open task can be focused on.');
          }
        }
        const session = startSession(request.plannedSeconds, await databaseNowMs(tx));
        const row = await insertRunningSession(tx, {
          id: uuidv7(),
          userId,
          taskId,
          plannedSeconds: session.plannedSeconds,
          startedAtMs: session.startedAtMs,
        });
        return {
          view: await loadView(tx, row),
          transition: 'started',
          runningStretch: stretchOf(session),
        };
      });
      return await publishCommitted(deps, userId, committed);
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      const existing = await findInProgressSession(deps.db, userId);
      if (existing !== undefined) {
        throw new AppError('SESSION_IN_PROGRESS', 409, 'A focus session is already in progress.', {
          session: await loadView(deps.db, existing),
        });
      }
    }
  }
  throw new Error('startFocusSession: the in-progress session kept changing');
};

/** `GET /focus-sessions/current`: the in-progress session, or `null`. */
export const getCurrentFocusSession = async (
  deps: FocusSessionsDeps,
  userId: string,
): Promise<FocusSessionView | null> => {
  const row = await findInProgressSession(deps.db, userId);
  return row === undefined ? null : loadView(deps.db, row);
};

/**
 * E7: at or after the planned end, the completion decision runs before a pause or stop.
 * This is the one approved point where Redis is read inside the transaction (the marker,
 * then checkUser), while the row lock is held. The marker is read before this request's
 * own follow-up could clear it, so an observed disconnect through the end still completes
 * the session (E8).
 */
const completesAtPlannedEnd = async (
  deps: FocusSessionsDeps,
  userId: string,
  sessionId: string,
  session: RunningSession,
  nowMs: number,
): Promise<boolean> => {
  let marker: DisconnectMarker | undefined;
  try {
    marker = await deps.markers.read(userId);
  } catch {
    // An unreadable marker may hide the evidence of presence through the end: decide
    // nothing, like an unknown presence (H2).
    throw presenceUnavailable();
  }
  const presence = await observePresence(deps, userId);
  if (presence === undefined) {
    // Unknown presence decides nothing (H2): fail the request rather than record a pause
    // or stop that may have owed a completion.
    throw presenceUnavailable();
  }
  const { decision } = decideRunningSession({
    sessionId,
    session,
    nowMs,
    marker: marker ?? null,
    presence,
    epochCreatedAtMs: deps.epochCreatedAtMs(),
  });
  return decision.kind === 'complete';
};

const pauseOrStop = async (
  deps: FocusSessionsDeps,
  userId: string,
  sessionId: string,
  action: 'pause' | 'stop',
): Promise<FocusSessionView> => {
  const committed = await deps.db.transaction(async (tx): Promise<Committed> => {
    const row = await lockOwnedSession(tx, userId, sessionId);
    if (row === undefined) {
      throw sessionNotFound();
    }
    const session = toSoloSession(row);
    const nowMs = await databaseNowMs(tx);
    if (
      isRunning(session) &&
      hasReachedPlannedEnd(session, nowMs) &&
      (await completesAtPlannedEnd(deps, userId, row.id, session, nowMs))
    ) {
      return commitTransition(tx, row, complete(session, nowMs), 'completed');
    }
    return action === 'pause'
      ? commitTransition(tx, row, pause(session, nowMs), 'paused')
      : commitTransition(tx, row, stop(session, nowMs), 'stopped');
  });
  return publishCommitted(deps, userId, committed);
};

/** `POST /focus-sessions/:id/pause`. Paused or ended → `200` unchanged (E11). */
export const pauseFocusSession = (
  deps: FocusSessionsDeps,
  userId: string,
  sessionId: string,
): Promise<FocusSessionView> => pauseOrStop(deps, userId, sessionId, 'pause');

/** `POST /focus-sessions/:id/stop` → `abandoned(stopped)`. Ended → `200` unchanged (E11). */
export const stopFocusSession = (
  deps: FocusSessionsDeps,
  userId: string,
  sessionId: string,
): Promise<FocusSessionView> => pauseOrStop(deps, userId, sessionId, 'stop');

/**
 * `POST /focus-sessions/:id/resume`. Running or ended → `200` unchanged (E11); a paused
 * session needs a connected user. Presence is checked before the transaction (Redis stays
 * out of it); if the session became paused only after that read, the check runs and the
 * transaction is retried.
 */
export const resumeFocusSession = async (
  deps: FocusSessionsDeps,
  userId: string,
  sessionId: string,
): Promise<FocusSessionView> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await findOwnedSession(deps.db, userId, sessionId);
    if (current === undefined) {
      throw sessionNotFound();
    }
    const connectedChecked = isPaused(toSoloSession(current));
    if (connectedChecked) {
      await requireConnected(deps, userId);
    }
    const committed = await deps.db.transaction(async (tx): Promise<Committed | undefined> => {
      const row = await lockOwnedSession(tx, userId, sessionId);
      if (row === undefined) {
        throw sessionNotFound();
      }
      const session = toSoloSession(row);
      if (isPaused(session) && !connectedChecked) {
        return undefined; // Became paused since the read: check presence first.
      }
      return commitTransition(tx, row, resume(session, await databaseNowMs(tx)), 'resumed');
    });
    if (committed !== undefined) {
      return publishCommitted(deps, userId, committed);
    }
  }
  throw new Error('resumeFocusSession: the session kept changing');
};
