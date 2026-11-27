import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as TimeSync from '../../lib/time-sync';
import { clock } from '../../lib/time-sync';
import { fakeSession } from '../../test/fake-focus-session-api';
import {
  focusWrites,
  pathOf,
  renderFocusApp,
  settle,
  startFocusWorld,
} from '../../test/focus-route';
import { resetPendingRefresh } from '../auth/auth-client';
import { clearAccessToken } from '../auth/token-store';
import { claimDeepFocus } from './browser';
import { initialLeaveGuard, secondsLeft, stepLeaveGuard } from './leave-guard';
import { playingSounds, stopAllSounds } from './sounds';

// Deep Focus (DF1–DF5) in the app: the start, the settle-in breath, the full-screen view,
// the leave rule, the one pause and the hold to end. jsdom has no full screen, so "here"
// means a visible, focused tab.

vi.mock('../../lib/time-sync', async (importOriginal) => {
  const actual = await importOriginal<typeof TimeSync>();
  return { ...actual, clock: actual.createClock(() => Date.now()) };
});

const NOW = Date.parse('2026-03-09T10:00:00.000Z');
let focused = true;

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
  vi.setSystemTime(NOW);
  focused = true;
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearAccessToken();
  resetPendingRefresh();
  clock.reset();
  stopAllSounds();
  window.localStorage.clear();
});

const boot = () => settle(700);
const deepScreen = () => screen.queryByRole('dialog', { name: 'Deep Focus' });
const posts = (calls: Parameters<typeof focusWrites>[0], suffix: string) =>
  focusWrites(calls).filter((call) => pathOf(call).endsWith(suffix));

/** Leaves the window (it loses focus), as switching to another app or tab does. */
async function leave(): Promise<void> {
  focused = false;
  window.dispatchEvent(new Event('blur'));
  await settle(100);
}

async function comeBack(): Promise<void> {
  focused = true;
  window.dispatchEvent(new Event('focus'));
  await settle(100);
}

/** A Deep Focus session the server holds, owned by this tab unless `owned` is false. */
function seedDeep(world: ReturnType<typeof startFocusWorld>, owned = true) {
  const session = fakeSession({
    status: 'in_progress',
    plannedSeconds: 1_500,
    focusedSeconds: 0,
    startedAt: new Date(NOW).toISOString(),
    runningSince: new Date(NOW).toISOString(),
    task: null,
    deepFocus: { distractions: 0, pausesUsed: 0 },
  });
  world.focusApi.sessions.unshift(session);
  if (owned) {
    claimDeepFocus(session.id);
  }
  return session;
}

describe('the leave rule (pure)', () => {
  it('starts a countdown, counts a return within it and breaks once after it', () => {
    let step = stepLeaveGuard(initialLeaveGuard, { nowMs: 0, present: false });
    expect(step.effect).toBe('none');
    expect(secondsLeft(step.state, 3_200)).toBe(7);
    expect(stepLeaveGuard(step.state, { nowMs: 9_999, present: true }).effect).toBe('distraction');

    step = stepLeaveGuard(step.state, { nowMs: 10_000, present: false });
    expect(step.effect).toBe('break');
    // Coming back late is still a break, and it is never asked for twice.
    expect(stepLeaveGuard(step.state, { nowMs: 12_000, present: true }).effect).toBe('none');
  });

  it('breaks when the user comes back only after the deadline', () => {
    const away = stepLeaveGuard(initialLeaveGuard, { nowMs: 0, present: false }).state;
    expect(stepLeaveGuard(away, { nowMs: 30_000, present: true }).effect).toBe('break');
  });
});

