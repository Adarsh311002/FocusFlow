import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router';

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

// Code-based route tree: no file-based routing and no generated route file (plan I4).
const routeTree = rootRoute.addChildren([indexRoute]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
