import type { TaskId, TaskView } from '@focus-flow/contracts';
import { useState } from 'react';

import { buttonClass, INPUT_CLASS } from '../../ui/primitives';
import { useAuth } from '../auth/auth-context';
import { useTask, useTaskList } from '../tasks/task-queries';
import { focusErrorMessage } from './focus-messages';
import { useStartFocusSession } from './focus-queries';
import { MAX_CUSTOM_MINUTES, MIN_CUSTOM_MINUTES, parseDurationMinutes } from './focus-time';

const PRESET_MINUTES = [15, 25, 50] as const;
const DEFAULT_PRESET = 25;

/** A preset chosen by radio, or the custom field once the user types in it. */
type Choice = { kind: 'preset'; minutes: number } | { kind: 'custom'; text: string };

/**
 * Starts a solo focus session. The task selector preselects the user's current task purely
 * as a convenience; the server never infers it (E3), so the choice is always sent
 * explicitly. If the chosen task changed meanwhile, the server's 404/409 is shown as is.
 */
export function StartSessionForm() {
  const { user } = useAuth();
  const currentTaskId = user?.currentTaskId ?? null;
  const openTasks = useTaskList('open');
  const currentTask = useTask(currentTaskId);
  const start = useStartFocusSession();

  const [choice, setChoice] = useState<Choice>({ kind: 'preset', minutes: DEFAULT_PRESET });
  const [taskChoice, setTaskChoice] = useState<string | null>(null);
  const [durationError, setDurationError] = useState<string | null>(null);

  // The first page of open tasks, plus the current task when it is open but on a later page.
  const options: TaskView[] = openTasks.data?.pages.flatMap((page) => page.tasks) ?? [];
  const current = currentTask.data;
  if (
    current !== undefined &&
    current.status === 'open' &&
    !options.some((task) => task.id === current.id)
  ) {
    options.unshift(current);
  }
  const wanted = taskChoice ?? currentTaskId ?? '';
  const selectedTaskId = options.some((task) => task.id === wanted) ? wanted : '';

  function submit(): void {
    const parsed =
      choice.kind === 'preset'
        ? ({ ok: true, plannedSeconds: choice.minutes * 60 } as const)
        : parseDurationMinutes(choice.text);
    if (!parsed.ok) {
      setDurationError(parsed.error);
      return;
    }
    setDurationError(null);
    start.reset();
    start.mutate(
      selectedTaskId === ''
        ? { plannedSeconds: parsed.plannedSeconds }
        : { plannedSeconds: parsed.plannedSeconds, taskId: selectedTaskId as TaskId },
    );
  }

  const error = durationError ?? (start.error === null ? null : focusErrorMessage(start.error));

  return (
    <form
      noValidate
      aria-label="Start a focus session"
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-medium text-muted">Duration</legend>
        <div className="grid grid-cols-3 gap-2">
          {PRESET_MINUTES.map((minutes) => (
            <label
              key={minutes}
              className="cursor-pointer rounded-2xl border border-line bg-surface px-3 py-4 text-center text-sm transition hover:bg-surface-strong has-[:checked]:border-focus has-[:checked]:bg-focus/15 has-[:checked]:shadow-glow has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus"
            >
              <input
                className="sr-only"
                type="radio"
                name="duration"
                checked={choice.kind === 'preset' && choice.minutes === minutes}
                onChange={() => {
                  setChoice({ kind: 'preset', minutes });
                  setDurationError(null);
                }}
              />
              {`${String(minutes)} minutes`}
            </label>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <label htmlFor="focus-custom-minutes" className="text-sm text-muted">
            Custom minutes
          </label>
          <input
            id="focus-custom-minutes"
            name="customMinutes"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            placeholder={`${String(MIN_CUSTOM_MINUTES)}–${String(MAX_CUSTOM_MINUTES)}`}
            value={choice.kind === 'custom' ? choice.text : ''}
            onChange={(event) => {
              setChoice({ kind: 'custom', text: event.target.value });
              setDurationError(null);
            }}
            className={INPUT_CLASS + ' max-w-28'}
          />
        </div>
      </fieldset>

      <div className="space-y-1">
        <label htmlFor="focus-task" className="block text-sm font-medium text-muted">
          Task
        </label>
        <select
          id="focus-task"
          name="taskId"
          value={selectedTaskId}
          onChange={(event) => {
            setTaskChoice(event.target.value);
          }}
          className={INPUT_CLASS}
        >
          <option value="">No task</option>
          {options.map((task) => (
            <option key={task.id} value={task.id}>
              {task.title}
            </option>
          ))}
        </select>
      </div>

      <button
        type="submit"
        disabled={start.isPending}
        className={buttonClass('primary', 'w-full py-3 text-base')}
      >
        {start.isPending ? 'Starting…' : 'Start focus'}
      </button>
      {error !== null && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </form>
  );
}
