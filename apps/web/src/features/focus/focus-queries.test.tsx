import type { FocusSessionView } from '@focus-flow/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakeSession } from '../../test/fake-focus-session-api';
import { focusWrites, startFocusWorld } from '../../test/focus-route';
import { createTestQueryClient } from '../../test/query-client';
import { createStubRealtimeClient } from '../../test/realtime-stub';
import { resetPendingRefresh } from '../auth/auth-client';
import { AuthProvider, useAuth } from '../auth/auth-context';
import { clearAccessToken } from '../auth/token-store';
import { RealtimeProvider } from '../realtime/realtime-provider';
import {
  focusCurrentKey,
  useCurrentFocusSession,
  useDismissLastEnded,
  useLastEndedFocusSession,
  usePauseFocusSession,
  useStartFocusSession,
} from './focus-queries';

afterEach(() => {
  vi.unstubAllGlobals();
  clearAccessToken();
  resetPendingRefresh();
});

/** Exposes the hooks' results as text and their actions as buttons. */
function Probe({ onResult }: { onResult: (session: FocusSessionView) => void }) {
  const { status } = useAuth();
  const current = useCurrentFocusSession();
  const start = useStartFocusSession();
  const pause = usePauseFocusSession();
  const lastEnded = useLastEndedFocusSession();
  const dismiss = useDismissLastEnded();
  if (status !== 'authenticated') {
    return null;
  }
  return (
    <div>
      <p>{`current:${current.data === undefined ? 'loading' : (current.data?.status ?? 'none')}`}</p>
      <p>{`ended:${lastEnded?.status ?? 'none'}`}</p>
      <p>{`startError:${start.error === null ? 'none' : 'error'}`}</p>
      <button
        type="button"
        onClick={() => {
          start.mutate({ plannedSeconds: 900 }, { onSuccess: onResult });
          start.mutate({ plannedSeconds: 900 }, { onSuccess: onResult });
        }}
      >
        start twice
      </button>
      <button
        type="button"
        onClick={() => {
          if (current.data?.status === 'in_progress') {
            pause.mutate(current.data.id);
          }
        }}
      >
        pause
      </button>
      <button type="button" onClick={dismiss}>
        dismiss
      </button>
    </div>
  );
}

function renderProbe() {
  const queryClient = createTestQueryClient();
  const results: FocusSessionView[] = [];
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RealtimeProvider client={createStubRealtimeClient()}>
          <Probe onResult={(session) => results.push(session)} />
        </RealtimeProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { queryClient, results };
}

describe('focus queries', () => {
  it('is keyed under the user, so one invalidation reaches review data too', async () => {
    startFocusWorld();
    const { queryClient } = renderProbe();
    await screen.findByText('current:none');

    const keys = queryClient
      .getQueryCache()
      .findAll()
      .map((query) => query.queryKey);
    expect(keys).toContainEqual(focusCurrentKey(String(keys[0]?.[1])));
    expect(keys[0]?.slice(0, 2)).toEqual(['focus-sessions', keys[0]?.[1]]);
  });

  it('start called twice at once sends one request and both calls get the same session', async () => {
    const world = startFocusWorld();
    const { results } = renderProbe();
    await screen.findByText('current:none');

    fireEvent.click(screen.getByRole('button', { name: 'start twice' }));

    await screen.findByText('current:in_progress');
    await waitFor(() => {
      expect(results.length).toBeGreaterThan(0);
    });
    expect(focusWrites(world.calls)).toHaveLength(1);
    expect(world.focusApi.sessions).toHaveLength(1);
    expect(new Set(results.map((session) => session.id)).size).toBe(1);
  });

  it('adopts the existing session from a 409 instead of surfacing an error', async () => {
    const world = startFocusWorld();
    const { results } = renderProbe();
    await screen.findByText('current:none');
    const now = new Date().toISOString();
    const existing = fakeSession({
      status: 'in_progress',
      focusedSeconds: 0,
      startedAt: now,
      runningSince: now,
      task: null,
    });
    world.focusApi.sessions.unshift(existing);

    fireEvent.click(screen.getByRole('button', { name: 'start twice' }));

    await screen.findByText('current:in_progress');
    await waitFor(() => {
      expect(results[0]?.id).toBe(existing.id);
    });
    expect(screen.getByText('startError:none')).not.toBeNull();
    expect(world.focusApi.sessions).toHaveLength(1);
  });

  it('writes an ended answer as "no current session" and remembers it until dismissed', async () => {
    const world = startFocusWorld();
    const now = new Date().toISOString();
    world.focusApi.sessions.unshift(
      fakeSession({
        status: 'in_progress',
        focusedSeconds: 0,
        startedAt: now,
        runningSince: now,
        task: null,
      }),
    );
    renderProbe();
    await screen.findByText('current:in_progress');
    // The server ended it first; the pause answers 200 with the ended session (E11).
    world.focusApi.abandonCurrent('grace_expired');

    fireEvent.click(screen.getByRole('button', { name: 'pause' }));

    await screen.findByText('current:none');
    await screen.findByText('ended:abandoned');

    fireEvent.click(screen.getByRole('button', { name: 'dismiss' }));
    await screen.findByText('ended:none');
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText('current:none')).not.toBeNull();
  });
});
