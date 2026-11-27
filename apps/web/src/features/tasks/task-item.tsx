import { TASK_TITLE_MAX_LENGTH, taskTitleSchema, type TaskView } from '@focus-flow/contracts';
import { useState } from 'react';

import { INVALID_TITLE, taskErrorMessage } from './task-messages';
import { TaskMeta, TaskPlan } from './task-plan';
import {
  useCompleteTask,
  useDeleteTask,
  useRenameTask,
  useReopenTask,
  useSetCurrentTask,
} from './task-queries';

const BUTTON =
  'rounded-full border border-line bg-surface px-4 py-1.5 transition hover:bg-surface-strong text-sm disabled:opacity-50';

/**
 * One task and its actions. Each action waits for the server (no optimistic updates in
 * Phase 2): while any of them is in flight, the item's buttons are disabled. Starting an
 * action clears the outcome of earlier ones, so an old error never outlives a newer
 * action that succeeds.
 */
export function TaskItem({ task, isCurrent }: { task: TaskView; isCurrent: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.title);
  const [invalid, setInvalid] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // GL5, SP4, ES3: the task's plan (goal, estimate, steps), opened on demand.
  const [planning, setPlanning] = useState(false);

  const rename = useRenameTask();
  const complete = useCompleteTask();
  const reopen = useReopenTask();
  const remove = useDeleteTask();
  const makeCurrent = useSetCurrentTask();

  const mutations = [rename, complete, reopen, remove, makeCurrent];
  const pending = mutations.some((mutation) => mutation.isPending);
  const mutationError = mutations.find((mutation) => mutation.error !== null)?.error ?? null;
  const error = invalid
    ? INVALID_TITLE
    : mutationError === null
      ? null
      : taskErrorMessage(mutationError);

  /** Every mutating action goes through here: earlier errors are cleared first. */
  function run(action: () => void): void {
    for (const mutation of mutations) {
      mutation.reset();
    }
    setInvalid(false);
    action();
  }

  function saveRename(): void {
    const fields = taskTitleSchema.safeParse(draft);
    if (!fields.success) {
      setInvalid(true);
      return;
    }
    run(() => {
      rename.mutate(
        { taskId: task.id, title: fields.data },
        {
          onSuccess: () => {
            setEditing(false);
          },
        },
      );
    });
  }

  return (
    <li className="space-y-2 rounded-2xl border border-line bg-surface p-4" aria-label={task.title}>
      {editing ? (
        <form
          noValidate
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            saveRename();
          }}
        >
          <input
            aria-label="Task title"
            type="text"
            maxLength={TASK_TITLE_MAX_LENGTH}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            className="w-full rounded-full border border-line bg-surface px-4 py-1.5 transition hover:bg-surface-strong"
          />
          <button type="submit" disabled={pending} className={BUTTON}>
            {rename.isPending ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            disabled={pending}
            className={BUTTON}
            onClick={() => {
              setEditing(false);
              setInvalid(false);
              setDraft(task.title);
            }}
          >
            Cancel
          </button>
        </form>
      ) : (
        <p className={task.status === 'completed' ? 'text-muted line-through' : ''}>
          {task.title}
          {isCurrent && <span className="ml-2 text-xs font-semibold uppercase">Current</span>}
        </p>
      )}
      {!editing && <TaskMeta task={task} />}

      {!editing && !confirmingDelete && (
        <div className="flex flex-wrap gap-2">
          {task.status === 'open' && !isCurrent && (
            <button
              type="button"
              disabled={pending}
              className={BUTTON}
              onClick={() => {
                run(() => {
                  makeCurrent.mutate(task.id);
                });
              }}
            >
              Set as current
            </button>
          )}
          {task.status === 'open' ? (
            <button
              type="button"
              disabled={pending}
              className={BUTTON}
              onClick={() => {
                run(() => {
                  complete.mutate(task.id);
                });
              }}
            >
              {complete.isPending ? 'Completing…' : 'Complete'}
            </button>
          ) : (
            <button
              type="button"
              disabled={pending}
              className={BUTTON}
              onClick={() => {
                run(() => {
                  reopen.mutate(task.id);
                });
              }}
            >
              {reopen.isPending ? 'Reopening…' : 'Reopen'}
            </button>
          )}
          <button
            type="button"
            disabled={pending}
            className={BUTTON}
            onClick={() => {
              setDraft(task.title);
              setEditing(true);
            }}
          >
            Rename
          </button>
          <button
            type="button"
            aria-expanded={planning}
            className={BUTTON}
            onClick={() => {
              setPlanning((open) => !open);
            }}
          >
            {planning ? 'Close plan' : 'Plan'}
          </button>
          <button
            type="button"
            disabled={pending}
            className={BUTTON}
            onClick={() => {
              setConfirmingDelete(true);
            }}
          >
            Delete
          </button>
        </div>
      )}

      {confirmingDelete && (
        <div className="flex items-center gap-2 text-sm">
          <span>Delete this task?</span>
          <button
            type="button"
            disabled={pending}
            className={BUTTON}
            onClick={() => {
              run(() => {
                remove.mutate(task.id, {
                  onSettled: () => {
                    setConfirmingDelete(false);
                  },
                });
              });
            }}
          >
            {remove.isPending ? 'Deleting…' : 'Confirm delete'}
          </button>
          <button
            type="button"
            disabled={pending}
            className={BUTTON}
            onClick={() => {
              setConfirmingDelete(false);
            }}
          >
            Keep
          </button>
        </div>
      )}

      {error !== null && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {planning && !editing && <TaskPlan task={task} />}
    </li>
  );
}
