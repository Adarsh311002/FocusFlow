import { focusSessionUpdatedEventSchema } from '@focus-flow/contracts';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { focusWrites, renderFocusApp, startFocusWorld } from '../../test/focus-route';
import { resetPendingRefresh } from '../auth/auth-client';
import { clearAccessToken } from '../auth/token-store';

afterEach(() => {
  vi.unstubAllGlobals();
  clearAccessToken();
  resetPendingRefresh();
});

const nav = () => within(screen.getByRole('navigation', { name: 'Main' }));

/** The summary's three figures by their labels. */
async function summary() {
  const region = await screen.findByRole('region', { name: 'Last 7 days' });
  const figure = (label: string): string | null | undefined =>
    within(region).getByText(label).parentElement?.querySelector('dd')?.textContent;
  return {
    completedCount: figure('Completed sessions'),
    completedTime: figure('Completed focus time'),
    totalTime: figure('Total focus time (incl. stopped and abandoned)'),
  };
}

describe('focus to review journey', () => {
  it('a stopped session is in history and in the total only; a completed one counts in both', async () => {
    // Server time is driven by hand so the focused seconds are exact.
    let nowMs = Date.now();
    const world = startFocusWorld({ now: () => nowMs });
    world.focusApi.deriveSummary();
    const { realtime } = renderFocusApp();

    // The first render of the whole app is the slowest step of a loaded run: allow for it.
    fireEvent.click(await screen.findByRole('button', { name: 'Start focus' }, { timeout: 4_000 }));
    await screen.findByText('Running');
    nowMs += 600_000;
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await screen.findByText('Paused');
    nowMs += 1_000_000;
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await screen.findByText('Running');
    nowMs += 300_000;
    fireEvent.click(screen.getByRole('button', { name: 'Stop session' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm stop' }));
    expect(await screen.findByText(/Stopped: 15 min recorded/)).not.toBeNull();
    expect(
      focusWrites(world.calls).map((call) => call.url.replace(/[0-9a-f-]{36}/, ':id')),
    ).toEqual([
      '/api/v1/focus-sessions',
      '/api/v1/focus-sessions/:id/pause',
      '/api/v1/focus-sessions/:id/resume',
      '/api/v1/focus-sessions/:id/stop',
    ]);

    // Review: the stopped session is history, counted in total focus time but not completed.
    fireEvent.click(nav().getByRole('link', { name: 'Review' }));
    const item = await screen.findByRole('listitem', { name: 'No task, Stopped early' });
    expect(within(item).getByText('Focused 15 min of 25 min planned')).not.toBeNull();
    const afterStop = await summary();
    expect(afterStop.completedCount).toBe('0');
    expect(afterStop.completedTime).toBe('0 min');
    expect(afterStop.totalTime).toBe('15 min');

    // Back to the dashboard: a second session that the server completes (the worker).
    fireEvent.click(nav().getByRole('link', { name: 'Dashboard' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start focus' }));
    await screen.findByText('Running');
    nowMs += 1_500_000;
    const completed = world.focusApi.completeCurrent();
    act(() => {
      realtime.emitFocusSessionUpdated(
        focusSessionUpdatedEventSchema.parse({ session: completed }),
      );
    });
    expect(await screen.findByText(/Completed: 25 min of focus recorded/)).not.toBeNull();

    fireEvent.click(nav().getByRole('link', { name: 'Review' }));
    expect(await screen.findByRole('listitem', { name: 'No task, Completed' })).not.toBeNull();
    expect(screen.getByRole('listitem', { name: 'No task, Stopped early' })).not.toBeNull();
    await screen.findByRole('region', { name: 'Last 7 days' });
    await vi.waitFor(async () => {
      const totals = await summary();
      expect(totals.completedCount).toBe('1');
      expect(totals.completedTime).toBe('25 min');
      expect(totals.totalTime).toBe('40 min');
    });
    // A two-page journey through the whole app: slow when the machine is busy.
  }, 20_000);

  it('keeps an in-progress session out of the summary totals', async () => {
    const nowMs = Date.now();
    const world = startFocusWorld({ now: () => nowMs });
    world.focusApi.deriveSummary();
    renderFocusApp();
    fireEvent.click(await screen.findByRole('button', { name: 'Start focus' }));
    await screen.findByText('Running');

    fireEvent.click(nav().getByRole('link', { name: 'Review' }));

    expect(await screen.findByRole('listitem', { name: 'No task, In progress' })).not.toBeNull();
    const totals = await summary();
    expect(totals.completedCount).toBe('0');
    expect(totals.totalTime).toBe('0 min');
  });
});
