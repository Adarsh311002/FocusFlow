import { focusSessionUpdatedEventSchema } from '@focus-flow/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as TimeSync from '../../lib/time-sync';
import { clock } from '../../lib/time-sync';
import { errorResponse, jsonResponse, type RecordedRequest } from '../../test/api-stub';
import { fakeSession } from '../../test/fake-focus-session-api';
import {
  currentReads,
  focusWrites,
  pathOf,
  renderFocusApp,
  settle,
  startFocusWorld,
} from '../../test/focus-route';
import { resetPendingRefresh } from '../auth/auth-client';
import { clearAccessToken } from '../auth/token-store';

// The app clock binds `Date.now` when it is created (at import), which fake timers cannot
// replace afterwards. A clock that reads `Date.now` late lets the tests move time.
vi.mock('../../lib/time-sync', async (importOriginal) => {
  const actual = await importOriginal<typeof TimeSync>();
  return { ...actual, clock: actual.createClock(() => Date.now()) };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearAccessToken();
  resetPendingRefresh();
  clock.reset();
});

const startButton = () => screen.findByRole('button', { name: 'Start focus' });
const alertText = async () => (await screen.findByRole('alert')).textContent;
const isPost = (suffix: string) => (request: RecordedRequest) =>
  request.method === 'POST' && request.url.endsWith(suffix);

/** A session the server already holds, running (or paused) since `ago` seconds before `nowMs`. */
function seedRunning(
  world: ReturnType<typeof startFocusWorld>,
  nowMs: number,
  overrides: { ago?: number; planned?: number; focused?: number; paused?: boolean } = {},
) {
  const { ago = 0, planned = 1_500, focused = 0, paused = false } = overrides;
  const session = fakeSession({
    status: 'in_progress',
    plannedSeconds: planned,
    focusedSeconds: focused,
    startedAt: new Date(nowMs - ago * 1_000).toISOString(),
    runningSince: paused ? null : new Date(nowMs - ago * 1_000).toISOString(),
    task: null,
  });
  world.focusApi.sessions.unshift(session);
  return session;
}

