import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

import type * as TimeSync from '../../lib/time-sync';
import { clock } from '../../lib/time-sync';
import { fakeSession } from '../../test/fake-focus-session-api';
import { pathOf, renderFocusApp, startFocusWorld } from '../../test/focus-route';
import { resetPendingRefresh } from '../auth/auth-client';
import { clearAccessToken } from '../auth/token-store';

// The session check-in (CI6): after a session ends, the panel asks how it went.

vi.mock('../../lib/time-sync', async (importOriginal) => {
  const actual = await importOriginal<typeof TimeSync>();
  return { ...actual, clock: actual.createClock(() => Date.now()) };
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearAccessToken();
  resetPendingRefresh();
  clock.reset();
});

/** A running session with a task, then stopped through the panel. */
async function stoppedWithTask(title = 'Draft the intro') {
  const world = startFocusWorld();
  const task = world.taskApi.addTask(title);
  const now = Date.now();
  const session = fakeSession({
    status: 'in_progress',
    plannedSeconds: 1_500,
    focusedSeconds: 0,
    startedAt: new Date(now - 60_000).toISOString(),
    runningSince: new Date(now - 60_000).toISOString(),
    task: { id: task.id, title, deleted: false },
  });
  world.focusApi.sessions.unshift(session);
  renderFocusApp();
  await screen.findByText('Running');
  fireEvent.click(screen.getByRole('button', { name: 'Stop session' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm stop' }));
  await screen.findByText(/Stopped: \d+ min recorded/);
  return { world, session, task };
}

const checkIns = (world: ReturnType<typeof startFocusWorld>) =>
  world.calls.filter((call) => call.method === 'PUT' && pathOf(call).endsWith('/check-in'));

describe('the session check-in', () => {
  it('asks whether the intention was finished and records "Done" with a note', async () => {
    const { world, session } = await stoppedWithTask();

    expect(
      screen.getByRole('group', { name: /Did you finish “Draft the intro”\?/ }),
    ).not.toBeNull();
    fireEvent.change(screen.getByLabelText('A note for later (optional)'), {
      target: { value: 'Shipped the outline' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(await screen.findByText('You said:')).not.toBeNull();
    expect(screen.getByText(/Shipped the outline/)).not.toBeNull();
    const [sent] = checkIns(world);
    expect(sent === undefined ? null : pathOf(sent)).toBe(`/focus-sessions/${session.id}/check-in`);
    expect(sent?.body).toBe('{"outcome":"done","note":"Shipped the outline"}');
  });

  it('lets the answer be changed later', async () => {
    const { world } = await stoppedWithTask();
    fireEvent.click(screen.getByRole('button', { name: 'Made progress' }));
    await screen.findByText('You said:');

    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Done' }));

    await waitFor(() => {
      expect(checkIns(world).map((call) => call.body)).toEqual([
        '{"outcome":"progress","note":""}',
        '{"outcome":"done","note":""}',
      ]);
    });
  });

  it('offers a smaller next step after "Got stuck", which becomes the current task', async () => {
    const { world } = await stoppedWithTask();
    fireEvent.click(screen.getByRole('button', { name: 'Got stuck' }));

    const step = await screen.findByLabelText('What is one smaller next step?');
    fireEvent.change(step, { target: { value: 'Outline only the first section' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make it my next step' }));

    expect(await screen.findByText(/It is your current task now/)).not.toBeNull();
    const writes = world.calls.filter((call) => call.method !== 'GET');
    expect(
      writes.some(
        (call) =>
          call.method === 'POST' &&
          pathOf(call) === '/tasks' &&
          call.body === '{"title":"Outline only the first section"}',
      ),
    ).toBe(true);
    expect(writes.some((call) => pathOf(call) === '/me/current-task')).toBe(true);
  });

  it('asks "How did it go?" when the session had no intention', async () => {
    const world = startFocusWorld();
    const now = Date.now();
    world.focusApi.sessions.unshift(
      fakeSession({
        status: 'in_progress',
        startedAt: new Date(now - 60_000).toISOString(),
        runningSince: new Date(now - 60_000).toISOString(),
        focusedSeconds: 0,
        task: null,
      }),
    );
    renderFocusApp();
    await screen.findByText('Running');
    fireEvent.click(screen.getByRole('button', { name: 'Stop session' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm stop' }));

    expect(await screen.findByRole('group', { name: 'How did it go?' })).not.toBeNull();
  });
});
