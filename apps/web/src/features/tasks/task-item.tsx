import {
  TASK_TITLE_MAX_LENGTH,
  type TaskView,
  updateTaskRequestSchema,
} from '@focus-flow/contracts';
import { useState } from 'react';

import { INVALID_TITLE, taskErrorMessage } from './task-messages';
import {
  useCompleteTask,
  useDeleteTask,
  useRenameTask,
  useReopenTask,
  useSetCurrentTask,
} from './task-queries';

const BUTTON = 'rounded border border-slate-300 px-2 py-0.5 text-sm disabled:opacity-50';

/**
 * One task and its actions. Each action waits for the server (no optimistic updates in
 * Phase 2): while any of them is in flight, the item's buttons are disabled.
 */
export function TaskItem({ task, isCurrent }: { task: TaskView; isCurrent: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.title);
  const [invalid, setInvalid] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

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

  function saveRename(): void {
    const fields = updateTaskRequestSchema.safeParse({ title: draft });
    if (!fields.success) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    rename.mutate(
      { taskId: task.id, title: fields.data.title },
      {
        onSuccess: () => {
          setEditing(false);
        },
      },
    );
  }

  return (
    <li className="space-y-2 rounded border border-slate-200 p-3" aria-label={task.title}>
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
            className="w-full rounded border border-slate-300 px-2 py-1"
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
        <p className={task.status === 'completed' ? 'text-slate-500 line-through' : ''}>
          {task.title}
          {isCurrent && <span className="ml-2 text-xs font-semibold uppercase">Current</span>}
        </p>
      )}

      {!editing && !confirmingDelete && (
        <div className="flex flex-wrap gap-2">
          {task.status === 'open' && !isCurrent && (
            <button
              type="button"
              disabled={pending}
              className={BUTTON}
              onClick={() => {
                makeCurrent.mutate(task.id);
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
                complete.mutate(task.id);
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
                reopen.mutate(task.id);
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
              remove.mutate(task.id, {
                onSettled: () => {
                  setConfirmingDelete(false);
                },
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
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </li>
  );
}
