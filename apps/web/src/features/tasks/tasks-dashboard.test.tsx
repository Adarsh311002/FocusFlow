import { mePaths, taskPaths } from '@focus-flow/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type RecordedRequest, requestsTo, stubFetch } from '../../test/api-stub';
import { renderDashboard } from '../../test/dashboard-route';
import { createFakeTaskApi } from '../../test/fake-task-api';
import { resetPendingRefresh } from '../auth/auth-client';
import { clearAccessToken } from '../auth/token-store';

afterEach(() => {
  vi.unstubAllGlobals();
  clearAccessToken();
  resetPendingRefresh();
});

function startDashboard(options?: { pageSize?: number }) {
  const api = createFakeTaskApi(options);
  const calls = stubFetch((request) => api.handle(request));
  return { api, calls };
}

/** Awaited: the guarded route renders only after the session probe resolves. */
async function currentTaskSection(): Promise<HTMLElement> {
  return screen.findByRole('region', { name: 'Current task' });
}

async function findTask(title: string): Promise<HTMLElement> {
  return screen.findByRole('listitem', { name: title });
}

function clickIn(container: HTMLElement, name: string): void {
  fireEvent.click(within(container).getByRole('button', { name }));
}

async function addTask(title: string): Promise<void> {
  fireEvent.change(screen.getByLabelText('New task'), { target: { value: title } });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  await findTask(title.trim());
}

/** Task writes only; the session probe's POST /auth/refresh is not one. */
const taskWrites = (calls: readonly RecordedRequest[]) =>
  calls.filter((call) => call.method !== 'GET' && call.url.includes(taskPaths.collection));

