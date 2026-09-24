import { Navigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { useAuth } from './auth-context';

/**
 * Gate for routes that need a signed-in user.
 *
 * The loading state matters as much as the redirect: after a reload the app does not yet
 * know whether the refresh cookie names a live session, and redirecting during that gap
 * would bounce a signed-in user to the sign-in page for a frame.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();

  if (status === 'loading') {
    return (
      <p role="status" aria-live="polite" className="text-slate-600">
        Checking your session…
      </p>
    );
  }

  if (status === 'anonymous') {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}
