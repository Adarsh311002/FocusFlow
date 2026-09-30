import { createTaskRequestSchema, TASK_TITLE_MAX_LENGTH } from '@focus-flow/contracts';
import { useState } from 'react';

import { INVALID_TITLE, taskErrorMessage } from './task-messages';
import { useCreateTask } from './task-queries';

export function NewTaskForm() {
  const [title, setTitle] = useState('');
  const [invalid, setInvalid] = useState(false);
  const create = useCreateTask();

  function submit(): void {
    // The same contract schema the API validates against (trimmed, 1-200 characters).
    const fields = createTaskRequestSchema.safeParse({ title });
    if (!fields.success) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    create.mutate(fields.data.title, {
      onSuccess: () => {
        setTitle('');
      },
    });
  }

  const error = invalid
    ? INVALID_TITLE
    : create.error === null
      ? null
      : taskErrorMessage(create.error);

  return (
    <form
      noValidate
      aria-label="Add a task"
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label htmlFor="new-task-title" className="block text-sm font-medium">
        New task
      </label>
      <div className="flex gap-2">
        <input
          id="new-task-title"
          name="title"
          type="text"
          autoComplete="off"
          maxLength={TASK_TITLE_MAX_LENGTH}
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
          }}
          className="w-full rounded border border-slate-300 px-2 py-1"
        />
        <button
          type="submit"
          disabled={create.isPending}
          className="rounded bg-slate-900 px-3 py-1 text-white disabled:opacity-50"
        >
          {create.isPending ? 'Adding…' : 'Add'}
        </button>
      </div>
      {error !== null && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </form>
  );
}
