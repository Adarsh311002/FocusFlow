import {
  type FocusSessionUpdatedEvent,
  focusSessionUpdatedEventSchema,
} from '@focus-flow/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { userBody } from '../../test/api-stub';
import { type FakeSession, fakeSession } from '../../test/fake-focus-session-api';
import {
  currentReads,
  focusWrites,
  pathOf,
  renderFocusApp,
  startFocusWorld,
} from '../../test/focus-route';
import { resetPendingRefresh } from '../auth/auth-client';
import { clearAccessToken } from '../auth/token-store';
import { createRealtimeClient, type RealtimeSocket } from '../realtime/realtime-client';
import { focusCurrentKey } from './focus-queries';

afterEach(() => {
  vi.unstubAllGlobals();
  clearAccessToken();
  resetPendingRefresh();
});

/** The payload as the real client delivers it: validated, so the ids are branded. */
const eventFor = (session: FakeSession): FocusSessionUpdatedEvent =>
  focusSessionUpdatedEventSchema.parse({ session });

function seedRunning(
  world: ReturnType<typeof startFocusWorld>,
  overrides: Partial<FakeSession> = {},
) {
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
const emit = (
  realtime: { emitFocusSessionUpdated: (event: FocusSessionUpdatedEvent) => void },
  e: FocusSessionUpdatedEvent,
) => {
  act(() => {
    realtime.emitFocusSessionUpdated(e);
  });
};

describe('server-driven outcomes', () => {
  it('shows a completion from the server after a completed event refetches /current', async () => {
    const world = startFocusWorld();
    seedRunning(world);
    const { realtime } = renderFocusApp();
    await screen.findByText('Running');
    const reads = currentReads(world.calls).length;

    const completed = world.focusApi.completeCurrent();
    emit(realtime, eventFor(completed));

    expect(await screen.findByText(/Completed: 25 min of focus recorded/)).not.toBeNull();
    expect(currentReads(world.calls).length).toBeGreaterThan(reads);
    expect(screen.getByRole('button', { name: 'Start focus' })).not.toBeNull();
    expect(focusRegion().queryByText('Running')).toBeNull();
  });

  it('shows grace_expired as an abandonment, not a completion', async () => {
    const world = startFocusWorld();
    seedRunning(world, { focusedSeconds: 120 });
    const { realtime } = renderFocusApp();
    await screen.findByText('Running');

    emit(realtime, eventFor(world.focusApi.abandonCurrent('grace_expired')));

    expect(
      await screen.findByText(/Ended because you disconnected: \d+ min recorded/),
    ).not.toBeNull();
    expect(focusRegion().queryByText(/Completed:/)).toBeNull();
  });

  it('shows an expired session as expired', async () => {
    const world = startFocusWorld();
    seedRunning(world);
    const { realtime } = renderFocusApp();
    await screen.findByText('Running');

    emit(realtime, eventFor(world.focusApi.abandonCurrent('expired')));

    expect(await screen.findByText(/Expired: the session was not finished in time/)).not.toBeNull();
  });

  it('can dismiss the notice, which stays dismissed', async () => {
    const world = startFocusWorld();
    seedRunning(world);
    const { realtime } = renderFocusApp();
    await screen.findByText('Running');
    emit(realtime, eventFor(world.focusApi.completeCurrent()));
    await screen.findByText(/Completed:/);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    await waitFor(() => {
      expect(focusRegion().queryByText(/Completed:/)).toBeNull();
    });
  });

  it('does not apply an in_progress payload; only the refetch decides', async () => {
    const world = startFocusWorld();
    const running = seedRunning(world);
    const { realtime } = renderFocusApp();
    await screen.findByText('Running');
    // The next read of /current is held, so any change before it resolves came from the payload.
    const release = world.hold(
      (request) => request.method === 'GET' && pathOf(request) === '/focus-sessions/current',
    );

    emit(
      realtime,
      eventFor({ ...running, runningSince: null, focusedSeconds: 999 } as FakeSession),
    );

    expect(screen.getByText('Running')).not.toBeNull();
    expect(screen.queryByText('Paused')).toBeNull();
    release();
    await waitFor(() => {
      expect(currentReads(world.calls).length).toBeGreaterThan(1);
    });
    // The server's own state (still running, nothing focused) is what remains.
    expect(screen.getByText('Running')).not.toBeNull();
  });

  it('remembers a terminal payload only as the last ended; a refetch still decides the timer', async () => {
    const world = startFocusWorld();
    const running = seedRunning(world);
    const { realtime } = renderFocusApp();
    await screen.findByText('Running');

    // A late event about a session the server no longer lists as current... but the server
    // still reports this one running: the timer must keep showing it.
    emit(
      realtime,
      eventFor({
        ...running,
        status: 'completed',
        focusedSeconds: running.plannedSeconds,
        endedAt: new Date().toISOString(),
      }),
    );
    await waitFor(() => {
      expect(currentReads(world.calls).length).toBeGreaterThan(1);
    });
    expect(screen.getByText('Running')).not.toBeNull();

    // Once the server agrees, the remembered notice is what the user sees.
    world.focusApi.completeCurrent();
    emit(realtime, eventFor(world.focusApi.sessions[0] as FakeSession));
    expect(await screen.findByText(/Completed:/)).not.toBeNull();
  });

  it('survives duplicate and late events: the final state is the refetch result', async () => {
    const world = startFocusWorld();
    seedRunning(world);
    const { realtime } = renderFocusApp();
    await screen.findByText('Running');
    const completed = world.focusApi.completeCurrent();

    emit(realtime, eventFor(completed));
    emit(realtime, eventFor(completed));
    await screen.findByText(/Completed:/);
    // A late event for the same, already-finished session.
    emit(realtime, eventFor(completed));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Start focus' })).not.toBeNull();
    });

    expect(screen.queryByRole('alert')).toBeNull();
    expect(focusRegion().queryByText('Running')).toBeNull();
    expect(focusRegion().getAllByText(/Completed:/)).toHaveLength(1);
  });

  it('a late event about an older session does not hide a newer one that is running', async () => {
    const world = startFocusWorld();
    const old = fakeSession({
      startedAt: '2026-03-09T08:00:00.000Z',
      endedAt: '2026-03-09T08:25:00.000Z',
    });
    world.focusApi.sessions.push(old);
    seedRunning(world);
    const { realtime } = renderFocusApp();
    await screen.findByText('Running');

    emit(realtime, eventFor(old));

    await waitFor(() => {
      expect(currentReads(world.calls).length).toBeGreaterThan(1);
    });
    expect(screen.getByText('Running')).not.toBeNull();
    expect(focusRegion().queryByText(/Completed:/)).toBeNull();
  });
});

