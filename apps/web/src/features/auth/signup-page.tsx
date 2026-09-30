import { signupRequestSchema } from '@focus-flow/contracts';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

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
    <section aria-labelledby="signup-heading" className="max-w-sm space-y-4">
      <h2 id="signup-heading" className="text-base font-semibold">
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
          <label htmlFor="signup-display-name" className="block text-sm font-medium">
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
            className="w-full rounded border border-slate-300 px-2 py-1"
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="signup-email" className="block text-sm font-medium">
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
            className="w-full rounded border border-slate-300 px-2 py-1"
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="signup-password" className="block text-sm font-medium">
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
            className="w-full rounded border border-slate-300 px-2 py-1"
          />
          <p className="text-xs text-slate-600">At least 8 characters.</p>
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
          {submitting ? 'Creating account…' : 'Create account'}
        </button>
      </form>

      <p className="text-sm">
        {'Already have an account? '}
        <Link to="/login" className="underline">
          Sign in
        </Link>
      </p>
    </section>
  );
}
