import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

import { useAuth } from '../auth/auth-context';
import { authErrorMessage } from '../auth/auth-messages';

/**
 * Placeholder: it exists to prove the authenticated state survives the round trip
 * through refresh-on-load. Real dashboard features arrive in a later phase.
 */
export function DashboardPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  async function signOut(): Promise<void> {
    setError(null);
    setSigningOut(true);
    try {
      await logout();
      await navigate({ to: '/login' });
    } catch (cause) {
      setError(authErrorMessage(cause));
      setSigningOut(false);
    }
  }

  return (
    <section aria-labelledby="dashboard-heading" className="max-w-md space-y-3">
      <h2 id="dashboard-heading" className="text-base font-semibold">
        Dashboard
      </h2>

      {user === null ? (
        <p className="text-slate-600">No signed-in user.</p>
      ) : (
        <dl className="space-y-1 text-sm">
          <div>
            <dt className="inline font-medium">Signed in as: </dt>
            <dd className="inline">{user.displayName}</dd>
          </div>
          <div>
            <dt className="inline font-medium">Email: </dt>
            <dd className="inline">{user.email}</dd>
          </div>
        </dl>
      )}

      {error !== null && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}

      <button
        type="button"
        disabled={signingOut}
        onClick={() => {
          void signOut();
        }}
        className="rounded border border-slate-300 px-3 py-1 disabled:opacity-50"
      >
        {signingOut ? 'Signing out…' : 'Sign out'}
      </button>
    </section>
  );
}