describe('Deep Focus', () => {
  it('is its own tab; the dashboard links to it and starts only plain sessions', async () => {
    startFocusWorld();
    renderFocusApp();
    await boot();
    expect(screen.queryByRole('button', { name: 'Start Deep Focus' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Try Deep Focus' }).getAttribute('href')).toBe(
      '/deep-focus',
    );
  });

  it('starts after the settle-in breath, with deepFocus sent, and covers the page', async () => {
    const world = startFocusWorld();
    renderFocusApp({ initialPath: '/deep-focus' });
    await boot();

    fireEvent.click(screen.getByRole('button', { name: 'Start Deep Focus' }));
    await settle(100);
    expect(screen.getByRole('dialog', { name: 'Settle in' })).not.toBeNull();
    expect(focusWrites(world.calls)).toHaveLength(0);

    await settle(15_500);
    expect(focusWrites(world.calls)[0]?.body).toBe('{"plannedSeconds":1500,"deepFocus":true}');
    await settle(300);
    const dialog = deepScreen();
    expect(dialog).not.toBeNull();
    expect(within(dialog as HTMLElement).getByText('No distractions so far')).not.toBeNull();
  });

  it('plays several chosen sounds together and carries them into the session', async () => {
    startFocusWorld();
    renderFocusApp({ initialPath: '/deep-focus' });
    await boot();

    const picker = screen.getByRole('group', { name: 'Focus sounds' });
    fireEvent.click(within(picker).getByRole('button', { name: /^Rain/ }));
    fireEvent.click(within(picker).getByRole('button', { name: /^Brown noise/ }));
    expect(playingSounds()).toEqual(['brown', 'rain']);
    expect(within(picker).getByRole('button', { name: /^Rain/ }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    fireEvent.click(within(picker).getByRole('button', { name: /^Rain/ }));
    expect(playingSounds()).toEqual(['brown']);

    fireEvent.click(screen.getByRole('button', { name: 'Start Deep Focus' }));
    await settle(15_800);
    const dialog = deepScreen() as HTMLElement;
    expect(playingSounds()).toEqual(['brown']);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sounds (1 on)' }));
    fireEvent.click(within(dialog).getByRole('button', { name: /^Fireplace/ }));
    expect(playingSounds()).toEqual(['brown', 'fire']);
  });

  it('cancelling the breath starts nothing', async () => {
    const world = startFocusWorld();
    renderFocusApp({ initialPath: '/deep-focus' });
    await boot();
    fireEvent.click(screen.getByRole('button', { name: 'Start Deep Focus' }));
    await settle(100);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await settle(20_000);
    expect(focusWrites(world.calls)).toHaveLength(0);
    expect(screen.queryByRole('dialog', { name: 'Settle in' })).toBeNull();
  });

  it('warns on leaving and counts one distraction when the user is back in time', async () => {
    const world = startFocusWorld();
    seedDeep(world);
    renderFocusApp();
    await boot();
    await settle(2_000); // Past the settling moment after the guard starts.

    await leave();
    const warning = screen.getByRole('alertdialog', { name: 'You left Deep Focus' });
    expect(warning.textContent).toContain('Come back now');
    await settle(4_000);
    await comeBack();

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(posts(world.calls, '/distraction')).toHaveLength(1);
    expect(posts(world.calls, '/break')).toHaveLength(0);
    await settle(300);
    expect(screen.getByText('1 distraction')).not.toBeNull();
  });

  it('resets the session when the user stays away past 10 seconds', async () => {
    const world = startFocusWorld();
    seedDeep(world);
    renderFocusApp();
    await boot();
    await settle(2_000);

    await leave();
    await settle(10_500);

    expect(posts(world.calls, '/break')).toHaveLength(1);
    await comeBack();
    await settle(500);
    expect(deepScreen()).toBeNull();
    expect(screen.getByText(/Focus broken: you were away from Deep Focus/)).not.toBeNull();
    expect(world.focusApi.sessions[0]).toMatchObject({
      status: 'abandoned',
      abandonReason: 'focus_broken',
    });
  });

  it('allows one pause; leaving while paused is fine', async () => {
    const world = startFocusWorld();
    seedDeep(world);
    renderFocusApp();
    await boot();

    fireEvent.click(screen.getByRole('button', { name: /^Pause \(once/ }));
    await settle(300);
    expect(screen.getByText(/Your pause: 05:00 left/)).not.toBeNull();
    await leave();
    await settle(20_000);
    expect(posts(world.calls, '/break')).toHaveLength(0);
    await comeBack();

    fireEvent.click(within(deepScreen() as HTMLElement).getByRole('button', { name: 'Resume' }));
    await settle(300);
    const used = screen.getByRole<HTMLButtonElement>('button', { name: 'Pause used' });
    expect(used.disabled).toBe(true);
  });

  it('tells the user when the pause is over', async () => {
    const world = startFocusWorld();
    seedDeep(world);
    renderFocusApp();
    await boot();
    fireEvent.click(screen.getByRole('button', { name: /^Pause \(once/ }));
    await settle(301_000);
    expect(screen.getByText('Your pause is over. Resume, or end the session.')).not.toBeNull();
  });

  it('ends only after a 3-second hold', async () => {
    const world = startFocusWorld();
    seedDeep(world);
    renderFocusApp();
    await boot();

    const hold = screen.getByRole('button', { name: 'Hold to end' });
    fireEvent.pointerDown(hold);
    await settle(1_500);
    fireEvent.pointerUp(hold);
    await settle(3_000);
    expect(posts(world.calls, '/stop')).toHaveLength(0);

    fireEvent.pointerDown(screen.getByRole('button', { name: /Hold to end|Keep holding/ }));
    await settle(3_200);
    expect(posts(world.calls, '/stop')).toHaveLength(1);
  });

  it('watches the session only in the tab that started it', async () => {
    const world = startFocusWorld();
    seedDeep(world, false);
    renderFocusApp();
    await boot();

    expect(screen.getByRole('button', { name: 'Continue here' })).not.toBeNull();
    await leave();
    await settle(15_000);
    expect(posts(world.calls, '/break')).toHaveLength(0);
    await comeBack();

    fireEvent.click(screen.getByRole('button', { name: 'Continue here' }));
    await settle(300);
    expect(screen.getByRole('button', { name: 'Hold to end' })).not.toBeNull();
  });
});
