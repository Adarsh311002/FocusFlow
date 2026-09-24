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
import { LoginPage } from '../features/auth/login-page';
import { RequireAuth } from '../features/auth/require-auth';
import { SignupPage } from '../features/auth/signup-page';

export const DASHBOARD_TEXT = 'Dashboard placeholder';

/**
 * Stands in for the real dashboard so a test can tell "we navigated" from "we stayed",
 * while still exercising the real route guard.
 */
function ProtectedPlaceholder() {
  return (
    <RequireAuth>
      <p>{DASHBOARD_TEXT}</p>
    </RequireAuth>
  );
}

/**
 * Mounts the real auth routes on an in-memory history, inside a real `AuthProvider`, so
 * `useNavigate`, `<Link>` and `<Navigate>` behave as they do in the app.
 */
export function renderAuthRoutes(initialPath: '/login' | '/signup' | '/dashboard'): void {
  const rootRoute = createRootRoute({ component: Outlet });

  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    component: LoginPage,
  });
  const signupRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/signup',
    component: SignupPage,
  });
  const dashboardRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/dashboard',
    component: ProtectedPlaceholder,
  });

  const router = createRouter({
    routeTree: rootRoute.addChildren([loginRoute, signupRoute, dashboardRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });

  render(
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>,
  );
}
