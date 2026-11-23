import { focusSessionUpdatedEventSchema } from '@focus-flow/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { errorResponse } from '../../test/api-stub';
import { type FakeSession, fakeSession } from '../../test/fake-focus-session-api';
import { currentReads, pathOf, renderFocusApp, startFocusWorld } from '../../test/focus-route';
import { resetPendingRefresh } from '../auth/auth-client';
import { clearAccessToken } from '../auth/token-store';
import type * as ReviewClient from '../review/review-client';

// The history lookups the panel makes, so a test can wait until one has really finished
// instead of guessing how long a held response takes to be delivered.
const lookups = vi.hoisted(() => [] as Promise<unknown>[]);
vi.mock('../review/review-client', async (importOriginal) => {
  const actual = await importOriginal<typeof ReviewClient>();
  return {
    ...actual,
    listFocusSessions: (...args: Parameters<typeof actual.listFocusSessions>) => {
      const lookup = actual.listFocusSessions(...args);
      lookups.push(lookup.catch(() => undefined));
      return lookup;
    },
  };
});

// What the Focus panel shows when the network or a read lets it down: a failed background
// read must not hide a session the page already knows, and a session the server ended while
// this tab was away is explained after the reconnect instead of silently disappearing.

afterEach(() => {
  lookups.length = 0;
  clearAccessToken();
  resetPendingRefresh();
});

function seedRunning(
  world: ReturnType<typeof startFocusWorld>,
  overrides: Partial<FakeSession> = {},
): FakeSession {
  const now = new Date().toISOString();
  const session = fakeSession({
    status: 'in_progress',
    plannedSeconds: 1_500,
    focusedSeconds: 0,
    startedAt: now,
    runningSince: now,
    task: null,
    ...overrides,
  });
  world.focusApi.sessions.unshift(session);
  return session;
}

const focusRegion = () => within(screen.getByRole('region', { name: 'Focus' }));
const reconnect = (realtime: { emitConnected: () => void }) => {
  act(() => {
    realtime.emitConnected();
  });
};
const historyReads = (world: ReturnType<typeof startFocusWorld>) =>
  world.calls.filter(
    (request) => request.method === 'GET' && pathOf(request) === '/focus-sessions',
  );
// TanStack Query hands its change notifications to React on a zero-delay timer, so a bare
// `setImmediate` can return before they do. A short timer first, then an immediate.
const flush = () =>
  act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  });
const failRead = () => errorResponse(503, 'INTERNAL', 'unavailable');

describe('a failed read of the current session', () => {
  it('keeps a known running session on screen, with a retry beside it', async () => {
    const world = startFocusWorld();
    seedRunning(world);
    const { realtime } = renderFocusApp();
    await screen.findByText('Running');

    world.focusApi.failNext('current', failRead);
    reconnect(realtime);

    const alert = await focusRegion().findByRole('alert');
    expect(alert.textContent).toMatch(/could not decide|could not reach|try again/i);
    // The session, its timer and its controls are all still there.
    expect(focusRegion().getByText('Running')).not.toBeNull();
    expect(focusRegion().getByRole('button', { name: 'Pause' })).not.toBeNull();
    expect(focusRegion().getByRole('button', { name: 'Stop session' })).not.toBeNull();
    expect(focusRegion().getByRole('button', { name: 'Retry' })).not.toBeNull();
    expect(focusRegion().queryByRole('button', { name: 'Start focus' })).toBeNull();

    // Retrying reads again; once the server answers, the notice goes and the session stays.
    fireEvent.click(focusRegion().getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(focusRegion().queryByRole('button', { name: 'Retry' })).toBeNull();
    });
    expect(focusRegion().getByText('Running')).not.toBeNull();
  });

  it('keeps a known paused session on screen too', async () => {
    const world = startFocusWorld();
    seedRunning(world, { runningSince: null });
    const { realtime } = renderFocusApp();
    await screen.findByText('Paused');

    world.focusApi.failNext('current', failRead);
    reconnect(realtime);

    await focusRegion().findByRole('alert');
    expect(focusRegion().getByText('Paused')).not.toBeNull();
    expect(focusRegion().getByRole('button', { name: 'Resume' })).not.toBeNull();
  });

  it('keeps the start form when the last answer was "no session"', async () => {
    const world = startFocusWorld();
    const { realtime } = renderFocusApp();
    await screen.findByRole('button', { name: 'Start focus' });

    world.focusApi.failNext('current', failRead);
    reconnect(realtime);

    await focusRegion().findByRole('alert');
    expect(focusRegion().getByRole('button', { name: 'Start focus' })).not.toBeNull();
  });

  it('shows only the error and a retry when nothing is known yet', async () => {
    const world = startFocusWorld();
    seedRunning(world);
    world.focusApi.failNext('current', failRead);
    renderFocusApp();

    await screen.findByRole('region', { name: 'Focus' });
    await focusRegion().findByRole('alert');
    expect(focusRegion().getByRole('button', { name: 'Retry' })).not.toBeNull();
    // No session to show, and no start form that could start a second one.
    expect(focusRegion().queryByText('Running')).toBeNull();
    expect(focusRegion().queryByRole('button', { name: 'Start focus' })).toBeNull();

    fireEvent.click(focusRegion().getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Running')).not.toBeNull();
  });
});

