import { signupRequestSchema } from '@focus-flow/contracts';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

import { AuthShell } from '../../ui/auth-shell';
import { useAuth } from './auth-context';
import { authErrorMessage } from './auth-messages';

const INVALID_INPUT =
  'Enter a display name, a valid email address, and a password of at least 8 characters.';

/** Plain, functional form. The visual pass is a later phase (plan I4). */
export function SignupPage() {
  const { signup } = useAuth();
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(): Promise<void> {
    // The same contract schema the API validates against, so the 8-character minimum is
    // enforced here too rather than only being reported by the server.
    const fields = signupRequestSchema.safeParse({ displayName, email: email.trim(), password });
    if (!fields.success) {
      setError(INVALID_INPUT);
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      await signup(fields.data.email, fields.data.password, fields.data.displayName);
      await navigate({ to: '/dashboard' });
    } catch (cause) {
      setError(authErrorMessage(cause));
      setSubmitting(false);
    }
  }

  return (
    <AuthShell>
      <section aria-labelledby="signup-heading" className="space-y-5">
        <h2 id="signup-heading" className="font-display text-5xl">
          Create an account
        </h2>

        <form
          noValidate
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="space-y-1">
            <label htmlFor="signup-display-name" className="block text-sm font-medium text-muted">
              Display name
            </label>
            <input
              id="signup-display-name"
              name="displayName"
              type="text"
              autoComplete="name"
              required
              maxLength={50}
              value={displayName}
              onChange={(event) => {
                setDisplayName(event.target.value);
              }}
              className="w-full"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="signup-email" className="block text-sm font-medium text-muted">
              Email
            </label>
            <input
              id="signup-email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
              className="w-full"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="signup-password" className="block text-sm font-medium text-muted">
              Password
            </label>
            <input
              id="signup-password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
              className="w-full"
            />
            <p className="text-xs text-muted">At least 8 characters.</p>
          </div>

          {error !== null && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-full bg-focus px-4 py-3 font-medium text-focus-ink shadow-glow transition hover:brightness-110 disabled:opacity-50"
          >
            {submitting ? 'Creating account…' : 'Create account'}
          </button>
        </form>

        <p className="text-sm text-muted">
          {'Already have an account? '}
          <Link to="/login" className="text-focus underline underline-offset-4">
            Sign in
          </Link>
        </p>
      </section>
    </AuthShell>
  );
}