describe('starting a session', () => {
  it('starts the default 25 minutes with exactly {plannedSeconds}, no task', async () => {
    const world = startFocusWorld();
    renderFocusApp();

    expect(await screen.findByRole('heading', { name: 'Focus' })).not.toBeNull();
    await startButton();
    expect(screen.getByLabelText<HTMLInputElement>('25 minutes').checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Start focus' }));

    expect(await screen.findByText('Running')).not.toBeNull();
    const writes = focusWrites(world.calls);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.body).toBe('{"plannedSeconds":1500}');
    expect(world.focusApi.sessions).toHaveLength(1);
  });

  it('sends the chosen preset', async () => {
    const world = startFocusWorld();
    renderFocusApp();
    await startButton();

    fireEvent.click(screen.getByLabelText('50 minutes'));
    fireEvent.click(screen.getByRole('button', { name: 'Start focus' }));

    await screen.findByText('Running');
    expect(focusWrites(world.calls)[0]?.body).toBe('{"plannedSeconds":3000}');
  });

  it.each([
    ['1', 60],
    ['240', 14_400],
    [' 90 ', 5_400],
  ])('accepts %j custom minutes', async (text, seconds) => {
    const world = startFocusWorld();
    renderFocusApp();
    await startButton();

    fireEvent.change(screen.getByLabelText('Custom minutes'), { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: 'Start focus' }));

    await screen.findByText('Running');
    expect(focusWrites(world.calls)[0]?.body).toBe(`{"plannedSeconds":${String(seconds)}}`);
  });

  it.each(['0', '241', 'abc', '1.5', '-5', '  '])(
    'refuses %j custom minutes without calling the API',
    async (text) => {
      const world = startFocusWorld();
      renderFocusApp();
      await startButton();

      fireEvent.change(screen.getByLabelText('Custom minutes'), { target: { value: text } });
      fireEvent.click(screen.getByRole('button', { name: 'Start focus' }));

      expect(await alertText()).toMatch(/whole number of minutes from 1 to 240/);
      expect(focusWrites(world.calls)).toEqual([]);
    },
  );

  it('refuses a custom field that was emptied again', async () => {
    const world = startFocusWorld();
    renderFocusApp();
    await startButton();
    const field = screen.getByLabelText('Custom minutes');

    fireEvent.change(field, { target: { value: '5' } });
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start focus' }));

    expect(await alertText()).toMatch(/whole number of minutes/);
    expect(focusWrites(world.calls)).toEqual([]);
  });

  it('clears the validation error as soon as the user changes the duration', async () => {
    startFocusWorld();
    renderFocusApp();
    await startButton();
    fireEvent.change(screen.getByLabelText('Custom minutes'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start focus' }));
    await screen.findByRole('alert');

    fireEvent.click(screen.getByLabelText('15 minutes'));

    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('associates the selected task', async () => {
    const world = startFocusWorld();
    const task = world.taskApi.addTask('Write report');
    renderFocusApp();
    await startButton();

    const select = screen.getByLabelText<HTMLSelectElement>('Task');
    expect(within(select).getByRole('option', { name: 'No task' })).not.toBeNull();
    await within(select).findByRole('option', { name: 'Write report' });
    fireEvent.change(select, { target: { value: task.id } });
    fireEvent.click(screen.getByRole('button', { name: 'Start focus' }));

    expect(await screen.findByText('Running')).not.toBeNull();
    // The task list below also names it; the Focus panel is what shows the running task.
    expect(
      within(screen.getByRole('region', { name: 'Focus' })).getByText('Write report'),
    ).not.toBeNull();
    expect(JSON.parse(focusWrites(world.calls)[0]?.body ?? '{}')).toEqual({
      plannedSeconds: 1_500,
      taskId: task.id,
    });
  });

  it('omits the task when "No task" is chosen over a task', async () => {
    const world = startFocusWorld();
    const task = world.taskApi.addTask('Write report');
    renderFocusApp();
    await startButton();
    const select = screen.getByLabelText<HTMLSelectElement>('Task');
    await within(select).findByRole('option', { name: 'Write report' });
    fireEvent.change(select, { target: { value: task.id } });

    fireEvent.change(select, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start focus' }));

    await screen.findByText('Running');
    expect(focusWrites(world.calls)[0]?.body).toBe('{"plannedSeconds":1500}');
  });

  it('shows a task that was deleted after the session started as deleted', async () => {
    const world = startFocusWorld();
    const now = Date.now();
    world.focusApi.sessions.unshift(
      fakeSession({
        status: 'in_progress',
        plannedSeconds: 1_500,
        focusedSeconds: 0,
        startedAt: new Date(now).toISOString(),
        runningSince: new Date(now).toISOString(),
        task: { id: crypto.randomUUID(), title: 'Old plan', deleted: true },
      }),
    );
    renderFocusApp();

    expect(await screen.findByText('Old plan')).not.toBeNull();
    expect(screen.getByText('(task deleted)')).not.toBeNull();
  });

  it('disables the button while pending and sends ONE request for a double click', async () => {
    const world = startFocusWorld();
    renderFocusApp();
    const button = await startButton();
    const release = world.hold(isPost('/focus-sessions'));

    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.submit(screen.getByRole('form', { name: 'Start a focus session' }));

    const pending = await screen.findByRole('button', { name: 'Starting…' });
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    expect(focusWrites(world.calls)).toHaveLength(1);

    release();
    await screen.findByText('Running');
    expect(focusWrites(world.calls)).toHaveLength(1);
    expect(world.focusApi.sessions).toHaveLength(1);
  });
});

describe('restoring after a reload', () => {
  it('shows a running session and sends no POST', async () => {
    const world = startFocusWorld();
    seedRunning(world, Date.now(), { ago: 60 });
    renderFocusApp();

    expect(await screen.findByText('Running')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Pause' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Start focus' })).toBeNull();
    expect(focusWrites(world.calls)).toEqual([]);
  });

  it('shows a paused session with Resume and no POST', async () => {
    const world = startFocusWorld();
    seedRunning(world, Date.now(), { focused: 300, paused: true });
    renderFocusApp();

    expect(await screen.findByText('Paused')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Resume' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(focusWrites(world.calls)).toEqual([]);
  });

  it('shows the start form when nothing is running, without any POST', async () => {
    const world = startFocusWorld();
    renderFocusApp();

    expect(await startButton()).not.toBeNull();
    expect(focusWrites(world.calls)).toEqual([]);
  });

  it('offers a retry when the session cannot be read', async () => {
    const world = startFocusWorld();
    world.focusApi.failNext('current', () => errorResponse(500, 'INTERNAL', 'boom'));
    renderFocusApp();

    expect(await alertText()).toMatch(/Something went wrong on the server/);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await startButton()).not.toBeNull();
  });
});

describe('pause, resume and stop', () => {
  async function runningWorld() {
    const world = startFocusWorld();
    const session = seedRunning(world, Date.now(), { ago: 30 });
    renderFocusApp();
    await screen.findByText('Running');
    return { world, session };
  }

  it('pauses, resumes and stops with one request each, to the right session', async () => {
    const { world, session } = await runningWorld();

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await screen.findByText('Paused');
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await screen.findByText('Running');
    fireEvent.click(screen.getByRole('button', { name: 'Stop session' }));
    // Nothing is sent before the confirmation.
    expect(focusWrites(world.calls)).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm stop' }));

    expect(await screen.findByText(/Stopped: \d+ min recorded/)).not.toBeNull();
    expect(focusWrites(world.calls).map((call) => pathOf(call))).toEqual([
      `/focus-sessions/${session.id}/pause`,
      `/focus-sessions/${session.id}/resume`,
      `/focus-sessions/${session.id}/stop`,
    ]);
    expect(screen.getByRole('button', { name: 'Start focus' })).not.toBeNull();
  });

  it('Cancel leaves the session running and sends nothing', async () => {
    const { world } = await runningWorld();

    fireEvent.click(screen.getByRole('button', { name: 'Stop session' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByText('Running')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Pause' })).not.toBeNull();
    expect(focusWrites(world.calls)).toEqual([]);
  });

  it('disables every control while a request is in flight and sends one request', async () => {
    const { world } = await runningWorld();
    const release = world.hold(isPost('/pause'));

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));

    const pausing = await screen.findByRole('button', { name: 'Pausing…' });
    expect((pausing as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Stop session' }).disabled).toBe(
      true,
    );
    fireEvent.click(pausing);
    expect(focusWrites(world.calls)).toHaveLength(1);

    release();
    await screen.findByText('Paused');
    expect(focusWrites(world.calls)).toHaveLength(1);
  });

  it('a pause after the server ended the session answers 200 unchanged and is harmless (E11)', async () => {
    const { world } = await runningWorld();
    world.focusApi.abandonCurrent('grace_expired');

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));

    expect(await screen.findByText(/Ended because you disconnected/)).not.toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(await startButton()).not.toBeNull();
    expect(focusWrites(world.calls)).toHaveLength(1);
  });
});

describe('keyboard focus and the clock note', () => {
  async function runningWorld() {
    const world = startFocusWorld();
    seedRunning(world, Date.now(), { ago: 30 });
    renderFocusApp();
    await screen.findByText('Running');
    return world;
  }

  it('follows the control that replaces the one that was used', async () => {
    await runningWorld();

    // Opening the stop question replaces "Stop session"; focus must land on "Confirm stop".
    fireEvent.click(screen.getByRole('button', { name: 'Stop session' }));
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Confirm stop' }));
    });
    // Cancelling brings back "Stop session", which is where the user was.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Stop session' }));
    });

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await screen.findByText('Paused');
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Resume' }));
    });
  });

  it('does not take focus away from a field outside the session controls', async () => {
    const world = startFocusWorld();
    const running = seedRunning(world, Date.now(), { ago: 30 });
    const { realtime } = renderFocusApp();
    await screen.findByText('Running');
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();

    // Another tab pauses the session; this tab only learns of it through the event.
    const paused = { ...running, runningSince: null };
    world.focusApi.sessions[0] = paused;
    realtime.emitFocusSessionUpdated(focusSessionUpdatedEventSchema.parse({ session: paused }));

    await screen.findByText('Paused');
    expect(document.activeElement).toBe(field);
    field.remove();
  });

  it('says the time may be off until the clock has been measured, then stops saying it', async () => {
    await runningWorld();
    expect(screen.getByText(/Syncing with the server clock/)).not.toBeNull();

    clock.addSample({ offsetMs: 0, roundTripMs: 20 });
    await waitFor(
      () => {
        expect(screen.queryByText(/Syncing with the server clock/)).toBeNull();
      },
      { timeout: 3_000 },
    );
  });
});

