import { authPaths } from '@focus-flow/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  errorResponse,
  jsonResponse,
  refreshBody,
  stubFetch,
  type StubResponse,
} from '../../test/api-stub';
import { createFakeFocusSessionApi, emptySummary } from '../../test/fake-focus-session-api';
import { renderAppRoute } from '../../test/review-route';
import { resetPendingRefresh } from '../auth/auth-client';
import { clearAccessToken } from '../auth/token-store';

// The app's own route tree (app/router.tsx) rather than a hand-built copy: these tests
// cover that `/review` is really wired to the guarded Review page inside the shell, and
// how the shell's navigation behaves before the session is known.

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearAccessToken();
  resetPendingRefresh();
});

const isRefresh = (url: string) => url.endsWith(authPaths.refresh);

function startApi() {
  const api = createFakeFocusSessionApi();
  api.setSummary(emptySummary(['2026-03-08']));
  return api;
}

describe('the app /review route', () => {
  it('renders the real Review page inside the app shell', async () => {
    const api = startApi();
    stubFetch((request) => api.handle(request));

    renderAppRoute('/review');

    expect(await screen.findByRole('heading', { name: 'Review' })).not.toBeNull();
    expect(await screen.findByRole('region', { name: 'Last 7 days' })).not.toBeNull();
    expect(await screen.findByText('No focus sessions yet.')).not.toBeNull();

    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Review' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('sends an anonymous visitor to the real sign-in page with no navigation', async () => {
    stubFetch(() => errorResponse(401, 'SESSION_INVALID', 'No session.'));

    renderAppRoute('/review');

    expect(await screen.findByRole('heading', { name: 'Sign in' })).not.toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
  });

  it('hides the navigation while the session is still unknown and shows it once signed in', async () => {
    const api = startApi();
    let release: (() => void) | undefined;
    stubFetch((request) => {
      if (isRefresh(request.url)) {
        // Holds the session probe open, which is the state the app is in after a reload.
        return new Promise<StubResponse>((resolve) => {
          release = () => {
            resolve(jsonResponse(200, refreshBody('restored')));
          };
        });
      }
      return api.handle(request);
    });

    renderAppRoute('/review');

    expect(await screen.findByText('Checking your session…')).not.toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();

    release?.();

    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Dashboard', 'Review']);
    await waitFor(() => {
      expect(screen.getByText('No focus sessions yet.')).not.toBeNull();
    });
  });
});
