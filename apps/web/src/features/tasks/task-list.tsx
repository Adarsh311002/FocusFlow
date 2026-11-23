import type { TaskStatus } from '@focus-flow/contracts';

import { useAuth } from '../auth/auth-context';
import { TaskItem } from './task-item';
import { taskErrorMessage } from './task-messages';
import { useTaskList } from './task-queries';

const EMPTY: Record<TaskStatus, string> = {
  open: 'No open tasks. Add one above.',
  completed: 'No completed tasks yet.',
};

/** One status's tasks, newest first, with "Load more" following the API's cursor. */
export function TaskList({ status }: { status: TaskStatus }) {
  const { user } = useAuth();
  const list = useTaskList(status);

  if (list.isPending) {
    return <p className="text-muted">Loading tasks…</p>;
  }
  if (list.isError) {
    return (
      <p role="alert" className="text-sm text-danger">
        {taskErrorMessage(list.error)}
      </p>
    );
  }

  const tasks = list.data.pages.flatMap((page) => page.tasks);
  if (tasks.length === 0) {
    return <p className="text-muted">{EMPTY[status]}</p>;
  }

  return (
    <div className="space-y-3">
      <ul aria-label={status === 'open' ? 'Open tasks' : 'Completed tasks'} className="space-y-2">
        {tasks.map((task) => (
          <TaskItem key={task.id} task={task} isCurrent={task.id === user?.currentTaskId} />
        ))}
      </ul>
      {list.hasNextPage && (
        <button
          type="button"
          disabled={list.isFetchingNextPage}
          onClick={() => {
            void list.fetchNextPage();
          }}
          className="rounded-full border border-line bg-surface px-4 py-1.5 transition hover:bg-surface-strong text-sm disabled:opacity-50"
        >
          {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}