describe('after a reconnect', () => {
  it('explains a session the server abandoned while this tab was disconnected', async () => {
    const world = startFocusWorld();
    const running = seedRunning(world);
    const { realtime } = renderFocusApp();
    await screen.findByText('Running');

    // While away: the server gives up on the session; this tab hears nothing (no event).
    world.focusApi.abandonCurrent('grace_expired');
    // The first read after coming back fails; nothing may be concluded from that.
    world.focusApi.failNext('current', failRead);
    reconnect(realtime);
    await focusRegion().findByRole('alert');
    expect(focusRegion().getByText('Running')).not.toBeNull();
    expect(focusRegion().queryByText(/Ended because you disconnected/)).toBeNull();
    expect(historyReads(world)).toHaveLength(0);

    // The next read succeeds: no current session, so the previous one is looked up by id.
    reconnect(realtime);
    expect(await focusRegion().findByText(/Ended because you disconnected/)).not.toBeNull();
    expect(focusRegion().getByRole('button', { name: 'Start focus' })).not.toBeNull();
    expect(historyReads(world).length).toBeGreaterThan(0);
    expect(world.focusApi.sessions.find((session) => session.id === running.id)?.status).toBe(
      'abandoned',
    );
  });

  it('also explains a session that expired or completed in the meantime', async () => {
    const world = startFocusWorld();
    seedRunning(world);
    const { realtime } = renderFocusApp();
    await screen.findByText('Running');

    world.focusApi.completeCurrent();
    reconnect(realtime);

    expect(await focusRegion().findByText(/Completed: 25 min of focus recorded/)).not.toBeNull();
  });

  it('keeps a session that survived a short disconnect and invents no notice', async () => {
    const world = startFocusWorld();
    seedRunning(world);
    const { realtime } = renderFocusApp();
    await screen.findByText('Running');
    const reads = currentReads(world.calls).length;

    reconnect(realtime);
    await waitFor(() => {
      expect(currentReads(world.calls).length).toBeGreaterThan(reads);
    });
    await flush();

    expect(focusRegion().getByText('Running')).not.toBeNull();
    expect(focusRegion().queryByText(/Ended because|Stopped:|Completed:|Expired:/)).toBeNull();
    // Nothing ended, so there was nothing to look up.
    expect(historyReads(world)).toHaveLength(0);
  });

  it('does not take a history record of another session for the one that was running', async () => {
    const world = startFocusWorld();
    seedRunning(world);
    const { realtime } = renderFocusApp();
    await screen.findByText('Running');

    // The running session vanishes from the server's records altogether, and the newest
    // record belongs to a different session that was abandoned for the same reason.
    world.focusApi.sessions.length = 0;
    world.focusApi.sessions.push(
      fakeSession({
        status: 'abandoned',
        abandonReason: 'grace_expired',
        startedAt: '2026-03-09T10:00:00.000Z',
        endedAt: '2026-03-09T10:05:00.000Z',
        focusedSeconds: 300,
      }),
    );
    reconnect(realtime);

    await focusRegion().findByRole('button', { name: 'Start focus' });
    await waitFor(() => {
      expect(historyReads(world).length).toBeGreaterThan(0);
    });
    await flush();
    expect(focusRegion().queryByText(/Ended because you disconnected/)).toBeNull();
  });

  it('does not present an older session’s outcome when a newer one ended since', async () => {
    const world = startFocusWorld();
    seedRunning(world);
    const { realtime } = renderFocusApp();
    await screen.findByText('Running');

    // The tracked session was abandoned, and another one was started and stopped after it.
    world.focusApi.abandonCurrent('grace_expired');
    world.focusApi.sessions.unshift(
      fakeSession({
        status: 'abandoned',
        abandonReason: 'stopped',
        startedAt: new Date(Date.now() + 60_000).toISOString(),
        endedAt: new Date(Date.now() + 90_000).toISOString(),
        focusedSeconds: 30,
      }),
    );
    reconnect(realtime);

    await focusRegion().findByRole('button', { name: 'Start focus' });
    await waitFor(() => {
      expect(historyReads(world).length).toBeGreaterThan(0);
    });
    await flush();
    expect(focusRegion().queryByText(/Ended because|Stopped:|Completed:|Expired:/)).toBeNull();
  });

  it('shows the session started since, not the outcome of the one that ended', async () => {
    const world = startFocusWorld();
    seedRunning(world);
    const { realtime } = renderFocusApp();
    await screen.findByText('Running');

    world.focusApi.abandonCurrent('grace_expired');
    seedRunning(world, { plannedSeconds: 3_000 });
    reconnect(realtime);

    expect(await focusRegion().findByText(/of 50:00/)).not.toBeNull();
    await flush();
    expect(focusRegion().queryByText(/Ended because you disconnected/)).toBeNull();
    expect(historyReads(world)).toHaveLength(0);
  });

  it('invents no outcome when the history cannot be read', async () => {
    const world = startFocusWorld();
    seedRunning(world);
    const { realtime } = renderFocusApp();
    await screen.findByText('Running');

    world.focusApi.abandonCurrent('grace_expired');
    world.focusApi.failNext('history', failRead);
    reconnect(realtime);

    await focusRegion().findByRole('button', { name: 'Start focus' });
    await waitFor(() => {
      expect(historyReads(world).length).toBeGreaterThan(0);
    });
    await flush();
    expect(focusRegion().queryByText(/Ended because|Stopped:|Completed:|Expired:/)).toBeNull();
  });
});