describe('dashboard tasks', () => {
  it('shows the empty state and no current task', async () => {
    startDashboard();

    renderDashboard();

    expect(await screen.findByText('No open tasks. Add one above.')).not.toBeNull();
    expect(within(await currentTaskSection()).getByText(/No current task/)).not.toBeNull();
  });

  it('adds a task with a trimmed title and clears the input', async () => {
    const { api } = startDashboard();
    renderDashboard();
    await screen.findByText('No open tasks. Add one above.');

    await addTask('  Write the report  ');

    expect(api.tasks.map((task) => task.title)).toEqual(['Write the report']);
    expect(screen.getByLabelText<HTMLInputElement>('New task').value).toBe('');
  });

  it('rejects a whitespace-only title without calling the API', async () => {
    const { calls } = startDashboard();
    renderDashboard();
    await screen.findByText('No open tasks. Add one above.');

    fireEvent.change(screen.getByLabelText('New task'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(await screen.findByText('Enter a title of 1 to 200 characters.')).not.toBeNull();
    expect(taskWrites(calls)).toEqual([]);
  });

  it('lists open tasks newest first', async () => {
    const { api } = startDashboard();
    api.addTask('older');
    api.addTask('newer');
    renderDashboard();

    await findTask('older');
    const titles = within(screen.getByRole('list', { name: 'Open tasks' }))
      .getAllByRole('listitem')
      .map((item) => item.getAttribute('aria-label'));
    expect(titles).toEqual(['newer', 'older']);
  });

  it('sets a task as current and shows it prominently', async () => {
    const { api, calls } = startDashboard();
    const task = api.addTask('Deep work');
    renderDashboard();

    clickIn(await findTask('Deep work'), 'Set as current');

    expect(await within(await currentTaskSection()).findByText('Deep work')).not.toBeNull();
    expect(api.currentTaskId()).toBe(task.id);
    expect(within(await findTask('Deep work')).getByText('Current')).not.toBeNull();
    expect(requestsTo(calls, mePaths.currentTask)).toHaveLength(1);
  });

  it('completing the current task clears it after re-reading /me (D43)', async () => {
    const { api, calls } = startDashboard();
    const task = api.addTask('Finish me');
    api.setCurrentTaskId(task.id);
    renderDashboard();
    await within(await currentTaskSection()).findByText('Finish me');
    const meReadsBefore = requestsTo(calls, mePaths.self).length;

    clickIn(await findTask('Finish me'), 'Complete');

    expect(await within(await currentTaskSection()).findByText(/No current task/)).not.toBeNull();
    expect(requestsTo(calls, mePaths.self).length).toBe(meReadsBefore + 1);
    expect(await screen.findByText('No open tasks. Add one above.')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Completed' }));
    expect(await findTask('Finish me')).not.toBeNull();
  });

  it('marks the current task complete from the current-task card', async () => {
    const { api } = startDashboard();
    const task = api.addTask('From the card');
    api.setCurrentTaskId(task.id);
    renderDashboard();

    fireEvent.click(
      await within(await currentTaskSection()).findByRole('button', { name: 'Mark complete' }),
    );

    expect(await within(await currentTaskSection()).findByText(/No current task/)).not.toBeNull();
    expect(api.tasks[0]?.completedAt).not.toBeNull();
  });

  it('clears the current task without completing it', async () => {
    const { api } = startDashboard();
    const task = api.addTask('Keep open');
    api.setCurrentTaskId(task.id);
    renderDashboard();

    fireEvent.click(
      await within(await currentTaskSection()).findByRole('button', { name: 'Clear current task' }),
    );

    expect(await within(await currentTaskSection()).findByText(/No current task/)).not.toBeNull();
    expect(api.tasks[0]?.completedAt).toBeNull();
  });

  it('completing a different task leaves the current task alone', async () => {
    const { api, calls } = startDashboard();
    const current = api.addTask('Current one');
    api.addTask('Other one');
    api.setCurrentTaskId(current.id);
    renderDashboard();
    await within(await currentTaskSection()).findByText('Current one');
    const meReadsBefore = requestsTo(calls, mePaths.self).length;

    clickIn(await findTask('Other one'), 'Complete');

    await waitFor(() => {
      expect(screen.queryByRole('listitem', { name: 'Other one' })).toBeNull();
    });
    expect(within(await currentTaskSection()).getByText('Current one')).not.toBeNull();
    expect(requestsTo(calls, mePaths.self).length).toBe(meReadsBefore);
  });

  it('reopens a completed task without making it current', async () => {
    const { api } = startDashboard();
    api.addTask('Done before', true);
    renderDashboard();
    await screen.findByText('No open tasks. Add one above.');

    fireEvent.click(screen.getByRole('button', { name: 'Completed' }));
    clickIn(await findTask('Done before'), 'Reopen');
    await screen.findByText('No completed tasks yet.');

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const item = await findTask('Done before');
    expect(within(item).queryByText('Current')).toBeNull();
    expect(api.currentTaskId()).toBeNull();
  });

  it('renames a task, including a completed one', async () => {
    const { api } = startDashboard();
    api.addTask('Old title', true);
    renderDashboard();
    await screen.findByText('No open tasks. Add one above.');
    fireEvent.click(screen.getByRole('button', { name: 'Completed' }));

    const item = await findTask('Old title');
    clickIn(item, 'Rename');
    fireEvent.change(within(item).getByLabelText('Task title'), {
      target: { value: ' New title ' },
    });
    clickIn(item, 'Save');

    expect(await findTask('New title')).not.toBeNull();
    expect(api.tasks[0]?.title).toBe('New title');
  });

  it('deletes only after confirmation, and deleting the current task clears it (D38)', async () => {
    const { api, calls } = startDashboard();
    const task = api.addTask('Throw away');
    api.setCurrentTaskId(task.id);
    renderDashboard();
    await within(await currentTaskSection()).findByText('Throw away');

    const item = await findTask('Throw away');
    clickIn(item, 'Delete');
    clickIn(item, 'Keep');
    expect(requestsTo(calls, `/tasks/${task.id}`).filter((c) => c.method === 'DELETE')).toEqual([]);

    clickIn(item, 'Delete');
    clickIn(item, 'Confirm delete');

    expect(await screen.findByText('No open tasks. Add one above.')).not.toBeNull();
    expect(await within(await currentTaskSection()).findByText(/No current task/)).not.toBeNull();
    expect(api.tasks[0]?.deletedAt).not.toBeNull();
  });

  it('shows TASK_NOT_OPEN when the task was completed elsewhere', async () => {
    const { api } = startDashboard();
    const task = api.addTask('Stale');
    renderDashboard();
    const item = await findTask('Stale');
    task.completedAt = new Date().toISOString(); // completed in another tab

    clickIn(item, 'Set as current');

    expect(
      await within(item).findByText('Only an open task can be your current task.'),
    ).not.toBeNull();
    expect(api.currentTaskId()).toBeNull();
  });

  it('pages through tasks with Load more', async () => {
    const { api, calls } = startDashboard({ pageSize: 2 });
    for (const title of ['t1', 't2', 't3']) {
      api.addTask(title);
    }
    renderDashboard();
    await findTask('t3');
    expect(screen.queryByRole('listitem', { name: 't1' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await findTask('t1')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(requestsTo(calls, '').filter((c) => c.url.includes('cursor='))).toHaveLength(1);
  });

  it('shows the current task even when it is not on the loaded page', async () => {
    const { api, calls } = startDashboard({ pageSize: 1 });
    const oldest = api.addTask('Oldest, but current');
    api.addTask('Newest');
    api.setCurrentTaskId(oldest.id);
    renderDashboard();

    expect(
      await within(await currentTaskSection()).findByText('Oldest, but current'),
    ).not.toBeNull();
    expect(screen.queryByRole('listitem', { name: 'Oldest, but current' })).toBeNull();
    expect(requestsTo(calls, `${taskPaths.collection}/${oldest.id}`)).toHaveLength(1);
  });
});
