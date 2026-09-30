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
      <h3 id="tasks-heading" className="text-base font-semibold">
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
                ? 'rounded bg-slate-900 px-3 py-1 text-sm text-white'
                : 'rounded border border-slate-300 px-3 py-1 text-sm'
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