describe('errors', () => {
  it('recovers the existing session from 409 SESSION_IN_PROGRESS without a duplicate', async () => {
    const world = startFocusWorld();
    renderFocusApp();
    const button = await startButton();
    // Another tab started a session after this tab last looked.
    seedRunning(world, Date.now(), { ago: 5 });

    fireEvent.click(button);

    expect(await screen.findByText('Running')).not.toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(world.focusApi.sessions).toHaveLength(1);
    expect(focusWrites(world.calls)).toHaveLength(1);
  });

  it.each([
    ['NOT_CONNECTED', 409, /live connection/],
    ['TASK_NOT_FOUND', 404, /no longer exists/],
    ['TASK_NOT_OPEN', 409, /completed/],
    ['INTERNAL', 503, /changed nothing/],
  ] as const)(
    'shows %s on start as an alert and re-enables the button',
    async (code, status, text) => {
      const world = startFocusWorld();
      renderFocusApp();
      const button = await startButton();
      world.focusApi.failNext('start', () => errorResponse(status, code, 'raw'));

      fireEvent.click(button);

      expect(await alertText()).toMatch(text);
      const again = await screen.findByRole('button', { name: 'Start focus' });
      expect((again as HTMLButtonElement).disabled).toBe(false);
    },
  );

  it('refuses to start while the user is not connected (server NOT_CONNECTED)', async () => {
    const world = startFocusWorld();
    world.focusApi.setConnected(false);
    renderFocusApp();

    fireEvent.click(await startButton());

    expect(await alertText()).toMatch(/live connection/);
    expect(world.focusApi.sessions).toHaveLength(0);
  });

  it('shows a network failure on start and re-reads the current session', async () => {
    const world = startFocusWorld();
    renderFocusApp();
    const button = await startButton();
    const readsBefore = currentReads(world.calls).length;
    // The request may have committed even though the answer never arrived.
    world.focusApi.failNext('start', () => {
      throw new TypeError('network down');
    });

    fireEvent.click(button);

    expect(await alertText()).toMatch(/could not reach the server/);
    await waitFor(() => {
      expect(currentReads(world.calls).length).toBeGreaterThan(readsBefore);
    });
  });

  it('adopts a session that committed although the start answered 503', async () => {
    const world = startFocusWorld();
    renderFocusApp();
    const button = await startButton();
    world.focusApi.failNext('start', () => {
      seedRunning(world, Date.now());
      return errorResponse(503, 'INTERNAL', 'busy');
    });

    fireEvent.click(button);

    expect(await screen.findByText('Running')).not.toBeNull();
  });

  describe('on a running session', () => {
    async function running() {
      const world = startFocusWorld();
      seedRunning(world, Date.now(), { ago: 30 });
      renderFocusApp();
      await screen.findByText('Running');
      return world;
    }

    it('keeps state and offers a retry after a 503 on pause', async () => {
      const world = await running();
      world.focusApi.failNext('pause', () => errorResponse(503, 'INTERNAL', 'busy'));

      fireEvent.click(screen.getByRole('button', { name: 'Pause' }));

      expect(await alertText()).toMatch(/changed nothing/);
      expect(screen.getByText('Running')).not.toBeNull();
      const again = screen.getByRole('button', { name: 'Pause' });
      expect((again as HTMLButtonElement).disabled).toBe(false);

      fireEvent.click(again);
      expect(await screen.findByText('Paused')).not.toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('keeps the confirmation and shows the alert after a 503 on stop', async () => {
      const world = await running();
      world.focusApi.failNext('stop', () => errorResponse(503, 'INTERNAL', 'busy'));

      fireEvent.click(screen.getByRole('button', { name: 'Stop session' }));
      fireEvent.click(screen.getByRole('button', { name: 'Confirm stop' }));

      expect(await alertText()).toMatch(/changed nothing/);
      expect(world.focusApi.current()?.status).toBe('in_progress');
      const confirm = screen.getByRole('button', { name: 'Confirm stop' });
      expect((confirm as HTMLButtonElement).disabled).toBe(false);
    });

    it('shows NOT_CONNECTED on resume and leaves the session paused', async () => {
      const world = startFocusWorld();
      seedRunning(world, Date.now(), { focused: 60, paused: true });
      renderFocusApp();
      await screen.findByText('Paused');
      world.focusApi.setConnected(false);

      fireEvent.click(screen.getByRole('button', { name: 'Resume' }));

      expect(await alertText()).toMatch(/live connection/);
      expect(screen.getByText('Paused')).not.toBeNull();
      const resume = screen.getByRole('button', { name: 'Resume' });
      expect((resume as HTMLButtonElement).disabled).toBe(false);
    });

    it.each(['pause', 'resume', 'stop'] as const)(
      'a 404 on %s re-reads the current session instead of trusting the screen',
      async (action) => {
        const world = startFocusWorld();
        seedRunning(world, Date.now(), { ago: 30, paused: action === 'resume', focused: 10 });
        renderFocusApp();
        await screen.findByText(action === 'resume' ? 'Paused' : 'Running');
        const readsBefore = currentReads(world.calls).length;
        // The session vanished server-side between the render and the click.
        world.focusApi.sessions.length = 0;

        if (action === 'stop') {
          fireEvent.click(screen.getByRole('button', { name: 'Stop session' }));
          fireEvent.click(screen.getByRole('button', { name: 'Confirm stop' }));
        } else {
          fireEvent.click(
            screen.getByRole('button', { name: action === 'pause' ? 'Pause' : 'Resume' }),
          );
        }

        expect(await startButton()).not.toBeNull();
        expect(currentReads(world.calls).length).toBeGreaterThan(readsBefore);
      },
    );

    it('a network failure on pause shows the message and keeps the session', async () => {
      const world = await running();
      world.focusApi.failNext('pause', () => {
        throw new TypeError('offline');
      });

      fireEvent.click(screen.getByRole('button', { name: 'Pause' }));

      expect(await alertText()).toMatch(/could not reach the server/);
      expect(screen.getByText('Running')).not.toBeNull();
    });

    it('treats a malformed pause answer as an error and keeps the session', async () => {
      const world = await running();
      world.focusApi.failNext('pause', () => jsonResponse(200, { session: { id: 'x' } }));

      fireEvent.click(screen.getByRole('button', { name: 'Pause' }));

      expect(await alertText()).toMatch(/unexpected response/);
      expect(screen.getByText('Running')).not.toBeNull();
    });
  });
});

/** Lets the sign-in probe, `/me` and the first reads finish on virtual time. */
const boot = () => settle(700);

describe('the clock', () => {
  const NOW = Date.parse('2026-03-09T10:00:00.000Z');

  beforeEach(() => {
    // Timers and Date are faked together so the one-second tick and the re-asks at zero
    // run on virtual time; `settle` flushes React and TanStack Query.
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    vi.setSystemTime(NOW);
  });

  it('counts down from focusedSeconds plus the running stretch, on the server clock', async () => {
    const world = startFocusWorld();
    // 600 s into a 25-minute session, with 120 s already focused before this stretch.
    seedRunning(world, NOW, { ago: 600, focused: 120, planned: 1_500 });
    // The server's clock is 60 s ahead of the browser's.
    clock.addSample({ offsetMs: 60_000, roundTripMs: 10 });
    renderFocusApp();
    await boot();

    // focused = 120 + (60 + 600) = 780 s, so 720 s remain.
    expect(screen.getByText('12:00')).not.toBeNull();
    expect(screen.getByText('Focused 13:00 of 25:00')).not.toBeNull();

    await settle(5_000);
    expect(screen.getByText('11:55')).not.toBeNull();
  });

  it('freezes a paused session', async () => {
    const world = startFocusWorld();
    seedRunning(world, NOW, { focused: 300, paused: true });
    renderFocusApp();
    await boot();
    expect(screen.getByText('20:00')).not.toBeNull();

    await settle(30_000);

    expect(screen.getByText('20:00')).not.toBeNull();
    expect(screen.getByText('Paused')).not.toBeNull();
  });

  it('never shows less than 0:00 when the stretch is longer than the plan', async () => {
    const world = startFocusWorld();
    seedRunning(world, NOW, { ago: 100, planned: 60 });
    renderFocusApp();
    await boot();

    expect(screen.getByText('00:00')).not.toBeNull();
    expect(screen.getByText('Focused 01:00 of 01:00')).not.toBeNull();
  });

  it('shows Finishing… at zero, not Completed, and stays in progress until the server says so', async () => {
    const world = startFocusWorld();
    seedRunning(world, NOW, { ago: 58, planned: 60 });
    renderFocusApp();
    await boot();
    expect(screen.queryByText(/Finishing/)).toBeNull();

    await settle(3_000);

    expect(screen.getByText('00:00')).not.toBeNull();
    expect(screen.getByText(/Finishing/)).not.toBeNull();
    expect(screen.getByText('Running')).not.toBeNull();
    expect(
      within(screen.getByRole('region', { name: 'Focus' })).queryByText(/Completed/),
    ).toBeNull();
    // Nothing ended it: the browser never decides an outcome.
    expect(focusWrites(world.calls)).toEqual([]);
    expect(world.focusApi.current()?.status).toBe('in_progress');
    expect(screen.getByRole('button', { name: 'Pause' })).not.toBeNull();
  });

  it('asks the server again shortly after zero, then at a bounded rate', async () => {
    const world = startFocusWorld();
    seedRunning(world, NOW, { ago: 60, planned: 60 }); // already at zero when loaded
    renderFocusApp();
    await boot();
    const baseline = currentReads(world.calls).length;

    await settle(1_000);
    const afterOneSecond = currentReads(world.calls).length;
    await settle(2_000);
    const afterThree = currentReads(world.calls).length;
    await settle(3_000);
    const afterSix = currentReads(world.calls).length;
    await settle(60_000);
    const afterMinute = currentReads(world.calls).length;

    expect(afterOneSecond).toBeGreaterThanOrEqual(baseline);
    expect(afterThree).toBeGreaterThan(afterOneSecond);
    expect(afterSix).toBeGreaterThan(afterThree);
    expect(afterMinute - afterSix).toBeLessThanOrEqual(8);
    expect(
      within(screen.getByRole('region', { name: 'Focus' })).queryByText(/Completed/),
    ).toBeNull();
    expect(screen.getByText('Running')).not.toBeNull();
  });

  it('returns to the start form once a re-ask finds the session completed', async () => {
    const world = startFocusWorld();
    seedRunning(world, NOW, { ago: 60, planned: 60 });
    renderFocusApp();
    await boot();

    world.focusApi.completeCurrent();
    await settle(12_000);

    expect(screen.queryByText('Running')).toBeNull();
    expect(screen.getByRole('button', { name: 'Start focus' })).not.toBeNull();
  });

  it('warns while a running session has no live connection, but not when paused', async () => {
    const world = startFocusWorld();
    seedRunning(world, NOW, { ago: 10 });
    const { realtime } = renderFocusApp();
    await boot();
    expect(screen.queryByText(/must stay open and connected/)).toBeNull();

    realtime.disconnect();
    await settle(10);
    expect(screen.getByText(/must stay open and connected/)).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await boot();
    expect(screen.getByText('Paused')).not.toBeNull();
    expect(screen.queryByText(/must stay open and connected/)).toBeNull();
  });

  it('notes a long-paused session', async () => {
    const world = startFocusWorld();
    seedRunning(world, NOW - 3 * 3_600_000, { focused: 10, paused: true });
    renderFocusApp();
    await boot();

    expect(screen.getByText(/paused for a long time/)).not.toBeNull();
  });
});
