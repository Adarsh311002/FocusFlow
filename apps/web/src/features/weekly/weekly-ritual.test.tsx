import { focusSessionSummaryQuerySchema } from '@focus-flow/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  jsonResponse,
  parsedBody,
  type RecordedRequest,
  stubFetch,
  userBody,
} from '../../test/api-stub';
import { emptyInsights } from '../../test/fake-focus-session-api';
import { createFakeTaskApi } from '../../test/fake-task-api';
import { createTestQueryClient } from '../../test/query-client';
import { resetPendingRefresh } from '../auth/auth-client';
import { AuthProvider } from '../auth/auth-context';
import { clearAccessToken } from '../auth/token-store';
import { DailyIntentionRitual, IntentionPromptProvider } from '../intention/intention-ritual';
import { currentWeek, mondayOf } from './weekly-queries';
import { WeeklyReviewRitual } from './weekly-ritual';

// The weekly review (WR4): before the daily intention, once a week, skipped for new users.

const WEEKLY = /Look back, then/;
const DAILY = /What would make today/;

function pathOf(request: RecordedRequest): string {
  return new URL(request.url, 'http://localhost').pathname.replace('/api/v1', '');
}

function renderRituals(options: { history: boolean }) {
  const api = createFakeTaskApi();
  api.addTask('Ship the beta');
  api.addTask('Write the guide');
  let saved: unknown = null;
  const calls = stubFetch((request) => {
    const url = new URL(request.url, 'http://localhost');
    const path = pathOf(request);
    if (path === '/focus-sessions/insights') {
      const query = focusSessionSummaryQuerySchema.parse(Object.fromEntries(url.searchParams));
      const answer = emptyInsights(query);
      if (options.history) {
        answer.totals.sessionCount = 4;
      }
      return jsonResponse(200, answer);
    }
    if (path === '/weekly-priorities' && request.method === 'GET') {
      return jsonResponse(200, { week: url.searchParams.get('week'), priorities: [] });
    }
    if (path === '/weekly-priorities' && request.method === 'PUT') {
      saved = parsedBody(request);
      return jsonResponse(200, { week: (saved as { week: string }).week, priorities: [] });
    }
    return api.handle(request);
  });
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <AuthProvider>
        <IntentionPromptProvider>
          <WeeklyReviewRitual />
          <DailyIntentionRitual />
        </IntentionPromptProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { calls, saved: () => saved };
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

describe('mondayOf', () => {
  it('finds the Monday of the week, Sunday belonging to the week before', () => {
    expect(mondayOf('2026-11-23')).toBe('2026-11-23');
    expect(mondayOf('2026-11-25')).toBe('2026-11-23');
    expect(mondayOf('2026-11-29')).toBe('2026-11-23');
    expect(mondayOf('2026-11-30')).toBe('2026-11-30');
    expect(mondayOf('2027-01-01')).toBe('2026-12-28');
  });
});

describe('the weekly review', () => {
  it('comes first, saves this week’s three in order, and then the daily intention follows', async () => {
    const { saved } = renderRituals({ history: true });

    expect(await screen.findByRole('dialog', { name: WEEKLY })).not.toBeNull();
    expect(screen.queryByRole('dialog', { name: DAILY })).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: 'Write the guide' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ship the beta' }));
    expect(screen.getByRole('heading', { name: /This week’s three \(2\/3\)/ })).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Begin the week' }));

    await waitFor(() => {
      expect(saved()).not.toBeNull();
    });
    const body = saved() as { week: string; taskIds: string[] };
    expect(body.week).toBe(currentWeek().week);
    expect(body.taskIds).toHaveLength(2);

    expect(await screen.findByRole('dialog', { name: DAILY }, { timeout: 6000 })).not.toBeNull();
  });

  it('is skipped for a brand-new user, who goes straight to the daily intention', async () => {
    renderRituals({ history: false });
    expect(await screen.findByRole('dialog', { name: DAILY }, { timeout: 6000 })).not.toBeNull();
    expect(screen.queryByRole('dialog', { name: WEEKLY })).toBeNull();
  });

  it('is skipped with "Not this week" and not asked again this week', async () => {
    renderRituals({ history: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Not this week' }));
    expect(await screen.findByRole('dialog', { name: DAILY }, { timeout: 6000 })).not.toBeNull();
    expect(window.localStorage.getItem(`ff-weekly:${userBody.id}:${currentWeek().week}`)).toBe(
      'skipped',
    );
  });
});
