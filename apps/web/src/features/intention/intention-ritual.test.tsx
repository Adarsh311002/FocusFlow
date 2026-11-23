import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parsedBody, type RecordedRequest, stubFetch, userBody } from '../../test/api-stub';
import { createFakeTaskApi } from '../../test/fake-task-api';
import { createTestQueryClient } from '../../test/query-client';
import { resetPendingRefresh } from '../auth/auth-client';
import { AuthProvider } from '../auth/auth-context';
import { clearAccessToken } from '../auth/token-store';
import { DailyIntentionRitual, IntentionPromptProvider } from './intention-ritual';

const QUESTION = /What would make today/;

/** Every value in localStorage (the ritual stores one per user and day). */
function storedOutcomes(): (string | null)[] {
  return Array.from({ length: window.localStorage.length }, (_, index) =>
    window.localStorage.getItem(window.localStorage.key(index) ?? ''),
  );
}

function pathOf(request: RecordedRequest): string {
  return new URL(request.url, 'http://localhost').pathname.replace('/api/v1', '');
}

function renderRitual(options: { prompt?: boolean } = {}) {
  const api = createFakeTaskApi();
  const calls = stubFetch((request) => api.handle(request));
  const ritual = <DailyIntentionRitual />;
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <AuthProvider>
        {options.prompt === false ? (
          ritual
        ) : (
          <IntentionPromptProvider>{ritual}</IntentionPromptProvider>
        )}
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { api, calls };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearAccessToken();
  resetPendingRefresh();
  window.localStorage.clear();
});

describe('the daily intention ritual', () => {
  it('asks a signed-in user once a day, in a dialog that takes the focus', async () => {
    renderRitual();

    const dialog = await screen.findByRole('dialog', { name: QUESTION });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Today’s one thing'));
    });
  });

  it('turns the answer into the current task and saves the daily goal', async () => {
    const { calls } = renderRitual();
    await screen.findByRole('dialog', { name: QUESTION });

    fireEvent.change(screen.getByLabelText('Today’s one thing'), {
      target: { value: '  Write the deployment runbook  ' },
    });
    fireEvent.click(screen.getByLabelText('3 hours'));
    fireEvent.click(screen.getByRole('button', { name: 'Begin my day' }));

    await waitFor(
      () => {
        expect(calls.some((call) => call.method === 'PATCH')).toBe(true);
      },
      { timeout: 5000 },
    );
    expect(screen.queryByRole('alert')).toBeNull();
    const writes = calls.filter((call) => call.method !== 'GET');
    const created = writes.find((call) => call.method === 'POST' && pathOf(call) === '/tasks');
    expect(created === undefined ? null : parsedBody(created)).toEqual({
      title: 'Write the deployment runbook',
    });
    expect(
      writes.some((call) => call.method === 'PUT' && pathOf(call) === '/me/current-task'),
    ).toBe(true);
    const goal = writes.find((call) => call.method === 'PATCH' && pathOf(call) === '/me');
    expect(goal === undefined ? null : parsedBody(goal)).toEqual({ dailyGoalSeconds: 10_800 });

    await waitFor(
      () => {
        expect(screen.queryByRole('dialog')).toBeNull();
      },
      { timeout: 5000 },
    );
    expect(storedOutcomes()).toContain('set');
  });

  it('leaves the goal alone when it is not changed', async () => {
    const { calls } = renderRitual();
    await screen.findByRole('dialog', { name: QUESTION });

    fireEvent.change(screen.getByLabelText('Today’s one thing'), { target: { value: 'Read' } });
    fireEvent.click(screen.getByRole('button', { name: 'Begin my day' }));

    await waitFor(
      () => {
        expect(storedOutcomes()).toContain('set');
      },
      { timeout: 5000 },
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it('is skipped with "Not today" and stays skipped for the day', async () => {
    const { calls } = renderRitual();
    await screen.findByRole('dialog', { name: QUESTION });

    fireEvent.click(screen.getByRole('button', { name: 'Not today' }));

    await waitFor(
      () => {
        expect(screen.queryByRole('dialog')).toBeNull();
      },
      { timeout: 3000 },
    );
    expect(
      calls.filter((call) => call.method !== 'GET' && pathOf(call) !== '/auth/refresh'),
    ).toEqual([]);
    expect(storedOutcomes()).toContain('skipped');
  });

  it('is skipped with Escape', async () => {
    renderRitual();
    const dialog = await screen.findByRole('dialog', { name: QUESTION });

    fireEvent.keyDown(dialog, { key: 'Escape' });

    await waitFor(
      () => {
        expect(screen.queryByRole('dialog')).toBeNull();
      },
      { timeout: 3000 },
    );
  });

  it('does not ask again once today is answered', async () => {
    window.localStorage.setItem(
      `ff-intention:${userBody.id}:${new Date().toLocaleDateString('en-CA')}`,
      'set',
    );
    renderRitual();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('never appears outside an IntentionPromptProvider', async () => {
    renderRitual({ prompt: false });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
