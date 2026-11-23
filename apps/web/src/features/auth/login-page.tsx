import { loginRequestSchema } from '@focus-flow/contracts';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

import { AuthShell } from '../../ui/auth-shell';
import { useAuth } from './auth-context';
import { authErrorMessage } from './auth-messages';

const INVALID_INPUT = 'Enter a valid email address and a password of at least 8 characters.';

/** Plain, functional form. The visual pass is a later phase (plan I4). */
export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(): Promise<void> {
    // The same contract schema the API validates against, so a bad password length is
    // caught before a pointless round trip.
    const fields = loginRequestSchema.safeParse({ email: email.trim(), password });
    if (!fields.success) {
      setError(INVALID_INPUT);
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      await login(fields.data.email, fields.data.password);
      await navigate({ to: '/dashboard' });
    } catch (cause) {
      setError(authErrorMessage(cause));
      setSubmitting(false);
    }
  }

  return (
    <AuthShell>
      <section aria-labelledby="login-heading" className="space-y-5">
        <h2 id="login-heading" className="font-display text-5xl">
          Sign in
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
            <label htmlFor="login-email" className="block text-sm font-medium text-muted">
              Email
            </label>
            <input
              id="login-email"
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
            <label htmlFor="login-password" className="block text-sm font-medium text-muted">
              Password
            </label>
            <input
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              minLength={8}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
              className="w-full"
            />
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
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="text-sm text-muted">
          {'No account yet? '}
          <Link to="/signup" className="text-focus underline underline-offset-4">
            Create one
          </Link>
        </p>
      </section>
    </AuthShell>
  );
}
