import { authPaths } from '@focus-flow/contracts';
import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  authBody,
  errorResponse,
  jsonResponse,
  parsedBody,
  requestsTo,
  stubFetch,
} from '../../test/api-stub';
import { DASHBOARD_TEXT, renderAuthRoutes } from '../../test/auth-routes';
import { resetPendingRefresh } from './auth-client';
import { clearAccessToken } from './token-store';

function noSession() {
  return errorResponse(401, 'SESSION_INVALID', 'Refresh session is invalid or expired.');
}

function fill(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function submit(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearAccessToken();
  resetPendingRefresh();
});

describe('LoginPage', () => {
  it('renders labelled email and password fields', async () => {
    stubFetch(() => noSession());

    renderAuthRoutes('/login');

    expect(await screen.findByLabelText('Email')).not.toBeNull();
    expect(screen.getByLabelText('Password')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Sign in' })).not.toBeNull();
  });

  it('posts the credentials and lands on the dashboard on success', async () => {
    const calls = stubFetch((request) =>
      request.url.endsWith(authPaths.login)
        ? jsonResponse(200, authBody('login-token'))
        : noSession(),
    );
    renderAuthRoutes('/login');
    await screen.findByLabelText('Email');

    fill('Email', 'ada@example.com');
    fill('Password', 'correct horse');
    submit();

    expect(await screen.findByText(DASHBOARD_TEXT)).not.toBeNull();
    expect(parsedBody(requestsTo(calls, authPaths.login)[0]!)).toEqual({
      email: 'ada@example.com',
      password: 'correct horse',
    });
  });

  it('shows INVALID_CREDENTIALS as visible text and stays on the sign-in page', async () => {
    stubFetch((request) =>
      request.url.endsWith(authPaths.login)
        ? errorResponse(401, 'INVALID_CREDENTIALS', 'Invalid email or password.')
        : noSession(),
    );
    renderAuthRoutes('/login');
    await screen.findByLabelText('Email');

    fill('Email', 'ada@example.com');
    fill('Password', 'wrong password');
    submit();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('That email address and password do not match an account.');
    expect(screen.queryByText(DASHBOARD_TEXT)).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign in' })).not.toBeNull();
  });

  it('rejects a too-short password before reaching the network', async () => {
    const calls = stubFetch(() => noSession());
    renderAuthRoutes('/login');
    await screen.findByLabelText('Email');

    fill('Email', 'ada@example.com');
    fill('Password', 'short');
    submit();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('at least 8 characters');
    expect(requestsTo(calls, authPaths.login)).toHaveLength(0);
  });

  it('disables the submit button while the request is in flight', async () => {
    stubFetch((request) =>
      request.url.endsWith(authPaths.login) ? new Promise<never>(() => undefined) : noSession(),
    );
    renderAuthRoutes('/login');
    await screen.findByLabelText('Email');

    fill('Email', 'ada@example.com');
    fill('Password', 'correct horse');
    submit();

    const button = await screen.findByRole('button', { name: 'Signing in…' });
    expect(button.hasAttribute('disabled')).toBe(true);
  });
});