describe('notices and retries around a reconnect', () => {
  const eventFor = (session: FakeSession) => focusSessionUpdatedEventSchema.parse({ session });

  it('does not bring back a notice the user dismissed while the history was still loading', async () => {
    const world = startFocusWorld();
    const running = seedRunning(world);
    const { realtime } = renderFocusApp();
    await screen.findByText('Running');

    world.focusApi.abandonCurrent('grace_expired');
    // The reconnect read finds no session and starts the history lookup, which is held.
    const releaseHistory = world.hold(
      (request) => request.method === 'GET' && pathOf(request) === '/focus-sessions',
    );
    reconnect(realtime);
    await waitFor(() => {
      expect(historyReads(world).length).toBeGreaterThan(0);
    });

    // Meanwhile the terminal event arrives, shows the notice, and the user dismisses it.
    const ended = world.focusApi.sessions.find((session) => session.id === running.id);
    if (ended === undefined) {
      throw new Error('the abandoned session should exist');
    }
    act(() => {
      realtime.emitFocusSessionUpdated(eventFor(ended));
    });
    await focusRegion().findByText(/Ended because you disconnected/);
    fireEvent.click(focusRegion().getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => {
      expect(focusRegion().queryByText(/Ended because you disconnected/)).toBeNull();
    });

    // The slow lookup finishes afterwards: the dismissed notice stays gone.
    // The lookup was really observed, so waiting for it below cannot pass by waiting for nothing.
    expect(lookups.length).toBeGreaterThan(0);
    releaseHistory();
    await act(async () => {
      await Promise.all(lookups);
    });
    await flush();
    expect(focusRegion().queryByText(/Ended because you disconnected/)).toBeNull();
  });

  it('does not leave an earlier session’s notice standing in for a later session’s outcome', async () => {
    const world = startFocusWorld();
    seedRunning(world);
    const { realtime } = renderFocusApp();
    await screen.findByText('Running');

    // The first session completes and its notice is shown (not dismissed).
    const first = world.focusApi.completeCurrent();
    act(() => {
      realtime.emitFocusSessionUpdated(eventFor(first));
    });
    await focusRegion().findByText(/Completed: 25 min of focus recorded/);

    // A second session starts and runs; the first notice goes with it.
    seedRunning(world, { plannedSeconds: 3_000 });
    reconnect(realtime);
    await focusRegion().findByText(/of 50:00/);

    // The second one is abandoned while away and the history cannot be read.
    world.focusApi.abandonCurrent('grace_expired');
    world.focusApi.failNext('history', failRead);
    reconnect(realtime);
    await focusRegion().findByRole('button', { name: 'Start focus' });
    await waitFor(() => {
      expect(historyReads(world).length).toBeGreaterThan(0);
    });
    await flush();

    // No notice at all: the first session's must not read as the second one's result.
    expect(focusRegion().queryByText(/Ended because|Stopped:|Completed:|Expired:/)).toBeNull();
  });

  it('tries the history again on the next read when the first attempt failed', async () => {
    const world = startFocusWorld();
    seedRunning(world);
    const { realtime } = renderFocusApp();
    await screen.findByText('Running');

    world.focusApi.abandonCurrent('grace_expired');
    world.focusApi.failNext('history', failRead);
    reconnect(realtime);
    await focusRegion().findByRole('button', { name: 'Start focus' });
    await waitFor(() => {
      expect(historyReads(world)).toHaveLength(1);
    });
    await flush();
    expect(focusRegion().queryByText(/Ended because you disconnected/)).toBeNull();

    // The connection comes back again; this time the lookup works.
    reconnect(realtime);
    expect(await focusRegion().findByText(/Ended because you disconnected/)).not.toBeNull();
    expect(historyReads(world)).toHaveLength(2);
  });

  it('keeps the Retry button focusable while the read is running again', async () => {
    const world = startFocusWorld();
    seedRunning(world);
    const { realtime } = renderFocusApp();
    await screen.findByText('Running');

    world.focusApi.failNext('current', failRead);
    reconnect(realtime);
    const retry = await focusRegion().findByRole<HTMLButtonElement>('button', { name: 'Retry' });
    retry.focus();

    const release = world.hold(
      (request) => request.method === 'GET' && pathOf(request) === '/focus-sessions/current',
    );
    fireEvent.click(retry);
    await waitFor(() => {
      expect(retry.getAttribute('aria-disabled')).toBe('true');
    });
    // A disabled button would have dropped keyboard focus here.
    expect(retry.disabled).toBe(false);
    expect(document.activeElement).toBe(retry);
    release();
    await flush();
  });
});