describe('out-of-order answers', () => {
  it('a slow pause answer after the server completed the session cannot resurrect it', async () => {
    const world = startFocusWorld();
    seedRunning(world);
    const { realtime } = renderFocusApp();
    await screen.findByText('Running');
    // The pause is computed while the session is running and delivered late.
    const release = world.hold((request) => request.url.endsWith('/pause'));
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await screen.findByRole('button', { name: 'Pausing…' });

    // Meanwhile the server completes it; the event and the refetch show it as ended.
    const completed = world.focusApi.completeCurrent();
    emit(realtime, eventFor(completed));
    await screen.findByText(/Completed:/);

    release();
    await waitFor(() => {
      expect(focusWrites(world.calls)).toHaveLength(1);
    });
    // Let the late answer and the refetch it triggers land.
    await act(async () => {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    });

    expect(focusRegion().queryByText('Paused')).toBeNull();
    expect(focusRegion().queryByText('Running')).toBeNull();
    expect(screen.getByRole('button', { name: 'Start focus' })).not.toBeNull();
    expect(focusRegion().getByText(/Completed:/)).not.toBeNull();
  });

  it('a refetch in flight when a mutation resolves does not overwrite the fresher result', async () => {
    const world = startFocusWorld();
    seedRunning(world);
    const { realtime } = renderFocusApp();
    await screen.findByText('Running');
    // An event starts a refetch that reads the running state and is held.
    const releaseRead = world.hold(
      (request) => request.method === 'GET' && pathOf(request) === '/focus-sessions/current',
    );
    emit(realtime, eventFor(world.focusApi.sessions[0] as FakeSession));
    await waitFor(() => {
      expect(currentReads(world.calls).length).toBeGreaterThan(1);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await screen.findByText('Paused');
    releaseRead(); // The stale "running" answer arrives after the pause was applied.
    await act(async () => {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    });

    expect(screen.getByText('Paused')).not.toBeNull();
    expect(screen.queryByText('Running')).toBeNull();
  });
});

/** Lets answers that were just released, and the refetches they trigger, land. */
const flush = () =>
  act(async () => {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  });

describe('lifecycle answers that arrive late', () => {
  it('a slow pause answer cannot resurrect a session that only a refetch saw ending', async () => {
    const world = startFocusWorld();
    seedRunning(world);
    const { realtime } = renderFocusApp();
    await screen.findByText('Running');
    const release = world.hold((request) => request.url.endsWith('/pause'));
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await screen.findByRole('button', { name: 'Pausing…' });

    // The server completes it and this tab only finds out by reading again (a reconnect):
    // no event payload was seen, so nothing remembers the session as ended.
    world.focusApi.completeCurrent();
    act(() => {
      realtime.emitConnected();
    });
    await screen.findByRole('button', { name: 'Start focus' });

    // Hold the refetch the late answer triggers, so the answer's own effect is visible.
    const releaseRead = world.hold(
      (request) => request.method === 'GET' && pathOf(request) === '/focus-sessions/current',
    );
    release();
    await flush();

    expect(screen.queryByText('Paused')).toBeNull();
    expect(screen.getByRole('button', { name: 'Start focus' })).not.toBeNull();
    releaseRead();
    await flush();
    expect(screen.getByRole('button', { name: 'Start focus' })).not.toBeNull();
  });

  it('a late stop answer for an old session does not hide the session started since', async () => {
    const world = startFocusWorld();
    seedRunning(world);
    const { realtime } = renderFocusApp();
    await screen.findByText('Running');
    const releaseStop = world.hold((request) => request.url.endsWith('/stop'));
    fireEvent.click(screen.getByRole('button', { name: 'Stop session' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm stop' }));
    await screen.findByRole('button', { name: 'Stopping…' });

    // The old session is over on the server; a newer one was started (another tab).
    seedRunning(world, { plannedSeconds: 3_000 });
    act(() => {
      realtime.emitConnected();
    });
    await screen.findByText(/of 50:00/);

    // The late answer for the OLD session lands while the refetch it triggers is held.
    const releaseRead = world.hold(
      (request) => request.method === 'GET' && pathOf(request) === '/focus-sessions/current',
    );
    const readsBefore = currentReads(world.calls).length;
    releaseStop();
    // The answer has been applied once it asks the server again (the held read).
    await waitFor(() => {
      expect(currentReads(world.calls).length).toBeGreaterThan(readsBefore);
    });
    await flush();

    expect(screen.getByText(/of 50:00/)).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Start focus' })).toBeNull();
    releaseRead();
    await flush();
    expect(screen.getByText(/of 50:00/)).not.toBeNull();
  });

  it('a late pause answer for an old session does not replace the session started since', async () => {
    const world = startFocusWorld();
    const old = seedRunning(world);
    const { realtime } = renderFocusApp();
    await screen.findByText('Running');
    const releasePause = world.hold((request) => request.url.endsWith('/pause'));
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await screen.findByRole('button', { name: 'Pausing…' });

    // The old session ends elsewhere and another one starts; this tab reads the new one.
    world.focusApi.sessions[world.focusApi.sessions.indexOf(old)] = {
      ...old,
      status: 'abandoned',
      endedAt: new Date().toISOString(),
      abandonReason: 'expired',
    };
    seedRunning(world, { plannedSeconds: 3_000 });
    act(() => {
      realtime.emitConnected();
    });
    await screen.findByText(/of 50:00/);

    const releaseRead = world.hold(
      (request) => request.method === 'GET' && pathOf(request) === '/focus-sessions/current',
    );
    const readsBefore = currentReads(world.calls).length;
    releasePause();
    await waitFor(() => {
      expect(currentReads(world.calls).length).toBeGreaterThan(readsBefore);
    });
    await flush();

    // Still the new session, running: the old session's paused view was not written over it.
    expect(screen.getByText(/of 50:00/)).not.toBeNull();
    expect(screen.getByText('Running')).not.toBeNull();
    expect(screen.queryByText('Paused')).toBeNull();
    releaseRead();
    await flush();
  });

  it('an event is not swallowed by a read that was already in flight before the change', async () => {
    const world = startFocusWorld();
    seedRunning(world);
    const { realtime } = renderFocusApp();
    await screen.findByText('Running');
    // A read is under way and the server answered it before the session completed.
    const releaseStale = world.hold(
      (request) => request.method === 'GET' && pathOf(request) === '/focus-sessions/current',
    );
    act(() => {
      realtime.emitConnected();
    });
    await waitFor(() => {
      expect(currentReads(world.calls).length).toBeGreaterThan(1);
    });

    // Then it completes, and the event announcing it arrives while that read is still out.
    const completed = world.focusApi.completeCurrent();
    emit(realtime, eventFor(completed));
    releaseStale();
    await flush();

    // The event's refresh must not have been merged into the stale read.
    expect(await screen.findByRole('button', { name: 'Start focus' })).not.toBeNull();
    expect(screen.queryByText('Running')).toBeNull();
  });
});

describe('a change announced while the first read is still loading', () => {
  it('is read again, not served from the read that predates it', async () => {
    const world = startFocusWorld();
    seedRunning(world);
    // The very first read of the session is under way; the server answered it "running".
    const releaseFirst = world.hold(
      (request) => request.method === 'GET' && pathOf(request) === '/focus-sessions/current',
    );
    const { realtime } = renderFocusApp();
    await waitFor(() => {
      expect(currentReads(world.calls)).toHaveLength(1);
    });

    // The session completes and the event arrives before that first read has returned.
    const completed = world.focusApi.completeCurrent();
    emit(realtime, eventFor(completed));
    releaseFirst();
    await flush();

    expect(await screen.findByRole('button', { name: 'Start focus' })).not.toBeNull();
    expect(screen.queryByText('Running')).toBeNull();
  });
});

describe('subscriptions', () => {
  it('subscribes exactly once under StrictMode and unsubscribes on unmount', async () => {
    const world = startFocusWorld();
    const { realtime, unmount } = renderFocusApp({ strict: true });
    await screen.findByRole('button', { name: 'Start focus' });
    expect(realtime.focusListenerCount()).toBe(1);

    // A single event causes a single refresh of the one active /current query.
    const reads = currentReads(world.calls).length;
    emit(realtime, eventFor(fakeSession()));
    await waitFor(() => {
      expect(currentReads(world.calls).length).toBeGreaterThan(reads);
    });
    expect(currentReads(world.calls).length - reads).toBe(1);

    unmount();
    expect(realtime.focusListenerCount()).toBe(0);
    const after = currentReads(world.calls).length;
    act(() => {
      realtime.emitConnected();
      realtime.emitFocusSessionUpdated(eventFor(fakeSession()));
    });
    expect(currentReads(world.calls)).toHaveLength(after);
  });

  it('refetches on every connect, and not for events after sign-out', async () => {
    const world = startFocusWorld();
    const { realtime } = renderFocusApp();
    await screen.findByRole('button', { name: 'Start focus' });

    const before = currentReads(world.calls).length;
    act(() => {
      realtime.emitConnected();
    });
    await waitFor(() => {
      expect(currentReads(world.calls).length).toBe(before + 1);
    });
    act(() => {
      realtime.emitConnected();
    });
    await waitFor(() => {
      expect(currentReads(world.calls).length).toBe(before + 2);
    });
  });

  it('removes the listener on sign-out; events for user A never touch user B after sign-in', async () => {
    const world = startFocusWorld();
    const { realtime, queryClient } = renderFocusApp();
    await screen.findByRole('button', { name: 'Start focus' });
    const userA = userBody.id;
    const userB = '9b2d7c1e-3a4f-4c5d-8e6f-0a1b2c3d4e5f';
    expect(realtime.focusListenerCount()).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Test sign out' }));
    await screen.findByText('Login placeholder');
    expect(realtime.focusListenerCount()).toBe(0);
    // Signing out clears everything cached for user A.
    expect(queryClient.getQueryData(focusCurrentKey(userA))).toBeUndefined();

    fireEvent.click(screen.getByRole('button', { name: 'Test sign in as another user' }));
    await waitFor(() => {
      expect(realtime.focusListenerCount()).toBe(1);
    });
    // Data cached for each user; an event is handled for the signed-in user B only.
    queryClient.setQueryData(focusCurrentKey(userA), null);
    queryClient.setQueryData(focusCurrentKey(userB), null);
    act(() => {
      realtime.emitFocusSessionUpdated(eventFor(fakeSession()));
    });

    expect(queryClient.getQueryState(focusCurrentKey(userB))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(focusCurrentKey(userA))?.isInvalidated).toBe(false);
    expect(world.focusApi.sessions).toHaveLength(0);
  });
});

/** A socket the test drives by hand: the real realtime client sits on top of it. */
function createFakeSocket() {
  let onConnect: () => void = () => undefined;
  let onFocus: (payload: unknown) => void = () => undefined;
  let connected = false;
  const socket: RealtimeSocket = {
    get connected() {
      return connected;
    },
    active: false,
    connect: () => undefined,
    disconnect: () => {
      connected = false;
    },
    onConnect: (listener) => {
      onConnect = listener;
    },
    onDisconnect: () => undefined,
    onConnectError: () => undefined,
    onFocusSessionUpdated: (listener) => {
      onFocus = listener;
    },
    timeSync: () => Promise.reject(new Error('no clock in this test')),
  };
  return {
    socket,
    fireConnect: () => {
      connected = true;
      act(() => {
        onConnect();
      });
    },
    fireFocus: (payload: unknown) => {
      act(() => {
        onFocus(payload);
      });
    },
  };
}

describe('with the real realtime client', () => {
  function start() {
    const world = startFocusWorld();
    const fake = createFakeSocket();
    const client = createRealtimeClient({
      createSocket: () => fake.socket,
      getToken: () => 'token',
      syncSamples: 0,
    });
    renderFocusApp({ client });
    return { world, fake };
  }

  it('refetches on the first connect too, and on every reconnect', async () => {
    const { world, fake } = start();
    await screen.findByRole('button', { name: 'Start focus' });
    const loaded = currentReads(world.calls).length;

    fake.fireConnect();
    await waitFor(() => {
      expect(currentReads(world.calls).length).toBe(loaded + 1);
    });
    fake.fireConnect();
    await waitFor(() => {
      expect(currentReads(world.calls).length).toBe(loaded + 2);
    });
  });

  it('ignores a malformed event payload entirely', async () => {
    const { world, fake } = start();
    await screen.findByRole('button', { name: 'Start focus' });
    const loaded = currentReads(world.calls).length;

    fake.fireFocus({ session: { id: 'not-a-session' } });
    fake.fireFocus(null);
    fake.fireFocus('nope');
    await act(async () => {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    });

    expect(currentReads(world.calls)).toHaveLength(loaded);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a valid event through the real client refetches and shows the server state', async () => {
    const { world, fake } = start();
    await screen.findByRole('button', { name: 'Start focus' });
    seedRunning(world);

    fake.fireFocus({ session: world.focusApi.sessions[0] });

    expect(await screen.findByText('Running')).not.toBeNull();
  });
});

describe('review data after a session update', () => {
  it('refreshes the history and the summary of a mounted Review page', async () => {
    const world = startFocusWorld();
    world.focusApi.deriveSummary();
    const { realtime } = renderFocusApp({ initialPath: '/review' });
    expect(await screen.findByText('No focus sessions yet.')).not.toBeNull();
    const isList = (path: string) => path === '/focus-sessions';
    const count = (predicate: (path: string) => boolean) =>
      world.calls.filter((call) => call.method === 'GET' && predicate(pathOf(call))).length;
    const lists = count(isList);
    const summaries = count((path) => path === '/focus-sessions/summary');

    const ended = fakeSession({
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    });
    world.focusApi.sessions.unshift(ended);
    emit(realtime, eventFor(ended));

    await waitFor(() => {
      expect(count(isList)).toBeGreaterThan(lists);
      expect(count((path) => path === '/focus-sessions/summary')).toBeGreaterThan(summaries);
    });
    expect(await screen.findByText(ended.task?.title ?? '')).not.toBeNull();
  });
});
