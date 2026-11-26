import type { TaskView } from '@focus-flow/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { errorResponse, jsonResponse, parsedBody, stubFetch } from '../../test/api-stub';
import { createFakeTaskApi } from '../../test/fake-task-api';
import { createTestQueryClient } from '../../test/query-client';
import { resetPendingRefresh } from '../auth/auth-client';
import { AuthProvider } from '../auth/auth-context';
import { clearAccessToken } from '../auth/token-store';
import { HelpMeStart } from './help-me-start';
import { WeeklyReflection } from './weekly-reflection';

// AI features on the web (AI7, AI8): ask, watch the job finish, use the answer.

afterEach(() => {
  vi.unstubAllGlobals();
  clearAccessToken();
  resetPendingRefresh();
});

const TASK_ID = '01900000-0000-7000-8000-0000000000d1';
const JOB_ID = '01900000-0000-7000-8000-0000000000e1';

const task = {
  id: TASK_ID,
  title: 'Write the report',
  status: 'open',
  createdAt: '2026-11-20T08:00:00.000Z',
  completedAt: null,
} as unknown as TaskView;

const job = (status: string, extra: Record<string, unknown> = {}) => ({
  id: JOB_ID,
  kind: 'first_step',
  taskId: TASK_ID,
  status,
  createdAt: '2026-11-26T08:00:00.000Z',
  finishedAt: status === 'succeeded' ? '2026-11-26T08:00:03.000Z' : null,
  failure: null,
  source: status === 'succeeded' ? 'mock' : null,
  result:
    status === 'succeeded'
      ? {
          firstStep: 'Open the doc and write one line',
          steps: ['Open the doc and write one line', 'Collect numbers', 'Draft the summary'],
          encouragement: 'Five minutes is enough.',
        }
      : null,
  ...extra,
});

function renderWith(element: React.ReactNode) {
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <AuthProvider>{element}</AuthProvider>
    </QueryClientProvider>,
  );
}

describe('help me start', () => {
  it('asks, waits for the job, and adds the suggested steps that are new', async () => {
    const api = createFakeTaskApi();
    let reads = 0;
    const calls = stubFetch((request) => {
      const path = new URL(request.url, 'http://x').pathname.replace('/api/v1', '');
      if (path === '/ai/first-step') {
        return jsonResponse(202, { job: job('queued') });
      }
      if (path === `/ai/jobs/${JOB_ID}`) {
        reads += 1;
        return jsonResponse(200, { job: job(reads === 1 ? 'running' : 'succeeded') });
      }
      if (path === `/tasks/${TASK_ID}/steps` && request.method === 'POST') {
        return jsonResponse(201, {
          step: {
            id: crypto.randomUUID(),
            title: parsedBody(request).title,
            done: false,
            createdAt: '2026-11-26T08:00:05.000Z',
          },
        });
      }
      return api.handle(request);
    });
    renderWith(
      <HelpMeStart
        task={task}
        steps={[{ id: crypto.randomUUID(), title: 'Collect numbers', done: false } as never]}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: '✨ Help me start' }));
    expect(await screen.findByText('Finding a first step…')).not.toBeNull();
    expect(
      await screen.findByText(
        'Open the doc and write one line',
        { selector: 'p' },
        { timeout: 5_000 },
      ),
    ).not.toBeNull();
    expect(screen.getByText(/A sample answer/)).not.toBeNull();

    // "Collect numbers" is already a step: only the two new ones are offered.
    fireEvent.click(screen.getByRole('button', { name: 'Add these 2 steps' }));
    expect(await screen.findByText('Added to the steps.')).not.toBeNull();
    const added = calls
      .filter((call) => call.method === 'POST' && call.url.endsWith('/steps'))
      .map((call) => parsedBody(call).title);
    expect(added).toEqual(['Open the doc and write one line', 'Draft the summary']);
    expect(parsedBody(calls.find((call) => call.url.endsWith('/ai/first-step'))!)).toEqual({
      taskId: TASK_ID,
    });
  }, 15_000);

  it('explains a refusal to ask', async () => {
    const api = createFakeTaskApi();
    stubFetch((request) =>
      request.url.endsWith('/ai/first-step')
        ? errorResponse(429, 'RATE_LIMITED')
        : api.handle(request),
    );
    renderWith(<HelpMeStart task={task} steps={[]} />);
    fireEvent.click(await screen.findByRole('button', { name: '✨ Help me start' }));
    expect(await screen.findByText(/plenty of AI help/)).not.toBeNull();
  });
});

describe('weekly reflection', () => {
  it('reflects on last week when asked and shows the answer', async () => {
    const api = createFakeTaskApi();
    let stored: unknown = null;
    const calls = stubFetch((request) => {
      const url = new URL(request.url, 'http://x');
      const path = url.pathname.replace('/api/v1', '');
      if (path === '/ai/weekly-reflection' && request.method === 'GET') {
        const week = url.searchParams.get('week');
        const match = (stored as { weekStart?: string } | null)?.weekStart === week;
        return jsonResponse(200, { job: match ? stored : null });
      }
      if (path === '/ai/weekly-reflection' && request.method === 'POST') {
        const { week } = parsedBody(request) as { week: string };
        stored = {
          id: JOB_ID,
          kind: 'weekly_reflection',
          weekStart: week,
          status: 'succeeded',
          createdAt: '2026-11-26T08:00:00.000Z',
          finishedAt: '2026-11-26T08:00:03.000Z',
          failure: null,
          source: 'model',
          result: {
            headline: 'A steady week of 6 hours.',
            wins: ['You finished the launch page.'],
            patterns: ['Mornings were your deepest.'],
            suggestion: 'Protect 9:00 to 10:30 on two days.',
          },
        };
        return jsonResponse(202, { job: stored });
      }
      return api.handle(request);
    });
    renderWith(<WeeklyReflection />);

    fireEvent.click(await screen.findByRole('button', { name: '✨ Reflect on last week' }));
    expect(await screen.findByText('A steady week of 6 hours.')).not.toBeNull();
    expect(screen.getByRole('list', { name: 'Went well' }).textContent).toContain('launch page');
    expect(screen.getByText(/Protect 9:00/)).not.toBeNull();
    const post = calls.find(
      (call) => call.method === 'POST' && call.url.endsWith('/ai/weekly-reflection'),
    );
    const body = parsedBody(post!) as { week: string; tz: string };
    expect(new Date(`${body.week}T00:00:00Z`).getUTCDay()).toBe(1);
    expect(typeof body.tz).toBe('string');

    fireEvent.click(screen.getByRole('button', { name: 'This week' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '✨ Reflect on this week' })).not.toBeNull();
    });
  });
});
