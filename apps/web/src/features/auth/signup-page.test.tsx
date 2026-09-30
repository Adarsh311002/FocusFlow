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
  fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
}

function fillValidForm(): void {
  fill('Display name', 'Ada Lovelace');
  fill('Email', 'ada@example.com');
  fill('Password', 'correct horse');
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearAccessToken();
  resetPendingRefresh();
});

describe('SignupPage', () => {
  it('renders labelled display name, email and password fields', async () => {
    stubFetch(() => noSession());

    renderAuthRoutes('/signup');

    expect(await screen.findByLabelText('Display name')).not.toBeNull();
    expect(screen.getByLabelText('Email')).not.toBeNull();
    expect(screen.getByLabelText('Password')).not.toBeNull();
  });

  it('posts the signup body and lands on the dashboard on success', async () => {
    const calls = stubFetch((request) =>
      request.url.endsWith(authPaths.signup)
        ? jsonResponse(201, authBody('signup-token'))
        : noSession(),
    );
    renderAuthRoutes('/signup');
    await screen.findByLabelText('Display name');

    fillValidForm();
    submit();

    expect(await screen.findByText(DASHBOARD_TEXT)).not.toBeNull();
    expect(parsedBody(requestsTo(calls, authPaths.signup)[0]!)).toEqual({
      email: 'ada@example.com',
      password: 'correct horse',
      displayName: 'Ada Lovelace',
    });
  });

  it('shows EMAIL_TAKEN as visible text and stays on the signup page', async () => {
    stubFetch((request) =>
      request.url.endsWith(authPaths.signup)
        ? errorResponse(409, 'EMAIL_TAKEN', 'Email already registered.')
        : noSession(),
    );
    renderAuthRoutes('/signup');
    await screen.findByLabelText('Display name');

    fillValidForm();
    submit();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('An account already exists for that email address.');
    expect(screen.queryByText(DASHBOARD_TEXT)).toBeNull();
  });

  it('rejects a too-short password before reaching the network', async () => {
    const calls = stubFetch(() => noSession());
    renderAuthRoutes('/signup');
    await screen.findByLabelText('Display name');

    fill('Display name', 'Ada Lovelace');
    fill('Email', 'ada@example.com');
    fill('Password', 'short');
    submit();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('at least 8 characters');
    expect(requestsTo(calls, authPaths.signup)).toHaveLength(0);
  });

  it('disables the submit button while the request is in flight', async () => {
    stubFetch((request) =>
      request.url.endsWith(authPaths.signup) ? new Promise<never>(() => undefined) : noSession(),
    );
    renderAuthRoutes('/signup');
    await screen.findByLabelText('Display name');

    fillValidForm();
    submit();

    const button = await screen.findByRole('button', { name: 'Creating account…' });
    expect(button.hasAttribute('disabled')).toBe(true);
  });
});
