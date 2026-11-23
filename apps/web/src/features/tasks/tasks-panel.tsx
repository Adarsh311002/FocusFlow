import type { TaskStatus } from '@focus-flow/contracts';
import { useState } from 'react';

import { NewTaskForm } from './new-task-form';
import { TaskList } from './task-list';

const TABS: readonly { status: TaskStatus; label: string }[] = [
  { status: 'open', label: 'Open' },
  { status: 'completed', label: 'Completed' },
];

/** Task management on the dashboard: add, then work through open or completed tasks. */
export function TasksPanel() {
  const [status, setStatus] = useState<TaskStatus>('open');

  return (
    <section aria-labelledby="tasks-heading" className="space-y-4">
      <h3 id="tasks-heading" className="font-display text-4xl">
        Tasks
      </h3>
      <NewTaskForm />
      <div role="group" aria-label="Show tasks" className="flex gap-2">
        {TABS.map((tab) => (
          <button
            key={tab.status}
            type="button"
            aria-pressed={status === tab.status}
            onClick={() => {
              setStatus(tab.status);
            }}
            className={
              status === tab.status
                ? 'rounded-full bg-focus px-4 py-2 text-sm font-medium text-focus-ink shadow-glow transition hover:brightness-110'
                : 'rounded-full border border-line bg-surface px-4 py-1.5 transition hover:bg-surface-strong text-sm'
            }
          >
            {tab.label}
          </button>
        ))}
      </div>
      <TaskList status={status} />
    </section>
  );
}
