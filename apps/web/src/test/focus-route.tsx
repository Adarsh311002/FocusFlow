import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { act, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { vi } from 'vitest';

import { RootLayout } from '../app/root-layout';
import { AuthProvider, useAuth } from '../features/auth/auth-context';
import { RequireAuth } from '../features/auth/require-auth';
import { DashboardPage } from '../features/dashboard/dashboard-page';
import { useFocusSessionEvents } from '../features/focus/focus-queries';
import type { RealtimeClient } from '../features/realtime/realtime-client';
import { RealtimeProvider } from '../features/realtime/realtime-provider';
import { ReviewPage } from '../features/review/review-page';
import { type RecordedRequest, stubFetch } from './api-stub';
import { createFakeFocusSessionApi, createGate, type Gate } from './fake-focus-session-api';
import { createFakeTaskApi } from './fake-task-api';
import { createTestQueryClient } from './query-client';
import { createStubRealtimeClient } from './realtime-stub';

export const FOCUS_LOGIN_TEXT = 'Login placeholder';

/** Mounts the subscription exactly as app/providers.tsx does. */
function FocusSessionEvents() {
  useFocusSessionEvents();
  return null;
}

/** Test-only buttons that drive the real auth context (sign out; sign in as someone else). */
function SessionHarness() {
  const { logout, login } = useAuth();
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          void logout();
        }}
      >
        Test sign out
      </button>
      <button
        type="button"
        onClick={() => {
          void login('grace@example.com', 'password-1');
        }}
      >
        Test sign in as another user
      </button>
    </div>
  );
}

/**
 * The task and focus fakes behind one handler, wired together: a session can only be
 * started on a task the task fake holds. Focus and login routes go to the focus fake;
 * everything else (refresh, `/me`, `/tasks`) to the task fake.
 */
export function createFocusWorld(options: { now?: (() => number) | undefined } = {}) {
  const taskApi = createFakeTaskApi();
  const focusApi = createFakeFocusSessionApi({
    now: options.now,
    findTask: (id) => {
      const task = taskApi.tasks.find((candidate) => candidate.id === id);
      return task === undefined
        ? undefined
        : {
            title: task.title,
            completed: task.completedAt !== null,
            deleted: task.deletedAt !== null,
          };
    },
  });
  const handle = (request: RecordedRequest): Response => {
    const path = new URL(request.url, 'http://localhost').pathname;
    return path.includes('/focus-sessions') || path.endsWith('/auth/login')
      ? focusApi.handle(request)
      : taskApi.handle(request);
  };
  return { taskApi, focusApi, handle };
}

/**
 * The guarded dashboard and Review pages inside the real shell, the real providers and a
 * stub realtime client, on an in-memory history. Returns what tests drive: the realtime
 * stub (push events, change status), the query client and the router.
 */
export function renderFocusApp(
  options: {
    initialPath?: '/dashboard' | '/review';
    strict?: boolean;
    /** A real realtime client over a fake socket, instead of the stub. */
    client?: RealtimeClient;
  } = {},
) {
  const rootRoute = createRootRoute({ component: RootLayout });
  const dashboardRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/dashboard',
    component: () => (
      <RequireAuth>
        <DashboardPage />
      </RequireAuth>
    ),
  });
  const reviewRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/review',
    component: () => (
      <RequireAuth>
        <ReviewPage />
      </RequireAuth>
    ),
  });
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    component: () => <p>{FOCUS_LOGIN_TEXT}</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([dashboardRoute, reviewRoute, loginRoute]),
    history: createMemoryHistory({ initialEntries: [options.initialPath ?? '/dashboard'] }),
  });
  const realtime = createStubRealtimeClient();
  const queryClient = createTestQueryClient();

  const tree = (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RealtimeProvider client={options.client ?? realtime}>
          <FocusSessionEvents />
          <SessionHarness />
          <RouterProvider router={router} />
        </RealtimeProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
  const { unmount } = render(options.strict === true ? <StrictMode>{tree}</StrictMode> : tree);
  return { realtime, queryClient, router, unmount };
}

/** The world behind a stubbed `fetch`, with a way to hold one response in flight. */
export function startFocusWorld(options: { now?: (() => number) | undefined } = {}) {
  const world = createFocusWorld(options);
  const holds: Array<{ match: (request: RecordedRequest) => boolean; gate: Gate }> = [];
  const calls = stubFetch(async (request) => {
    // The answer is computed when the request arrives (the server's state at that moment)
    // and delivered only when the gate opens: a slow response (out-of-order tests).
    const response = world.handle(request);
    const index = holds.findIndex((hold) => hold.match(request));
    const [hold] = index < 0 ? [] : holds.splice(index, 1);
    await hold?.gate.wait;
    return response;
  });
  return {
    ...world,
    calls,
    /** Holds the next request `match` accepts until the returned function is called. */
    hold: (match: (request: RecordedRequest) => boolean): (() => void) => {
      const gate = createGate();
      holds.push({ match, gate });
      return gate.open;
    },
  };
}

export const pathOf = (request: RecordedRequest): string =>
  new URL(request.url, 'http://localhost').pathname.replace('/api/v1', '');

/** Requests to `/focus-sessions…` other than reads; what the user's actions cause. */
export const focusWrites = (calls: readonly RecordedRequest[]): RecordedRequest[] =>
  calls.filter((call) => call.method === 'POST' && pathOf(call).startsWith('/focus-sessions'));

export const currentReads = (calls: readonly RecordedRequest[]): RecordedRequest[] =>
  calls.filter((call) => call.method === 'GET' && pathOf(call) === '/focus-sessions/current');

/**
 * Runs fake timers forward and lets React and TanStack Query flush. Only for tests that
 * installed fake timers; real-timer tests use `findBy…`. Time moves in small steps, each in
 * its own `act`: React runs effects (and so starts the requests they cause) only when an
 * `act` scope ends, so one long step would leave later requests unstarted.
 */
export async function settle(ms = 100): Promise<void> {
  const steps = Math.min(60, Math.max(1, Math.ceil(ms / 100)));
  for (let step = 0; step < steps; step += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms / steps);
      // A few real macrotask turns, which React and the fetch stub also rely on.
      for (let turn = 0; turn < 3; turn += 1) {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        await vi.advanceTimersByTimeAsync(0);
      }
    });
  }
}
