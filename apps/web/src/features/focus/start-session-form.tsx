import {
  type StartFocusSessionRequest,
  TASK_TITLE_MAX_LENGTH,
  type TaskId,
  type TaskView,
} from '@focus-flow/contracts';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';

import { buttonClass, INPUT_CLASS } from '../../ui/primitives';
import { useAuth } from '../auth/auth-context';
import { claimDeepFocus, enterFullscreen, exitFullscreen } from '../deep-focus/browser';
import { SettleIn } from '../deep-focus/settle-in';
import { SoundPicker } from '../deep-focus/sound-picker';
import { stopAllSounds } from '../deep-focus/sounds';
import { useAdoptIntention } from '../intention/intention-queries';
import { useTask, useTaskList } from '../tasks/task-queries';
import { focusErrorMessage } from './focus-messages';
import { useStartFocusSession } from './focus-queries';
import { MAX_CUSTOM_MINUTES, MIN_CUSTOM_MINUTES, parseDurationMinutes } from './focus-time';

const PRESET_MINUTES = [15, 25, 50] as const;
const DEFAULT_PRESET = 25;

/** A preset chosen by radio, or the custom field once the user types in it. */
type Choice = { kind: 'preset'; minutes: number } | { kind: 'custom'; text: string };

/**
 * Starts a solo focus session. It first asks what the session is for: a new intention
 * becomes a task (and the current task) that the session is started on; otherwise the
 * task selector preselects the user's current task purely as a convenience. The server
 * never infers the task (E3), so the choice is always sent explicitly. If the chosen task
 * changed meanwhile, the server's 404/409 is shown as is.
 *
 * With `deep` it starts a Deep Focus session instead (DF1, DF5), on the /deep-focus page:
 * focus sounds to choose, full screen, and the settle-in breath before the session starts.
 */
export function StartSessionForm({ deep = false }: { readonly deep?: boolean }) {
  const { user } = useAuth();
  const currentTaskId = user?.currentTaskId ?? null;
  const openTasks = useTaskList('open');
  const currentTask = useTask(currentTaskId);
  const start = useStartFocusSession();

  // ST3: the form opens at the user's default length (a preset, or the custom field).
  const [choice, setChoice] = useState<Choice>(() => {
    const minutes = (user?.defaultSessionSeconds ?? DEFAULT_PRESET * 60) / 60;
    return (PRESET_MINUTES as readonly number[]).includes(minutes)
      ? { kind: 'preset', minutes }
      : { kind: 'custom', text: String(minutes) };
  });
  const [taskChoice, setTaskChoice] = useState<string | null>(null);
  const [durationError, setDurationError] = useState<string | null>(null);
  const [intention, setIntention] = useState('');
  const adopt = useAdoptIntention();
  // DF5: the breath before a Deep Focus session starts.
  const [settling, setSettling] = useState<StartFocusSessionRequest | null>(null);
  // The sounds chosen here go on into the session; leaving the page without starting one
  // silences them.
  const startingDeep = useRef(false);
  useEffect(
    () => () => {
      if (deep && !startingDeep.current) {
        stopAllSounds();
      }
    },
    [deep],
  );

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

  function cancelSettling(): void {
    setSettling(null);
    exitFullscreen();
  }

  async function submit(): Promise<void> {
    if (deep) {
      // It needs this very click: browsers refuse full screen without one.
      enterFullscreen();
    }
    const parsed =
      choice.kind === 'preset'
        ? ({ ok: true, plannedSeconds: choice.minutes * 60 } as const)
        : parseDurationMinutes(choice.text);
    if (!parsed.ok) {
      setDurationError(parsed.error);
      if (deep) {
        cancelSettling();
      }
      return;
    }
    setDurationError(null);
    start.reset();
    adopt.reset();
    let taskId = selectedTaskId === '' ? null : (selectedTaskId as TaskId);
    const named = intention.trim();
    if (named !== '') {
      try {
        taskId = (await adopt.mutateAsync(named)).id;
        setIntention('');
      } catch {
        if (deep) {
          cancelSettling();
        }
        return; // Shown below; nothing was started.
      }
    }
    const request: StartFocusSessionRequest =
      taskId === null
        ? { plannedSeconds: parsed.plannedSeconds }
        : { plannedSeconds: parsed.plannedSeconds, taskId };
    if (deep) {
      setSettling({ ...request, deepFocus: true });
      return;
    }
    start.mutate(request);
  }

  function startDeep(request: StartFocusSessionRequest): void {
    setSettling(null);
    startingDeep.current = true;
    start.mutate(request, {
      onSuccess: (session) => {
        // This tab watches the session (another tab of the app would be hidden).
        if (session.deepFocus !== undefined) {
          claimDeepFocus(session.id);
        }
      },
      onError: () => {
        startingDeep.current = false;
        exitFullscreen();
      },
    });
  }

  const naming = intention.trim() !== '';
  const pending = start.isPending || adopt.isPending;
  const error =
    durationError ??
    (adopt.error === null
      ? start.error === null
        ? null
        : focusErrorMessage(start.error)
      : 'Your intention could not be saved, so the session did not start. Try again.');

  return (
    <form
      noValidate
      aria-label="Start a focus session"
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="space-y-2">
        <label htmlFor="focus-intention" className="font-display block text-2xl leading-snug">
          What will you finish in this session?
        </label>
        <input
          id="focus-intention"
          name="intention"
          type="text"
          autoComplete="off"
          maxLength={TASK_TITLE_MAX_LENGTH}
          value={intention}
          placeholder="Name one thing, e.g. Draft the intro section"
          onChange={(event) => {
            setIntention(event.target.value);
          }}
          className={INPUT_CLASS + ' py-3 text-base'}
        />
      </div>

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
          {naming ? 'Task (your intention will become a new task)' : 'Task'}
        </label>
        <select
          id="focus-task"
          name="taskId"
          disabled={naming}
          value={naming ? '' : selectedTaskId}
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

      {deep ? (
        <div className="space-y-2">
          <p className="text-sm font-medium text-muted">
            Focus sounds (choose any, they play together)
          </p>
          <SoundPicker tone="light" />
        </div>
      ) : (
        <p className="text-xs text-muted">
          Want no way out?{' '}
          <Link to="/deep-focus" className="text-focus underline underline-offset-4">
            Try Deep Focus
          </Link>
          : full screen, no tab switching.
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className={buttonClass('primary', 'w-full py-3 text-base')}
      >
        {pending ? 'Starting…' : deep ? 'Start Deep Focus' : 'Start focus'}
      </button>
      {settling !== null && (
        <SettleIn
          onDone={() => {
            startDeep(settling);
          }}
          onCancel={cancelSettling}
        />
      )}
      {!naming && selectedTaskId === '' && (
        <p className="text-xs text-muted">
          No intention yet. You can start anyway, but naming one thing makes the time count.
        </p>
      )}
      {error !== null && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </form>
  );
}
