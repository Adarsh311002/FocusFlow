import { authPaths } from '@focus-flow/contracts';
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { errorResponse, jsonResponse, refreshBody, stubFetch, userBody } from '../../test/api-stub';
import { DASHBOARD_TEXT, renderAuthRoutes } from '../../test/auth-routes';
import { resetPendingRefresh } from './auth-client';
import { clearAccessToken } from './token-store';

afterEach(() => {
  vi.unstubAllGlobals();
  clearAccessToken();
  resetPendingRefresh();
});

describe('RequireAuth', () => {
  it('waits instead of redirecting while the session probe is still in flight', async () => {
    stubFetch(() => new Promise<never>(() => undefined));

    renderAuthRoutes('/dashboard');

    const pending = await screen.findByRole('status');
    expect(pending.textContent).toContain('Checking your session');
    expect(screen.queryByText(DASHBOARD_TEXT)).toBeNull();
    // Crucially, no flash-redirect: the sign-in form is not on screen yet.
    expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull();
  });

  it('redirects to the sign-in page once the visitor is known to be anonymous', async () => {
    stubFetch(() => errorResponse(401, 'SESSION_INVALID', 'Refresh session is invalid.'));

    renderAuthRoutes('/dashboard');

    expect(await screen.findByRole('heading', { name: 'Sign in' })).not.toBeNull();
    expect(screen.queryByText(DASHBOARD_TEXT)).toBeNull();
  });

  it('renders the protected content for a restored session', async () => {
    stubFetch((request) =>
      request.url.endsWith(authPaths.refresh)
        ? jsonResponse(200, refreshBody('restored-token'))
        : jsonResponse(200, { user: userBody }),
    );

    renderAuthRoutes('/dashboard');

    expect(await screen.findByText(DASHBOARD_TEXT)).not.toBeNull();
  });
});
