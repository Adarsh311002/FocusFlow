import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakeSession } from '../../test/fake-focus-session-api';
import { renderFocusApp, startFocusWorld } from '../../test/focus-route';
import { resetPendingRefresh } from '../auth/auth-client';
import { clearAccessToken } from '../auth/token-store';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearAccessToken();
  resetPendingRefresh();
});

const ROOM_ID = '0192f8a0-3333-7aaa-8bbb-000000000003';

describe('the solo Focus panel and a room focus session', () => {
  it('shows a room session as managed by the room, with no solo controls', async () => {
    const world = startFocusWorld();
    world.focusApi.sessions.unshift(
      fakeSession({
        context: {
          kind: 'room',
          roomId: ROOM_ID,
          focusRunId: '0192f8a0-1111-7aaa-8bbb-000000000001',
        },
        status: 'in_progress',
        runningSince: null,
        plannedSeconds: 900,
        focusedSeconds: 0,
        startedAt: new Date().toISOString(),
        task: null,
      }),
    );
    renderFocusApp();

    expect(
      await screen.findByText(/You are in a room's focus run \(15 min planned\)/),
    ).not.toBeNull();
    expect(screen.getByRole('link', { name: 'Open the room' }).getAttribute('href')).toBe(
      `/rooms/${ROOM_ID}`,
    );
    // Pause and stop would be refused by the server (NOT_SOLO_SESSION): they are not offered.
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop session' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Start focus' })).toBeNull();
  });
});
