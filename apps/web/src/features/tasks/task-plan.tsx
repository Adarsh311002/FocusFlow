import {
  TASK_ESTIMATE_MAX,
  TASK_STEPS_MAX,
  TASK_TITLE_MAX_LENGTH,
  type TaskView,
} from '@focus-flow/contracts';
import { useId, useState } from 'react';

import { buttonClass, INPUT_CLASS } from '../../ui/primitives';
import { HelpMeStart } from '../ai/help-me-start';
import { GOAL_COLORS, useGoals } from '../goals/goals-data';
import { useStepMutation, useTaskSteps, useUpdateTask } from './task-queries';

// A task's plan (GL5, SP4, ES3): which goal it serves, how many sessions it should take, and
// its steps. Opened from the task; every change is saved at once and the lists refresh.

/** The one-line summary under a task: its goal, sessions against the estimate, steps. */
export function TaskMeta({ task }: { readonly task: TaskView }) {
  const goals = useGoals();
  const goal = goals.data?.find((entry) => entry.id === task.goalId);
  const spent = task.sessionsSpent ?? 0;
  const estimate = task.estimatedSessions ?? null;
  const steps = task.steps ?? { total: 0, done: 0 };
  const parts: { key: string; node: React.ReactNode }[] = [];
  if (goal !== undefined) {
    parts.push({
      key: 'goal',
      node: (
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="h-2 w-2 rounded-full"
            style={{ background: GOAL_COLORS[goal.color].swatch }}
          />
          {goal.title}
        </span>
      ),
    });
  }
  if (estimate !== null || spent > 0) {
    parts.push({
      key: 'sessions',
      node: (
        <span className={estimate !== null && spent > estimate ? 'text-warm' : undefined}>
          {estimate === null
            ? `${String(spent)} ${spent === 1 ? 'session' : 'sessions'}`
            : `${String(spent)}/${String(estimate)} sessions`}
        </span>
      ),
    });
  }
  if (steps.total > 0) {
    parts.push({ key: 'steps', node: `${String(steps.done)}/${String(steps.total)} steps` });
  }
  if (parts.length === 0) {
    return null;
  }
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
      {parts.map((part, index) => (
        <span key={part.key} className="inline-flex items-center gap-3">
          {index > 0 && <span aria-hidden="true">·</span>}
          {part.node}
        </span>
      ))}
    </p>
  );
}

export function TaskPlan({ task }: { readonly task: TaskView }) {
  const goals = useGoals();
  const update = useUpdateTask();
  const steps = useTaskSteps(task.id);
  const stepWrite = useStepMutation();
  const [newStep, setNewStep] = useState('');
  const goalId = useId();
  const estimateId = useId();
  const stepId = useId();
  const active = (goals.data ?? []).filter(
    (goal) => goal.status === 'active' || goal.id === task.goalId,
  );
  const list = steps.data ?? [];

  return (
    <div className="space-y-4 rounded-xl border border-line bg-canvas/40 p-3">
      <div className="flex flex-wrap gap-3">
        <div className="min-w-[10rem] flex-1">
          <label htmlFor={goalId} className="mb-1 block text-xs text-muted">
            Goal
          </label>
          <select
            id={goalId}
            value={task.goalId ?? ''}
            disabled={update.isPending}
            onChange={(event) => {
              update.mutate({
                taskId: task.id,
                changes: { goalId: event.target.value === '' ? null : event.target.value },
              });
            }}
            className={INPUT_CLASS}
          >
            <option value="">No goal</option>
            {active.map((goal) => (
              <option key={goal.id} value={goal.id}>
                {goal.title}
              </option>
            ))}
          </select>
        </div>
        <div className="w-36">
          <label htmlFor={estimateId} className="mb-1 block text-xs text-muted">
            Sessions it should take
          </label>
          <select
            id={estimateId}
            value={
              task.estimatedSessions === null || task.estimatedSessions === undefined
                ? ''
                : String(task.estimatedSessions)
            }
            disabled={update.isPending}
            onChange={(event) => {
              update.mutate({
                taskId: task.id,
                changes: {
                  estimatedSessions: event.target.value === '' ? null : Number(event.target.value),
                },
              });
            }}
            className={INPUT_CLASS}
          >
            <option value="">No estimate</option>
            {Array.from({ length: TASK_ESTIMATE_MAX }, (_, index) => index + 1).map((count) => (
              <option key={count} value={String(count)}>
                {count === 1 ? '1 session' : `${String(count)} sessions`}
              </option>
            ))}
          </select>
        </div>
      </div>

      {task.status === 'open' && <HelpMeStart task={task} steps={list} />}

      <div className="space-y-2">
        <p className="text-xs text-muted">Steps</p>
        {list.length > 0 && (
          <ul aria-label={`Steps of ${task.title}`} className="space-y-1">
            {list.map((step) => (
              <li key={step.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={step.done}
                  disabled={stepWrite.isPending}
                  aria-label={step.title}
                  onChange={(event) => {
                    stepWrite.mutate({
                      kind: 'toggle',
                      taskId: task.id,
                      stepId: step.id,
                      done: event.target.checked,
                    });
                  }}
                />
                <span className={`flex-1 ${step.done ? 'text-muted line-through' : ''}`}>
                  {step.title}
                </span>
                <button
                  type="button"
                  disabled={stepWrite.isPending}
                  aria-label={`Remove step “${step.title}”`}
                  onClick={() => {
                    stepWrite.mutate({ kind: 'remove', taskId: task.id, stepId: step.id });
                  }}
                  className="px-1 text-muted hover:text-ink"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        {list.length < TASK_STEPS_MAX && (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const title = newStep.trim();
              if (title !== '') {
                stepWrite.mutate(
                  { kind: 'add', taskId: task.id, title },
                  {
                    onSuccess: () => {
                      setNewStep('');
                    },
                  },
                );
              }
            }}
          >
            <label htmlFor={stepId} className="sr-only">
              A new step
            </label>
            <input
              id={stepId}
              type="text"
              value={newStep}
              maxLength={TASK_TITLE_MAX_LENGTH}
              placeholder={list.length === 0 ? 'Break it into a first step…' : 'Another step…'}
              onChange={(event) => {
                setNewStep(event.target.value);
              }}
              className={INPUT_CLASS}
            />
            <button
              type="submit"
              disabled={stepWrite.isPending || newStep.trim() === ''}
              className={buttonClass('ghost', 'shrink-0 whitespace-nowrap px-4 py-2 text-xs')}
            >
              Add step
            </button>
          </form>
        )}
      </div>
      {(update.isError || stepWrite.isError) && (
        <p role="alert" className="text-sm text-danger">
          That did not save. Try again.
        </p>
      )}
    </div>
  );
}
