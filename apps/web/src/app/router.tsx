import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router';

import { LoginPage } from '../features/auth/login-page';
import { RequireAuth } from '../features/auth/require-auth';
import { SignupPage } from '../features/auth/signup-page';
import { DashboardPage } from '../features/dashboard/dashboard-page';
import { SystemStatus } from '../features/system/system-status';

/** Minimal shell: the app name and a slot for the active route. No design work yet. */
function RootLayout() {
  return (
    <div className="min-h-screen bg-white text-slate-900">
      <header className="border-b border-slate-200 px-6 py-4">
        <h1 className="text-lg font-semibold">Focus Flow</h1>
      </header>
      <main className="px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}

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

// Code-based route tree: no file-based routing and no generated route file (plan I4).
const routeTree = rootRoute.addChildren([indexRoute, loginRoute, signupRoute, dashboardRoute]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
