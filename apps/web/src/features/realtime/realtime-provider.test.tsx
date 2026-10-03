import { authPaths } from '@focus-flow/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  jsonResponse,
  noContentResponse,
  refreshBody,
  stubFetch,
  userBody,
} from '../../test/api-stub';
import { createTestQueryClient } from '../../test/query-client';
import { createStubRealtimeClient } from '../../test/realtime-stub';
import { resetPendingRefresh } from '../auth/auth-client';
import { AuthProvider, useAuth } from '../auth/auth-context';
import { clearAccessToken } from '../auth/token-store';
import { ConnectionStatus } from './connection-status';
import { RealtimeProvider } from './realtime-provider';

afterEach(() => {
  vi.unstubAllGlobals();
  clearAccessToken();
  resetPendingRefresh();
});

function LogoutButton() {
  const { logout } = useAuth();
  return (
    <button
      type="button"
      onClick={() => {
        void logout();
      }}
    >
      log out
    </button>
  );
}

const renderWith = (client: ReturnType<typeof createStubRealtimeClient>) =>
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <AuthProvider>
        <RealtimeProvider client={client}>
          <ConnectionStatus />
          <LogoutButton />
        </RealtimeProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );

describe('RealtimeProvider', () => {
  it('stays disconnected while nobody is signed in', async () => {
    stubFetch(() => jsonResponse(401, { error: { code: 'SESSION_INVALID', message: 'x' } }));
    const client = createStubRealtimeClient();

    renderWith(client);

    expect(await screen.findByText('Live connection: offline')).not.toBeNull();
    expect(client.calls).not.toContain('connect');
  });

  it('connects once signed in and disconnects on logout', async () => {
    stubFetch((request) => {
      if (request.url.endsWith(authPaths.refresh)) {
        return jsonResponse(200, refreshBody('live-token'));
      }
      if (request.url.endsWith(authPaths.logout)) {
        return noContentResponse();
      }
      return jsonResponse(200, { user: userBody });
    });
    const client = createStubRealtimeClient();

    renderWith(client);
    expect(await screen.findByText('Live connection: connected')).not.toBeNull();
    expect(client.calls.at(-1)).toBe('connect');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'log out' }));
      await Promise.resolve();
    });

    expect(await screen.findByText('Live connection: offline')).not.toBeNull();
    expect(client.calls.at(-1)).toBe('disconnect');
  });
});
