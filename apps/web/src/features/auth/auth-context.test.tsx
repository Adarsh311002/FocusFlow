import { authPaths, mePaths } from '@focus-flow/contracts';
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  authBody,
  errorResponse,
  jsonResponse,
  noContentResponse,
  refreshBody,
  type RequestHandler,
  requestsTo,
  stubFetch,
  userBody,
} from '../../test/api-stub';
import { createTestQueryClient } from '../../test/query-client';
import { authedApiRequest, resetPendingRefresh } from './auth-client';
import { AuthProvider, useAuth } from './auth-context';
import { clearAccessToken, getAccessToken } from './token-store';

/**
 * Surfaces everything the context exposes as plain text, so the assertions read the way
 * the UI does. Rejections are captured into state rather than escaping as unhandled.
 */
function AuthProbe() {
  const { status, user, login, signup, logout } = useAuth();
  const [error, setError] = useState<string | null>(null);

  function report(cause: unknown): void {
    setError(cause instanceof Error ? cause.message : 'unknown failure');
  }

  return (
    <div>
      <p>{`status: ${status}`}</p>
      <p>{`user: ${user?.displayName ?? 'none'}`}</p>
      {error !== null && <p>{`error: ${error}`}</p>}
      <button
        type="button"
        onClick={() => {
          void login('ada@example.com', 'correct horse').catch(report);
        }}
      >
        run login
      </button>
      <button
        type="button"
        onClick={() => {
          void signup('ada@example.com', 'correct horse', 'Ada Lovelace').catch(report);
        }}
      >
        run signup
      </button>
      <button
        type="button"
        onClick={() => {
          void logout().catch(report);
        }}
      >
        run logout
      </button>
    </div>
  );
}

function renderProvider(queryClient: QueryClient = createTestQueryClient()): {
  unmount: () => void;
} {
  const { unmount } = render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { unmount };
}

function click(name: string): void {
  fireEvent.click(screen.getByRole('button', { name }));
}

/** Refresh succeeds and `/me` answers with the user: a returning, signed-in visitor. */
const liveSession: RequestHandler = (request) =>
  request.url.endsWith(authPaths.refresh)
    ? jsonResponse(200, refreshBody('restored-token'))
    : jsonResponse(200, { user: userBody });

/** No refresh cookie, or an expired one: a first-time or signed-out visitor. */
function noSession() {
  return errorResponse(401, 'SESSION_INVALID', 'Refresh session is invalid or expired.');
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearAccessToken();
  resetPendingRefresh();
});

describe('AuthProvider', () => {
  it('starts in the loading state while the session probe is in flight', () => {
    stubFetch(() => new Promise<never>(() => undefined));

    renderProvider();

    expect(screen.getByText('status: loading')).not.toBeNull();
  });

  it('resolves to anonymous when there is no refresh session', async () => {
    const calls = stubFetch(() => noSession());

    renderProvider();

    expect(await screen.findByText('status: anonymous')).not.toBeNull();
    expect(screen.getByText('user: none')).not.toBeNull();
    expect(requestsTo(calls, authPaths.refresh)).toHaveLength(1);
    expect(getAccessToken()).toBeNull();
  });

  it('resolves to authenticated with the user from /me when the session is live', async () => {
    const calls = stubFetch(liveSession);

    renderProvider();

    expect(await screen.findByText('status: authenticated')).not.toBeNull();
    expect(screen.getByText('user: Ada Lovelace')).not.toBeNull();
    expect(requestsTo(calls, authPaths.refresh)).toHaveLength(1);
    expect(requestsTo(calls, mePaths.self)).toHaveLength(1);
  });

  it('becomes authenticated after login(), with the token held in memory only', async () => {
    stubFetch((request) =>
      request.url.endsWith(authPaths.login)
        ? jsonResponse(200, authBody('login-token'))
        : noSession(),
    );
    renderProvider();
    expect(await screen.findByText('status: anonymous')).not.toBeNull();

    click('run login');

    expect(await screen.findByText('status: authenticated')).not.toBeNull();
    expect(screen.getByText('user: Ada Lovelace')).not.toBeNull();
    expect(getAccessToken()).toBe('login-token');
  });

  it('stays anonymous and rejects when login fails', async () => {
    stubFetch((request) =>
      request.url.endsWith(authPaths.login)
        ? errorResponse(401, 'INVALID_CREDENTIALS', 'Invalid email or password.')
        : noSession(),
    );
    renderProvider();
    expect(await screen.findByText('status: anonymous')).not.toBeNull();

    click('run login');

    expect(await screen.findByText('error: Invalid email or password.')).not.toBeNull();
    expect(screen.getByText('status: anonymous')).not.toBeNull();
    expect(getAccessToken()).toBeNull();
  });

  it('becomes authenticated after signup()', async () => {
    stubFetch((request) =>
      request.url.endsWith(authPaths.signup)
        ? jsonResponse(201, authBody('signup-token'))
        : noSession(),
    );
    renderProvider();
    expect(await screen.findByText('status: anonymous')).not.toBeNull();

    click('run signup');

    expect(await screen.findByText('status: authenticated')).not.toBeNull();
    expect(getAccessToken()).toBe('signup-token');
  });

  it('returns to anonymous and clears the token after logout()', async () => {
    const calls = stubFetch((request) =>
      request.url.endsWith(authPaths.logout) ? noContentResponse() : liveSession(request),
    );
    renderProvider();
    expect(await screen.findByText('status: authenticated')).not.toBeNull();

    click('run logout');

    expect(await screen.findByText('status: anonymous')).not.toBeNull();
    expect(screen.getByText('user: none')).not.toBeNull();
    expect(getAccessToken()).toBeNull();
    expect(requestsTo(calls, authPaths.logout)).toHaveLength(1);
  });
});

