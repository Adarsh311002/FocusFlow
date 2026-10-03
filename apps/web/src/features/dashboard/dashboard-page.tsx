import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

import { useAuth } from '../auth/auth-context';
import { authErrorMessage } from '../auth/auth-messages';
import { ConnectionStatus } from '../realtime/connection-status';
import { CurrentTask } from '../tasks/current-task';
import { TasksPanel } from '../tasks/tasks-panel';

/**
 * The signed-in home: the current task first (what the user decided to work on), then
 * task management. The visual design is deferred (plan I4).
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
    <section aria-labelledby="dashboard-heading" className="max-w-xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
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
          {user !== null && <ConnectionStatus />}
        </div>

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
      </div>

      {error !== null && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}

      {user !== null && (
        <>
          <CurrentTask />
          <TasksPanel />
        </>
      )}
    </section>
  );
}
