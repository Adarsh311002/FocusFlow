import { loginRequestSchema } from '@focus-flow/contracts';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

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
    <section aria-labelledby="login-heading" className="max-w-sm space-y-4">
      <h2 id="login-heading" className="text-base font-semibold">
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
          <label htmlFor="login-email" className="block text-sm font-medium">
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
            className="w-full rounded border border-slate-300 px-2 py-1"
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="login-password" className="block text-sm font-medium">
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
            className="w-full rounded border border-slate-300 px-2 py-1"
          />
        </div>

        {error !== null && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-slate-900 px-3 py-1 text-white disabled:opacity-50"
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <p className="text-sm">
        {'No account yet? '}
        <Link to="/signup" className="underline">
          Create one
        </Link>
      </p>
    </section>
  );
}
