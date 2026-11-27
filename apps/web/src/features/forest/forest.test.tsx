import type { ForestResponse } from '@focus-flow/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { jsonResponse, stubFetch, userBody } from '../../test/api-stub';
import { createFakeTaskApi } from '../../test/fake-task-api';
import { createTestQueryClient } from '../../test/query-client';
import { resetPendingRefresh } from '../auth/auth-client';
import { AuthProvider } from '../auth/auth-context';
import { clearAccessToken } from '../auth/token-store';
import { ForestPage } from './forest-page';
import { ForestUnlocks } from './forest-unlocks';

// "Grow your forest" on the web (GF6).

const MILESTONES = [
  'first-seed',
  'ten-sessions',
  'ten-hours',
  'week-streak',
  'intentions-25',
  'deep-flow',
  'together',
  'hundred-hours',
] as const;
const CREATURES = ['firefly', 'frog', 'butterfly', 'toucan', 'owl', 'sloth', 'monkey', 'jaguar'];

function forest(unlocked: readonly string[]): ForestResponse {
  return {
    totals: {
      plants: 2,
      completedSessions: 2,
      focusedSeconds: 3_000,
      intentionsDone: 1,
      deepSessions: 0,
      currentStreak: 1,
      longestStreak: 2,
    },
    vitality: 0.5,
    plants: [
      {
        id: '01900000-0000-7000-8000-000000000001',
        kind: 'sapling',
        bloom: true,
        glow: false,
        plantedAt: '2026-11-24T09:00:00.000Z',
      },
      {
        id: '01900000-0000-7000-8000-000000000002',
        kind: 'tree',
        bloom: false,
        glow: true,
        plantedAt: '2026-11-25T09:00:00.000Z',
      },
    ] as ForestResponse['plants'],
    milestones: MILESTONES.map((id, index) => ({
      id,
      creature: CREATURES[index] as ForestResponse['milestones'][number]['creature'],
      current: unlocked.includes(id) ? 1 : 0,
      target: 1,
      unlockedAt: unlocked.includes(id) ? '2026-11-24T09:25:00.000Z' : null,
    })),
  };
}

let answer: ForestResponse = forest([]);

function renderWith(element: React.ReactNode) {
  const api = createFakeTaskApi();
  stubFetch((request) =>
    new URL(request.url, 'http://localhost').pathname.endsWith('/forest')
      ? jsonResponse(200, answer)
      : api.handle(request),
  );
  const root = createRootRoute({ component: () => <>{element}</> });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: '/', component: () => null }),
      createRoute({ getParentRoute: () => root, path: '/forest', component: () => null }),
      createRoute({ getParentRoute: () => root, path: '/dashboard', component: () => null }),
    ]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const client = createTestQueryClient();
  render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { client };
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

describe('the forest page', () => {
  it('shows the forest’s numbers and who lives there, reached or not', async () => {
    answer = forest(['first-seed', 'ten-hours']);
    renderWith(<ForestPage />);

    expect(
      await screen.findByText('Growing steadily. Light comes through the canopy.'),
    ).not.toBeNull();
    const list = screen.getByRole('list');
    expect(within(list).getByRole('listitem', { name: 'The first seed, reached' })).not.toBeNull();
    expect(within(list).getByRole('listitem', { name: 'Ten deep hours, reached' })).not.toBeNull();
    expect(within(list).getByRole('listitem', { name: 'A small grove, not yet' })).not.toBeNull();
    expect(screen.getByText('2/8')).not.toBeNull();
  });
});

describe('creature arrivals', () => {
  it('stays quiet on the first visit, then announces a newly reached milestone', async () => {
    answer = forest(['first-seed']);
    const { client } = renderWith(<ForestUnlocks />);
    await waitFor(() => {
      expect(window.localStorage.getItem(`ff-forest-seen:${userBody.id}`)).toBe('["first-seed"]');
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    });
    expect(screen.queryByText(/moved into your forest/)).toBeNull();

    answer = forest(['first-seed', 'ten-sessions']);
    await act(async () => {
      await client.invalidateQueries();
    });
    expect(await screen.findByText('A frog moved into your forest')).not.toBeNull();
    expect(screen.getByRole('link', { name: 'Visit your forest' })).not.toBeNull();
  });
});
