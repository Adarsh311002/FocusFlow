import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';

import { LoginPage } from '../features/auth/login-page';
import { RequireAuth } from '../features/auth/require-auth';
import { SignupPage } from '../features/auth/signup-page';
import { DashboardPage } from '../features/dashboard/dashboard-page';
import { ReviewPage } from '../features/review/review-page';
import { SystemStatus } from '../features/system/system-status';
import { RootLayout } from './root-layout';

const rootRoute = createRootRoute({ component: RootLayout });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: SystemStatus,
});

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

/**
 * Guarded in the component rather than in `beforeLoad`: the session is only known after
 * the refresh-on-load probe resolves, and `RequireAuth` can render a loading state while
 * it does. A `beforeLoad` redirect would have to either block navigation or guess.
 */
function ProtectedDashboard() {
  return (
    <RequireAuth>
      <DashboardPage />
    </RequireAuth>
  );
}

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/dashboard',
  component: ProtectedDashboard,
});

/** The review step of the loop (Phase 5): history and summary, guarded like the dashboard. */
function ProtectedReview() {
  return (
    <RequireAuth>
      <ReviewPage />
    </RequireAuth>
  );
}

const reviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/review',
  component: ProtectedReview,
});

// Code-based route tree: no file-based routing and no generated route file (plan I4).
const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  signupRoute,
  dashboardRoute,
  reviewRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
