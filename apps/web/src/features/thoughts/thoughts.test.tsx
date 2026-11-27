import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as TimeSync from '../../lib/time-sync';
import { clock } from '../../lib/time-sync';
import { fakeSession } from '../../test/fake-focus-session-api';
import { pathOf, renderFocusApp, startFocusWorld } from '../../test/focus-route';
import { resetPendingRefresh } from '../auth/auth-client';
import { clearAccessToken } from '../auth/token-store';

// Parked thoughts on the dashboard (PT5): park during a session, decide after it.

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

async function running() {
  const world = startFocusWorld();
  const now = Date.now();
  const session = fakeSession({
    status: 'in_progress',
    startedAt: new Date(now - 60_000).toISOString(),
    runningSince: new Date(now - 60_000).toISOString(),
    focusedSeconds: 0,
    task: null,
  });
  world.focusApi.sessions.unshift(session);
  renderFocusApp();
  await screen.findByText('Running');
  return { world, session };
}

const parkField = () => screen.getByLabelText('Something pulling at you? Park it and keep going.');

describe('parked thoughts', () => {
  it('parks a thought during a session without leaving it, linked to the session', async () => {
    const { world, session } = await running();

    fireEvent.change(parkField(), { target: { value: '  Email Ravi  ' } });
    fireEvent.submit(parkField());

    expect(await screen.findByText('1 parked for after this session.')).not.toBeNull();
    expect(screen.getByText('Running')).not.toBeNull();
    const posted = world.calls.find(
      (call) => call.method === 'POST' && pathOf(call) === '/parked-thoughts',
    );
    expect(posted?.body).toBe(JSON.stringify({ body: 'Email Ravi', sessionId: session.id }));
    expect((parkField() as HTMLInputElement).value).toBe('');
  });

  it('lists the session’s thoughts when it ends: one becomes a task, one is let go', async () => {
    const { world } = await running();
    for (const body of ['Email Ravi', 'Buy coffee']) {
      fireEvent.change(parkField(), { target: { value: body } });
      fireEvent.submit(parkField());
      await screen.findByText(new RegExp(`${String(body === 'Email Ravi' ? 1 : 2)} parked`));
    }
    fireEvent.click(screen.getByRole('button', { name: 'Stop session' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm stop' }));

    const list = await screen.findByRole('list', { name: 'Parked during this session (2)' });
    const ravi = within(list).getByText('Email Ravi').closest('li');
    if (ravi === null) {
      throw new Error('no row for the thought');
    }
    fireEvent.click(within(ravi).getByRole('button', { name: 'Make it a task' }));
    await waitFor(() => {
      expect(world.taskApi.tasks.map((task) => task.title)).toEqual(['Email Ravi']);
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Let “Buy coffee” go' }));
    await waitFor(() => {
      expect(screen.queryByRole('list', { name: /Parked during this session/ })).toBeNull();
    });
    expect(world.taskApi.thoughts).toEqual([]);
  });
});
