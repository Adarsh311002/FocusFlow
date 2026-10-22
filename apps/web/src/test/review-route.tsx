import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';

import { RootLayout } from '../app/root-layout';
import { router as appRouter } from '../app/router';
import { AuthProvider } from '../features/auth/auth-context';
import { RequireAuth } from '../features/auth/require-auth';
import { ReviewPage } from '../features/review/review-page';
import { createTestQueryClient } from './query-client';

/** The providers the real app wraps the router in (app/providers.tsx), minus realtime. */
function renderWithProviders(ui: ReactNode): void {
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <AuthProvider>{ui}</AuthProvider>
    </QueryClientProvider>,
  );
}

export const REVIEW_LOGIN_TEXT = 'Login placeholder';
export const REVIEW_DASHBOARD_TEXT = 'Dashboard placeholder';

/**
 * Mounts the real app shell (with its navigation) and the real, guarded Review page on an
 * in-memory history. The dashboard is a placeholder so only the review API is involved.
 */
export function renderReview(initialPath: '/review' | '/dashboard' = '/review'): void {
  const rootRoute = createRootRoute({ component: RootLayout });
  const reviewRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/review',
    component: () => (
      <RequireAuth>
        <ReviewPage />
      </RequireAuth>
    ),
  });
  const dashboardRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/dashboard',
    component: () => (
      <RequireAuth>
        <p>{REVIEW_DASHBOARD_TEXT}</p>
      </RequireAuth>
    ),
  });
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    component: () => <p>{REVIEW_LOGIN_TEXT}</p>,
  });

  const router = createRouter({
    routeTree: rootRoute.addChildren([reviewRoute, dashboardRoute, loginRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });

  renderWithProviders(<RouterProvider router={router} />);
}

/**
 * Mounts the application's own route tree (app/router.tsx) on an in-memory history, so a
 * test can exercise the real `/review` route — its guard, its component and its place in
 * the shell — instead of a copy. The app's router is a module singleton that keeps the
 * location it last navigated to, so each test gets a fresh router over the same routes.
 */
export function renderAppRoute(initialPath: '/review' | '/login' = '/review'): void {
  const router = createRouter({
    routeTree: appRouter.routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  renderWithProviders(<RouterProvider router={router} />);
}
