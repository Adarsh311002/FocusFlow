import { TASK_STEPS_MAX, type TaskStepView, type TaskView } from '@focus-flow/contracts';
import { useState } from 'react';

import { buttonClass } from '../../ui/primitives';
import { useAddSteps } from '../tasks/task-queries';
import { FAILURE_TEXT, isActive, requestErrorText, useAiJob, useRequestFirstStep } from './ai-data';

// "Help me start" (AI7): for a task that is hard to begin, a first step small enough to do
// now, and a short plan the user may add to the task's steps. Nothing is added on its own.

export function HelpMeStart({
  task,
  steps,
}: {
  readonly task: TaskView;
  readonly steps: readonly TaskStepView[];
}) {
  const request = useRequestFirstStep();
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useAiJob(jobId);
  const addSteps = useAddSteps();
  const [added, setAdded] = useState(false);

  const data = job.data;
  const busy = request.isPending || isActive(data);
  const result = data?.kind === 'first_step' && data.status === 'succeeded' ? data.result : null;

  const ask = () => {
    setAdded(false);
    request.mutate(task.id, {
      onSuccess: (created) => {
        setJobId(created.id);
      },
    });
  };

  const existing = new Set(steps.map((step) => step.title.trim().toLowerCase()));
  const fresh = (result?.steps ?? []).filter((title) => !existing.has(title.trim().toLowerCase()));
  const room = Math.max(0, TASK_STEPS_MAX - steps.length);

  if (jobId === null && !request.isPending) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={ask} className={buttonClass('ghost', 'px-4 py-1.5 text-xs')}>
          ✨ Help me start
        </button>
        <span className="text-xs text-muted">
          Sends this task, its steps and your recent check-ins to the AI helper.
        </span>
        {request.isError && (
          <p role="alert" className="w-full text-xs text-warm">
            {requestErrorText(request.error)}
          </p>
        )}
      </div>
    );
  }

  return (
    <section
      aria-label="Help me start"
      aria-busy={busy}
      className="space-y-3 rounded-xl border border-focus/30 bg-focus/5 p-3"
    >
      {busy && (
        <p role="status" className="text-sm text-muted">
          <span aria-hidden="true" className="mr-2 inline-block animate-pulse">
            ✨
          </span>
          Finding a first step…
        </p>
      )}
      {request.isError && (
        <p role="alert" className="text-sm text-warm">
          {requestErrorText(request.error)}
        </p>
      )}
      {data?.status === 'failed' && (
        <p role="alert" className="text-sm text-warm">
          {FAILURE_TEXT[data.failure ?? 'unavailable']}
        </p>
      )}
      {result !== null && (
        <>
          <div>
            <p className="text-[10px] tracking-[0.3em] text-focus uppercase">Start here</p>
            <p className="font-display mt-1 text-xl">{result.firstStep}</p>
            <p className="mt-1 text-sm text-muted">{result.encouragement}</p>
          </div>
          <ol aria-label="Suggested steps" className="list-decimal space-y-1 pl-5 text-sm">
            {result.steps.map((title) => (
              <li key={title}>{title}</li>
            ))}
          </ol>
          {data?.source === 'mock' && (
            <p className="text-xs text-muted">
              A sample answer: no AI model is set up on this server yet.
            </p>
          )}
        </>
      )}
      <div className="flex flex-wrap gap-2">
        {result !== null && fresh.length > 0 && room > 0 && !added && (
          <button
            type="button"
            disabled={addSteps.isPending}
            onClick={() => {
              addSteps.mutate(
                { taskId: task.id, titles: fresh.slice(0, room) },
                {
                  onSuccess: () => {
                    setAdded(true);
                  },
                },
              );
            }}
            className={buttonClass('primary', 'px-4 py-1.5 text-xs')}
          >
            {fresh.length === 1
              ? 'Add as a step'
              : `Add these ${String(Math.min(fresh.length, room))} steps`}
          </button>
        )}
        {added && <span className="text-xs text-focus">Added to the steps.</span>}
        {!busy && (
          <button
            type="button"
            onClick={ask}
            className="px-2 text-xs text-muted underline-offset-4 hover:text-ink hover:underline"
          >
            Try another
          </button>
        )}
        {!busy && (
          <button
            type="button"
            onClick={() => {
              setJobId(null);
              request.reset();
            }}
            className="px-2 text-xs text-muted underline-offset-4 hover:text-ink hover:underline"
          >
            Close
          </button>
        )}
      </div>
      {addSteps.isError && (
        <p role="alert" className="text-xs text-danger">
          Some steps did not save. Try again.
        </p>
      )}
    </section>
  );
}