describe('AuthProvider storage invariant', () => {
  it('never writes to localStorage or sessionStorage across signup, reload and logout', async () => {
    // Narrowly scoped and restored: the spy keeps the real implementation, so nothing in
    // jsdom or Vitest that happens to use storage is broken by it.
    const setItem = vi.spyOn(Storage.prototype, 'setItem');

    try {
      stubFetch((request) => {
        if (request.url.endsWith(authPaths.signup)) {
          return jsonResponse(201, authBody('signup-token'));
        }
        if (request.url.endsWith(authPaths.logout)) {
          return noContentResponse();
        }
        return noSession();
      });

      const first = renderProvider();
      expect(await screen.findByText('status: anonymous')).not.toBeNull();
      click('run signup');
      expect(await screen.findByText('status: authenticated')).not.toBeNull();

      // Simulate a reload: the page's JS memory is gone, only the httpOnly cookie survives.
      first.unmount();
      clearAccessToken();
      resetPendingRefresh();
      vi.unstubAllGlobals();
      stubFetch((request) =>
        request.url.endsWith(authPaths.logout) ? noContentResponse() : liveSession(request),
      );

      renderProvider();
      // Signed in again purely from the cookie, with nothing read back from storage.
      expect(await screen.findByText('status: authenticated')).not.toBeNull();

      click('run logout');
      expect(await screen.findByText('status: anonymous')).not.toBeNull();

      expect(setItem).not.toHaveBeenCalled();
    } finally {
      setItem.mockRestore();
    }
  });
});

describe('AuthProvider query cache', () => {
  // Stands in for any per-user server data (for example the task list) that a signed-in
  // screen has cached.
  const CACHED_KEY = ['tasks', 'previous-user'];

  function seededClient(): QueryClient {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(CACHED_KEY, ['a private task']);
    return queryClient;
  }

  it('clears cached server data on logout', async () => {
    stubFetch((request) =>
      request.url.endsWith(authPaths.logout) ? noContentResponse() : liveSession(request),
    );
    const queryClient = createTestQueryClient();
    renderProvider(queryClient);
    expect(await screen.findByText('status: authenticated')).not.toBeNull();
    queryClient.setQueryData(CACHED_KEY, ['a private task']);

    click('run logout');

    expect(await screen.findByText('status: anonymous')).not.toBeNull();
    expect(queryClient.getQueryData(CACHED_KEY)).toBeUndefined();
  });

  it('clears data cached for a previous session when a new user logs in', async () => {
    stubFetch((request) =>
      request.url.endsWith(authPaths.login)
        ? jsonResponse(200, authBody('login-token'))
        : noSession(),
    );
    const queryClient = seededClient();
    renderProvider(queryClient);
    expect(await screen.findByText('status: anonymous')).not.toBeNull();

    click('run login');

    expect(await screen.findByText('status: authenticated')).not.toBeNull();
    expect(queryClient.getQueryData(CACHED_KEY)).toBeUndefined();
  });

  it('clears cached data on signup', async () => {
    stubFetch((request) =>
      request.url.endsWith(authPaths.signup)
        ? jsonResponse(201, authBody('signup-token'))
        : noSession(),
    );
    const queryClient = seededClient();
    renderProvider(queryClient);
    expect(await screen.findByText('status: anonymous')).not.toBeNull();

    click('run signup');

    expect(await screen.findByText('status: authenticated')).not.toBeNull();
    expect(queryClient.getQueryData(CACHED_KEY)).toBeUndefined();
  });

  it('clears cached data when the session ends on its own mid-app', async () => {
    stubFetch((request) => {
      if (request.url.endsWith('/tasks')) {
        return errorResponse(401, 'SESSION_REVOKED', 'This session has been revoked.');
      }
      return liveSession(request);
    });
    const queryClient = createTestQueryClient();
    renderProvider(queryClient);
    expect(await screen.findByText('status: authenticated')).not.toBeNull();
    queryClient.setQueryData(CACHED_KEY, ['a private task']);

    // Any authenticated request that learns the session was revoked ends it.
    await expect(authedApiRequest('/tasks', z.unknown())).rejects.toMatchObject({
      code: 'SESSION_REVOKED',
    });

    expect(await screen.findByText('status: anonymous')).not.toBeNull();
    await waitFor(() => {
      expect(queryClient.getQueryData(CACHED_KEY)).toBeUndefined();
    });
  });
});
