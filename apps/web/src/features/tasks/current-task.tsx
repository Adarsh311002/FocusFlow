import { useEffect, useRef } from 'react';

import { useAuth } from '../auth/auth-context';
import {
  CURRENT_TASK_GONE,
  CURRENT_TASK_SYNC_FAILED,
  isTaskNotFound,
  taskErrorMessage,
} from './task-messages';
import { useCompleteTask, useSetCurrentTask, useTask } from './task-queries';

const PRIMARY = 'rounded bg-slate-900 px-3 py-1 text-sm text-white disabled:opacity-50';
const SECONDARY = 'rounded border border-slate-300 px-3 py-1 text-sm disabled:opacity-50';

/**
 * The first thing on the dashboard: what the user decided to work on (D3). It is read by
 * id (`GET /tasks/:taskId`), so it shows even when the task is not on a loaded list page.
 *
 * If that read says the task no longer exists (deleted in another tab or device), the
 * server has already cleared it as the current task (D38), so the user shown here is
 * stale: it is re-read once from `GET /me`. The card always offers "Clear current task"
 * as a recovery action, in case that re-read cannot complete.
 */
export function CurrentTask() {
  const { user, reloadUser, userSyncFailed } = useAuth();
  const currentTaskId = user?.currentTaskId ?? null;
  const task = useTask(currentTaskId);
  const clear = useSetCurrentTask();
  const complete = useCompleteTask();
  const pending = clear.isPending || complete.isPending;
  const mutationError = clear.error ?? complete.error;
  const currentTaskGone = currentTaskId !== null && isTaskNotFound(task.error);

  // Re-read the user once per missing task id, never in a loop.
  const resyncedFor = useRef<string | null>(null);
  useEffect(() => {
    if (currentTaskGone && resyncedFor.current !== currentTaskId) {
      resyncedFor.current = currentTaskId;
      void reloadUser();
    }
  }, [currentTaskGone, currentTaskId, reloadUser]);

  /** A new action replaces the outcome of the previous one, including its error. */
  function run(action: () => void): void {
    clear.reset();
    complete.reset();
    action();
  }

  const clearButton = (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        run(() => {
          clear.mutate(null);
        });
      }}
      className={SECONDARY}
    >
      {clear.isPending ? 'Clearing…' : 'Clear current task'}
    </button>
  );

  let body;
  if (currentTaskId === null) {
    body = (
      <p className="text-slate-600">
        No current task. Choose one of your open tasks below to focus on it.
      </p>
    );
  } else if (task.isPending) {
    body = <p className="text-slate-600">Loading your current task…</p>;
  } else if (task.isError) {
    body = (
      <div className="space-y-3">
        <p role="alert" className="text-sm text-red-700">
          {currentTaskGone ? CURRENT_TASK_GONE : taskErrorMessage(task.error)}
        </p>
        {clearButton}
      </div>
    );
  } else {
    const taskId = task.data.id;
    body = (
      <div className="space-y-3">
        <p className="text-lg font-semibold">{task.data.title}</p>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              run(() => {
                complete.mutate(taskId);
              });
            }}
            className={PRIMARY}
          >
            {complete.isPending ? 'Completing…' : 'Mark complete'}
          </button>
          {clearButton}
        </div>
      </div>
    );
  }

  return (
    <section
      aria-labelledby="current-task-heading"
      className="space-y-2 rounded-md border-2 border-slate-900 p-4"
    >
      <h3 id="current-task-heading" className="text-sm font-semibold uppercase text-slate-600">
        Current task
      </h3>
      {body}
      {mutationError !== null && (
        <p role="alert" className="text-sm text-red-700">
          {taskErrorMessage(mutationError)}
        </p>
      )}
      {userSyncFailed && (
        // Non-blocking: the change that preceded it succeeded; only the refresh of the
        // user (and so of this card) did not.
        <div role="status" className="flex items-center gap-2 text-sm text-amber-800">
          <span>{CURRENT_TASK_SYNC_FAILED}</span>
          <button
            type="button"
            onClick={() => {
              void reloadUser();
            }}
            className={SECONDARY}
          >
            Retry
          </button>
        </div>
      )}
    </section>
  );
}
