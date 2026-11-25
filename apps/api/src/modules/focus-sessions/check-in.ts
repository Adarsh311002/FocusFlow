import type { CheckInOutcome, FocusSessionView } from '@focus-flow/contracts';

import { AppError } from '../../platform/http/errors.js';
import { clearCurrentTaskIfMatches, markTaskCompleted } from '../tasks/queries.js';
import { lockOwnedSession, saveCheckIn } from './queries.js';
import { type FocusSessionsDeps, loadView } from './service.js';

// The session check-in (CI1–CI4): after a session ends, the user says how it went. It is the
// user's own account and never changes the session's status or focused time, which stay the
// server's record of time. Solo and room sessions alike.

export type CheckInInput = {
  readonly outcome: CheckInOutcome;
  /** Already trimmed by the contract; `null` for no note. */
  readonly note: string | null;
};

const sessionNotFound = (): AppError => new AppError('NOT_FOUND', 404, 'Focus session not found.');

const sessionNotEnded = (): AppError =>
  new AppError('SESSION_NOT_ENDED', 409, 'A session can be checked in only after it has ended.');

/**
 * `PUT /focus-sessions/:sessionId/check-in` (CI2). Another user's or an unknown session is
 * 404; an in-progress one is `409 SESSION_NOT_ENDED`. A later check-in replaces the earlier
 * one.
 *
 * CI3: `done` also completes the session's task when it is still the user's, not deleted and
 * open, and clears it as the current task (D43), in the same transaction. Any other outcome,
 * or changing `done` to something else later, never touches the task (a task is reopened
 * only on purpose, from the task list).
 *
 * Lock order: the session row, then the task row, then the user row. Every path that locks a
 * task and then a user (complete, delete, set current) does so in that order too, and no path
 * locks a task before an existing session row, so this cannot deadlock with them.
 */
export const checkInFocusSession = async (
  deps: FocusSessionsDeps,
  userId: string,
  sessionId: string,
  input: CheckInInput,
): Promise<FocusSessionView> => {
  const view = await deps.db.transaction(async (tx) => {
    const row = await lockOwnedSession(tx, userId, sessionId);
    if (row === undefined) {
      throw sessionNotFound();
    }
    if (row.status === 'in_progress') {
      throw sessionNotEnded();
    }
    const saved = await saveCheckIn(tx, row.id, input);
    if (input.outcome === 'done' && saved.taskId !== null) {
      const completed = await markTaskCompleted(tx, userId, saved.taskId);
      if (completed !== undefined) {
        await clearCurrentTaskIfMatches(tx, userId, saved.taskId);
      }
    }
    return loadView(tx, saved);
  });
  await deps.changes.publish({
    userId,
    transition: 'checked_in',
    session: view,
    runningStretch: null,
  });
  return view;
};
