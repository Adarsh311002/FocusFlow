import { useAuth } from '../auth/auth-context';
import { taskErrorMessage } from './task-messages';
import { useCompleteTask, useSetCurrentTask, useTask } from './task-queries';

/**
 * The first thing on the dashboard: what the user decided to work on (D3). It is read by
 * id (`GET /tasks/:taskId`), so it shows even when the task is not on a loaded list page.
 */
export function CurrentTask() {
  const { user } = useAuth();
  const currentTaskId = user?.currentTaskId ?? null;
  const task = useTask(currentTaskId);
  const clear = useSetCurrentTask();
  const complete = useCompleteTask();
  const pending = clear.isPending || complete.isPending;
  const mutationError = clear.error ?? complete.error;

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
      <p role="alert" className="text-sm text-red-700">
        {taskErrorMessage(task.error)}
      </p>
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
              complete.mutate(taskId);
            }}
            className="rounded bg-slate-900 px-3 py-1 text-sm text-white disabled:opacity-50"
          >
            {complete.isPending ? 'Completing…' : 'Mark complete'}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              clear.mutate(null);
            }}
            className="rounded border border-slate-300 px-3 py-1 text-sm disabled:opacity-50"
          >
            {clear.isPending ? 'Clearing…' : 'Clear current task'}
          </button>
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
    </section>
  );
}
