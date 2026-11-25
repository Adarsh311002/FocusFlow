import {
  GOAL_TITLE_MAX_LENGTH,
  GOAL_WHY_MAX_LENGTH,
  type GoalColor,
  type GoalView,
  TASK_TITLE_MAX_LENGTH,
} from '@focus-flow/contracts';
import { useId, useState } from 'react';

import { buttonClass, Eyebrow, INPUT_CLASS } from '../../ui/primitives';
import { formatDuration } from '../review/review-format';
import { useCreateTask, useTaskList } from '../tasks/task-queries';
import { GOAL_COLORS, untilLabel, useCreateGoal, useGoals, useUpdateGoal } from './goals-data';

// `/goals` (GL5): what the tasks are for. Each goal shows its progress (tasks done of all,
// focus spent), its tasks, and a way to add one; finished goals are completed or archived.

function NewGoal() {
  const create = useCreateGoal();
  const [title, setTitle] = useState('');
  const [why, setWhy] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [color, setColor] = useState<GoalColor>('leaf');
  const titleId = useId();
  const whyId = useId();
  const dateId = useId();
  return (
    <form
      aria-label="New goal"
      className="space-y-4 rounded-[2rem] border border-line bg-surface p-6 shadow-card backdrop-blur-xl"
      onSubmit={(event) => {
        event.preventDefault();
        if (title.trim() === '') {
          return;
        }
        create.mutate(
          {
            title,
            ...(why.trim() === '' ? {} : { why }),
            ...(targetDate === '' ? {} : { targetDate }),
            color,
          },
          {
            onSuccess: () => {
              setTitle('');
              setWhy('');
              setTargetDate('');
            },
          },
        );
      }}
    >
      <h3 className="font-display text-3xl">A new goal</h3>
      <div>
        <label htmlFor={titleId} className="mb-1 block text-sm text-muted">
          What do you want to reach?
        </label>
        <input
          id={titleId}
          type="text"
          value={title}
          maxLength={GOAL_TITLE_MAX_LENGTH}
          placeholder="e.g. Ship the beta"
          onChange={(event) => {
            setTitle(event.target.value);
          }}
          className={INPUT_CLASS}
        />
      </div>
      <div>
        <label htmlFor={whyId} className="mb-1 block text-sm text-muted">
          Why it matters (optional)
        </label>
        <input
          id={whyId}
          type="text"
          value={why}
          maxLength={GOAL_WHY_MAX_LENGTH}
          onChange={(event) => {
            setWhy(event.target.value);
          }}
          className={INPUT_CLASS}
        />
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <label htmlFor={dateId} className="mb-1 block text-sm text-muted">
            By (optional)
          </label>
          <input
            id={dateId}
            type="date"
            value={targetDate}
            onChange={(event) => {
              setTargetDate(event.target.value);
            }}
            className={INPUT_CLASS}
          />
        </div>
        <fieldset>
          <legend className="mb-1 text-sm text-muted">Color</legend>
          <div className="flex gap-2">
            {(Object.keys(GOAL_COLORS) as GoalColor[]).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={color === option}
                aria-label={GOAL_COLORS[option].name}
                onClick={() => {
                  setColor(option);
                }}
                className={`h-8 w-8 rounded-full border-2 transition ${
                  color === option ? 'scale-110 border-ink' : 'border-transparent'
                }`}
                style={{ background: GOAL_COLORS[option].swatch }}
              />
            ))}
          </div>
        </fieldset>
      </div>
      <button
        type="submit"
        disabled={create.isPending || title.trim() === ''}
        className={buttonClass('primary', 'px-6 py-2.5')}
      >
        {create.isPending ? 'Planting…' : 'Add goal'}
      </button>
      {create.isError && (
        <p role="alert" className="text-sm text-danger">
          That did not save. Try again.
        </p>
      )}
    </form>
  );
}

