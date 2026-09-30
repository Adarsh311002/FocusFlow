import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { render } from '@testing-library/react';

import { AuthProvider } from '../features/auth/auth-context';
import { RequireAuth } from '../features/auth/require-auth';
import { DashboardPage } from '../features/dashboard/dashboard-page';
import { createTestQueryClient } from './query-client';

export const LOGIN_TEXT = 'Login placeholder';

/** Mounts the real, guarded dashboard inside the real providers on an in-memory history. */
export function renderDashboard(): void {
  const rootRoute = createRootRoute({ component: Outlet });
  const dashboardRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/dashboard',
    component: () => (
      <RequireAuth>
        <DashboardPage />
      </RequireAuth>
    ),
  });
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    component: () => <p>{LOGIN_TEXT}</p>,
  });

  const router = createRouter({
    routeTree: rootRoute.addChildren([dashboardRoute, loginRoute]),
    history: createMemoryHistory({ initialEntries: ['/dashboard'] }),
  });

  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>,
  );
}
