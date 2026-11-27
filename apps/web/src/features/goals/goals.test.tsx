import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parsedBody, type RecordedRequest, stubFetch } from '../../test/api-stub';
import { renderDashboard } from '../../test/dashboard-route';
import { createFakeTaskApi } from '../../test/fake-task-api';
import { createTestQueryClient } from '../../test/query-client';
import { resetPendingRefresh } from '../auth/auth-client';
import { AuthProvider } from '../auth/auth-context';
import { clearAccessToken } from '../auth/token-store';
import { GoalsPage } from './goals-page';

// Goals (GL5), a task's plan: goal, estimate and steps (SP4, ES3).

afterEach(() => {
  vi.unstubAllGlobals();
  clearAccessToken();
  resetPendingRefresh();
});

const writes = (calls: RecordedRequest[], path: string) =>
  calls
    .filter(
      (call) => call.method !== 'GET' && new URL(call.url, 'http://x').pathname.endsWith(path),
    )
    .map((call) => [call.method, parsedBody(call)]);

function renderGoals() {
  const api = createFakeTaskApi();
  const calls = stubFetch((request) => api.handle(request));
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <AuthProvider>
        <GoalsPage />
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { api, calls };
}

describe('the goals page', () => {
  it('plants a goal with why, date and color, then adds a task to it', async () => {
    const { calls } = renderGoals();
    fireEvent.change(await screen.findByLabelText('What do you want to reach?'), {
      target: { value: 'Ship the beta' },
    });
    fireEvent.change(screen.getByLabelText('Why it matters (optional)'), {
      target: { value: 'Users are waiting' },
    });
    fireEvent.change(screen.getByLabelText('By (optional)'), { target: { value: '2027-01-15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Berry' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add goal' }));

    const card = await screen.findByRole('listitem', { name: 'Ship the beta' });
    expect(within(card).getByText('Users are waiting')).not.toBeNull();
    expect(writes(calls, '/goals')).toEqual([
      [
        'POST',
        {
          title: 'Ship the beta',
          why: 'Users are waiting',
          targetDate: '2027-01-15',
          color: 'berry',
        },
      ],
    ]);

    fireEvent.click(within(card).getByRole('button', { name: 'Tasks' }));
    fireEvent.change(within(card).getByLabelText('A new task for Ship the beta'), {
      target: { value: 'Record the demo' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Add' }));
    expect(
      await within(card).findByRole('list', { name: 'Open tasks of Ship the beta' }),
    ).not.toBeNull();
    await waitFor(() => {
      expect(within(card).getByText(/^0 of 1 tasks done/)).not.toBeNull();
    });
  });

  it('marks a goal reached and makes it active again', async () => {
    const { api, calls } = renderGoals();
    fireEvent.change(await screen.findByLabelText('What do you want to reach?'), {
      target: { value: 'Run 10k' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add goal' }));
    const card = await screen.findByRole('listitem', { name: 'Run 10k' });
    fireEvent.click(within(card).getByRole('button', { name: 'Mark reached' }));
    await within(card).findByText('✓ Reached');
    fireEvent.click(within(card).getByRole('button', { name: 'Make active again' }));
    await within(card).findByRole('button', { name: 'Mark reached' });
    const goalId = api.goals[0]?.id ?? '';
    expect(writes(calls, `/goals/${goalId}`)).toEqual([
      ['PATCH', { status: 'completed' }],
      ['PATCH', { status: 'active' }],
    ]);
  });
});

describe('a task’s plan', () => {
  it('sets the goal and estimate and keeps a checklist of steps', async () => {
    const api = createFakeTaskApi();
    const calls = stubFetch((request) => api.handle(request));
    const task = api.addTask('Write the launch post');
    api.goals.push({
      id: crypto.randomUUID(),
      title: 'Ship the beta',
      why: null,
      targetDate: null,
      color: 'leaf',
      status: 'active',
      createdAt: new Date().toISOString(),
    });
    renderDashboard();

    const item = await screen.findByRole('listitem', { name: 'Write the launch post' });
    fireEvent.click(within(item).getByRole('button', { name: 'Plan' }));
    const goalSelect = await within(item).findByLabelText<HTMLSelectElement>('Goal');
    await waitFor(() => {
      expect(within(goalSelect).getAllByRole('option')).toHaveLength(2);
    });
    fireEvent.change(goalSelect, { target: { value: api.goals[0]?.id } });
    fireEvent.change(within(item).getByLabelText('Sessions it should take'), {
      target: { value: '3' },
    });
    fireEvent.change(within(item).getByLabelText('A new step'), {
      target: { value: 'Outline the sections' },
    });
    fireEvent.click(within(item).getByRole('button', { name: 'Add step' }));
    fireEvent.click(await within(item).findByRole('checkbox', { name: 'Outline the sections' }));

    await waitFor(() => {
      expect(within(item).getByText('1/1 steps')).not.toBeNull();
    });
    expect(within(item).getByText('0/3 sessions')).not.toBeNull();
    // The goal's chip in the summary line (the select also lists it as an option).
    expect(within(item).getByText('Ship the beta', { selector: 'span' })).not.toBeNull();
    expect(writes(calls, `/tasks/${task.id}`)).toEqual([
      ['PATCH', { goalId: api.goals[0]?.id }],
      ['PATCH', { estimatedSessions: 3 }],
    ]);
  });
});