function GoalTasks({ goal }: { readonly goal: GoalView }) {
  const open = useTaskList('open', goal.id);
  const create = useCreateTask();
  const [title, setTitle] = useState('');
  const inputId = useId();
  const tasks = open.data?.pages.flatMap((page) => page.tasks) ?? [];
  return (
    <div className="space-y-3">
      {tasks.length === 0 ? (
        <p className="text-sm text-muted">No open tasks for this goal.</p>
      ) : (
        <ul aria-label={`Open tasks of ${goal.title}`} className="space-y-1 text-sm">
          {tasks.map((task) => (
            <li key={task.id} className="flex items-baseline justify-between gap-3">
              <span>{task.title}</span>
              {task.estimatedSessions !== null && task.estimatedSessions !== undefined && (
                <span className="text-xs text-muted">
                  {`${String(task.sessionsSpent ?? 0)}/${String(task.estimatedSessions)} sessions`}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {goal.status === 'active' && (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (title.trim() !== '') {
              create.mutate(
                { title, goalId: goal.id },
                {
                  onSuccess: () => {
                    setTitle('');
                  },
                },
              );
            }
          }}
        >
          <label htmlFor={inputId} className="sr-only">
            {`A new task for ${goal.title}`}
          </label>
          <input
            id={inputId}
            type="text"
            value={title}
            maxLength={TASK_TITLE_MAX_LENGTH}
            placeholder="Next task toward this goal…"
            onChange={(event) => {
              setTitle(event.target.value);
            }}
            className={INPUT_CLASS}
          />
          <button
            type="submit"
            disabled={create.isPending || title.trim() === ''}
            className={buttonClass('ghost', 'shrink-0 whitespace-nowrap px-4 py-2 text-xs')}
          >
            Add
          </button>
        </form>
      )}
    </div>
  );
}

function GoalCard({ goal }: { readonly goal: GoalView }) {
  const update = useUpdateGoal();
  const [open, setOpen] = useState(false);
  const { openTasks, completedTasks, focusedSeconds } = goal.progress;
  const total = openTasks + completedTasks;
  const share = total === 0 ? 0 : completedTasks / total;
  const swatch = GOAL_COLORS[goal.color].swatch;
  const setStatus = (status: GoalView['status']) => {
    update.mutate({ goalId: goal.id, changes: { status } });
  };
  return (
    <li
      aria-label={goal.title}
      className={`space-y-4 rounded-[2rem] border bg-surface p-6 shadow-card ${
        goal.status === 'active' ? 'border-line' : 'border-line opacity-75'
      }`}
      style={{ borderLeft: `6px solid ${swatch}` }}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="font-display text-3xl">{goal.title}</p>
          {goal.why !== null && <p className="text-sm text-muted italic">{goal.why}</p>}
        </div>
        <p className="text-xs text-muted">
          {goal.status === 'completed'
            ? '✓ Reached'
            : goal.targetDate === null
              ? 'No date'
              : `By ${goal.targetDate} · ${untilLabel(goal.targetDate)}`}
        </p>
      </div>
      <div className="space-y-1.5">
        <div className="h-2 overflow-hidden rounded-full bg-line">
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${String(Math.round(share * 100))}%`, background: swatch }}
          />
        </div>
        <p className="text-xs text-muted">
          {`${String(completedTasks)} of ${String(total)} tasks done · ${formatDuration(focusedSeconds)} focused`}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            setOpen((value) => !value);
          }}
          className={buttonClass('ghost', 'px-4 py-1.5 text-xs')}
        >
          {open ? 'Hide tasks' : 'Tasks'}
        </button>
        {goal.status === 'active' ? (
          <>
            <button
              type="button"
              disabled={update.isPending}
              onClick={() => {
                setStatus('completed');
              }}
              className={buttonClass('ghost', 'px-4 py-1.5 text-xs')}
            >
              Mark reached
            </button>
            <button
              type="button"
              disabled={update.isPending}
              onClick={() => {
                setStatus('archived');
              }}
              className="px-2 text-xs text-muted underline-offset-4 hover:text-ink hover:underline"
            >
              Archive
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={update.isPending}
            onClick={() => {
              setStatus('active');
            }}
            className={buttonClass('ghost', 'px-4 py-1.5 text-xs')}
          >
            Make active again
          </button>
        )}
      </div>
      {open && <GoalTasks goal={goal} />}
    </li>
  );
}

export function GoalsPage() {
  const goals = useGoals();
  const [showArchived, setShowArchived] = useState(false);
  const archived = useGoals({ archived: showArchived });
  const list = (showArchived ? archived.data : goals.data) ?? [];
  return (
    <div className="space-y-10">
      <div>
        <Eyebrow>( Goals )</Eyebrow>
        <h2 className="font-display mt-3 text-6xl md:text-7xl">
          What it is <em className="text-focus">all for.</em>
        </h2>
        <p className="mt-4 max-w-2xl text-muted">
          A goal gathers the tasks that serve it. Each session on one of them moves the goal
          forward, and its progress shows here.
        </p>
      </div>
      <div className="grid items-start gap-10 lg:grid-cols-12">
        <div className="space-y-4 lg:col-span-7">
          {goals.isPending && <p className="text-muted">Gathering your goals…</p>}
          {goals.isSuccess && list.length === 0 && (
            <p className="text-muted">
              No goals yet. Name the first one, and give your tasks a why.
            </p>
          )}
          <ul className="space-y-4">
            {list.map((goal) => (
              <GoalCard key={goal.id} goal={goal} />
            ))}
          </ul>
          <button
            type="button"
            aria-pressed={showArchived}
            onClick={() => {
              setShowArchived((value) => !value);
            }}
            className="text-sm text-muted underline-offset-4 hover:text-ink hover:underline"
          >
            {showArchived ? 'Hide archived goals' : 'Show archived goals too'}
          </button>
        </div>
        <div className="lg:col-span-5">
          <NewGoal />
        </div>
      </div>
    </div>
  );
}
