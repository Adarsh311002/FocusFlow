import { Link, Outlet } from '@tanstack/react-router';

import { useAuth } from '../features/auth/auth-context';

const NAV_LINK = 'rounded px-2 py-1 text-sm hover:bg-slate-100';

/** The signed-in sections of the app; shown only once the session is known to be live. */
export function AppNav() {
  const { status } = useAuth();
  if (status !== 'authenticated') {
    return null;
  }
  return (
    <nav aria-label="Main">
      <ul className="flex gap-2">
        <li>
          <Link
            to="/dashboard"
            className={NAV_LINK}
            activeProps={{ 'aria-current': 'page', className: 'font-semibold' }}
          >
            Dashboard
          </Link>
        </li>
        <li>
          <Link
            to="/review"
            className={NAV_LINK}
            activeProps={{ 'aria-current': 'page', className: 'font-semibold' }}
          >
            Review
          </Link>
        </li>
      </ul>
    </nav>
  );
}

/** Minimal shell: the app name, the signed-in navigation and a slot for the active route. */
export function RootLayout() {
  return (
    <div className="min-h-screen bg-white text-slate-900">
      <header className="flex items-center justify-between gap-4 border-b border-slate-200 px-6 py-4">
        <h1 className="text-lg font-semibold">Focus Flow</h1>
        <AppNav />
      </header>
      <main className="px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}
