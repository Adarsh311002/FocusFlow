import type { TimerView } from '@focus-flow/contracts';
import { act, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { clock } from '../../lib/time-sync';
import { type FakeRoom, GRACE_ID, ME } from '../../test/fake-room-api';
import { ackFailure, joinOk, timerOk, timerView } from '../../test/fake-room-client';
import { prepareRooms } from '../../test/room-route';
import { resetPendingRefresh } from '../auth/auth-client';
import { clearAccessToken } from '../auth/token-store';
import { roomAckSchemas } from '../realtime/room-events';

configure({ asyncUtilTimeout: 4_000 });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearAccessToken();
  resetPendingRefresh();
});

type World = ReturnType<typeof prepareRooms>;

/** A running timer starting now, unless the test says otherwise. */
const running = (overrides: Partial<TimerView> = {}): Partial<TimerView> => {
  const now = Date.now();
  return { status: 'running', segmentStartedAtMs: now, endsAtMs: now + 1_500_000, ...overrides };
};

async function openRoom(
  options: { host?: boolean; timer?: Partial<TimerView> } = {},
): Promise<{ world: World; room: FakeRoom }> {
  const world = prepareRooms();
  const room = world.api.addRoom({
    name: 'Deep work',
    hostId: options.host === false ? GRACE_ID : ME,
    memberIds: [GRACE_ID],
    code: 'ABC234',
  });
  world.client.joinRoom.mockImplementation(() =>
    Promise.resolve(joinOk(room, [ME], undefined, options.timer)),
  );
  world.render(`/rooms/${room.id}`);
  await screen.findByRole('heading', { name: room.name });
  await screen.findByText('You are in the room.');
  return { world, room };
}

const timerSection = () => within(screen.getByRole('region', { name: 'Room timer' }));
const button = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name });

const push = (world: World, room: FakeRoom, timer: Partial<TimerView>) => {
  act(() => {
    world.client.push('room:timer:state', {
      roomId: room.id,
      timer: timerView(room.id, timer),
      serverNowMs: Date.now(),
    });
  });
};

const fail = (code: string, details?: unknown) =>
  roomAckSchemas.timer.parse({
    ok: false,
    error: { code, message: 'Server words.', ...(details === undefined ? {} : { details }) },
  });

describe('the room timer: display', () => {
  it('shows an idle timer as not started with the full phase length', async () => {
    await openRoom();
    const timer = timerSection();
    expect(timer.getByText('Not started')).not.toBeNull();
    expect(timer.getByText('Focus', { selector: 'p' })).not.toBeNull();
    expect(timer.getByText('25:00')).not.toBeNull();
    expect(timer.getByText(/The timer has not started/)).not.toBeNull();
    const bar = timer.getByRole('progressbar', { name: 'Phase progress' });
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('1500');
    expect(bar.getAttribute('aria-valuenow')).toBe('0');
  });

  it('shows a running timer counting down, with hours when long enough', async () => {
    await openRoom({
      timer: running({
        phase: 'long_break',
        durationMs: 3_725_000,
        endsAtMs: Date.now() + 3_725_000,
      }),
    });
    const timer = timerSection();
    expect(timer.getByText('Long break', { selector: 'p' })).not.toBeNull();
    expect(timer.getByText('Running')).not.toBeNull();
    expect(timer.getByText(/^1:0[12]:\d\d$/)).not.toBeNull();
  });

  it('says the clock is still syncing before the first time sample', async () => {
    await openRoom();
    expect(timerSection().getByText(/Syncing with the server clock/)).not.toBeNull();
  });

  it('shows a loading state until the snapshot arrives', async () => {
    const world = prepareRooms();
    const room = world.api.addRoom({ name: 'Deep work', memberIds: [GRACE_ID] });
    let answer: (ack: ReturnType<typeof joinOk>) => void = () => undefined;
    world.client.joinRoom.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    world.render(`/rooms/${room.id}`);
    await screen.findByRole('heading', { name: room.name });
    expect(await screen.findByText('Loading the timer…')).not.toBeNull();
    act(() => {
      answer(joinOk(room, [ME]));
    });
    expect(await screen.findByText('Not started')).not.toBeNull();
  });

  it('follows newer timer events, ignores older ones and other rooms', async () => {
    const { world, room } = await openRoom();
    push(world, room, { status: 'paused', elapsedBeforeMs: 300_000, version: 1_002 });
    expect(timerSection().getByText('Paused')).not.toBeNull();
    expect(timerSection().getByText('20:00')).not.toBeNull();

    push(world, room, { phase: 'short_break', version: 1_001 });
    act(() => {
      const other = crypto.randomUUID();
      world.client.push('room:timer:state', {
        roomId: other,
        timer: timerView(other, { phase: 'long_break', version: 9_999 }),
        serverNowMs: Date.now(),
      });
    });
    expect(timerSection().getByText('Paused')).not.toBeNull();
    expect(timerSection().queryByText('Short break', { selector: 'p' })).toBeNull();
    expect(timerSection().queryByText('Long break', { selector: 'p' })).toBeNull();
  });

  it('announces a phase change politely, not the ticking time', async () => {
    const { world, room } = await openRoom();
    const live = timerSection().getByText('Focus, not started.');
    expect(live.getAttribute('aria-live')).toBe('polite');
    push(world, room, { phase: 'short_break', version: 1_001 });
    expect(timerSection().getByText('Short break, not started.')).not.toBeNull();
  });

  it('replaces the state from the snapshot on resync, even with a lower version', async () => {
    const { world, room } = await openRoom({ timer: { version: 5_000 } });
    push(world, room, { status: 'paused', version: 5_001 });
    expect(timerSection().getByText('Paused')).not.toBeNull();

    world.client.joinRoom.mockImplementation(() =>
      Promise.resolve(joinOk(room, [ME], undefined, { version: 3 })),
    );
    act(() => {
      world.client.push('room:resync', { roomId: room.id });
    });
    await waitFor(() => {
      expect(timerSection().getByText('Not started')).not.toBeNull();
    });
  });
});

describe('the room timer: host and non-host', () => {
  it('gives a non-host a read-only timer with a note', async () => {
    await openRoom({ host: false });
    expect(timerSection().getByText('Only the host controls the timer.')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Start timer' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reset timer' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Switch phase' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Timer lengths' })).toBeNull();
  });

  it('offers the host the control that fits each status', async () => {
    const { world, room } = await openRoom();
    expect(button('Start timer')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Pause timer' })).toBeNull();
    expect(button('Reset timer').disabled).toBe(false);

    push(world, room, running({ version: 1_001 }));
    expect(button('Pause timer')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Start timer' })).toBeNull();

    push(world, room, { status: 'paused', elapsedBeforeMs: 1_000, version: 1_002 });
    expect(button('Resume timer')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Pause timer' })).toBeNull();
  });

  it('sends start, shows a pending state with every control disabled, then the new state', async () => {
    const { world, room } = await openRoom();
    let answer: (ack: ReturnType<typeof timerOk>) => void = () => undefined;
    world.client.sendTimerCommand.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    fireEvent.click(button('Start timer'));
    expect(world.client.sendTimerCommand).toHaveBeenCalledWith(room.id, { type: 'start' });
    expect(await screen.findByText('Sending to the server…')).not.toBeNull();
    expect(button('Starting…').disabled).toBe(true);
    expect(button('Reset timer').disabled).toBe(true);
    expect(button('Short break').disabled).toBe(true);
    // A second click while pending sends nothing more.
    fireEvent.click(button('Starting…'));
    expect(world.client.sendTimerCommand).toHaveBeenCalledTimes(1);

    act(() => {
      answer(timerOk(timerView(room.id, running({ version: 1_001 }))));
    });
    expect(await screen.findByRole('button', { name: 'Pause timer' })).not.toBeNull();
    expect(button('Pause timer').disabled).toBe(false);
    expect(timerSection().getByText('Running')).not.toBeNull();
  });

  it('sends pause and resume as plain commands', async () => {
    const { world, room } = await openRoom({ timer: running() });
    world.client.sendTimerCommand.mockResolvedValueOnce(
      timerOk(timerView(room.id, { status: 'paused', elapsedBeforeMs: 1_000, version: 1_001 })),
    );
    fireEvent.click(button('Pause timer'));
    await screen.findByRole('button', { name: 'Resume timer' });
    expect(world.client.sendTimerCommand).toHaveBeenLastCalledWith(room.id, { type: 'pause' });

    world.client.sendTimerCommand.mockResolvedValueOnce(
      timerOk(timerView(room.id, running({ version: 1_002 }))),
    );
    fireEvent.click(button('Resume timer'));
    await screen.findByRole('button', { name: 'Pause timer' });
    expect(world.client.sendTimerCommand).toHaveBeenLastCalledWith(room.id, { type: 'resume' });
  });
});

describe('the room timer: reset and phase switch', () => {
  it('asks before discarding a running phase, and sends the shown version only when confirmed', async () => {
    const { world, room } = await openRoom({ timer: running({ version: 1_042 }) });
    fireEvent.click(button('Reset timer'));
    const group = screen.getByRole('group', { name: 'Confirm reset' });
    expect(within(group).getByText(/discarded for everyone/)).not.toBeNull();
    expect(world.client.sendTimerCommand).not.toHaveBeenCalled();

    fireEvent.click(within(group).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group', { name: 'Confirm reset' })).toBeNull();
    expect(world.client.sendTimerCommand).not.toHaveBeenCalled();

    world.client.sendTimerCommand.mockResolvedValueOnce(
      timerOk(timerView(room.id, { version: 1_043 })),
    );
    fireEvent.click(button('Reset timer'));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, reset' }));
    await waitFor(() => {
      expect(world.client.sendTimerCommand).toHaveBeenCalledWith(room.id, {
        type: 'reset',
        expectedVersion: 1_042,
      });
    });
    expect(await screen.findByRole('button', { name: 'Start timer' })).not.toBeNull();
  });

  it('resets an idle timer without a question', async () => {
    const { world, room } = await openRoom();
    world.client.sendTimerCommand.mockResolvedValueOnce(
      timerOk(timerView(room.id, { version: 1_001 })),
    );
    fireEvent.click(button('Reset timer'));
    await waitFor(() => {
      expect(world.client.sendTimerCommand).toHaveBeenCalledWith(room.id, {
        type: 'reset',
        expectedVersion: 1_000,
      });
    });
    expect(screen.queryByRole('group', { name: 'Confirm reset' })).toBeNull();
  });

  it('switches phase with the shown version, asking first while running', async () => {
    const { world, room } = await openRoom({ timer: running({ version: 1_007 }) });
    expect(button('Focus').disabled).toBe(true);
    expect(button('Focus').getAttribute('aria-current')).toBe('true');

    fireEvent.click(button('Long break'));
    const group = screen.getByRole('group', { name: 'Confirm phase switch' });
    expect(within(group).getByText(/Switch to Long break\?/)).not.toBeNull();
    world.client.sendTimerCommand.mockResolvedValueOnce(
      timerOk(timerView(room.id, { phase: 'long_break', version: 1_008 })),
    );
    fireEvent.click(within(group).getByRole('button', { name: 'Yes, switch' }));
    await waitFor(() => {
      expect(world.client.sendTimerCommand).toHaveBeenCalledWith(room.id, {
        type: 'setPhase',
        phase: 'long_break',
        expectedVersion: 1_007,
      });
    });
    expect(await timerSection().findByText('Long break', { selector: 'p' })).not.toBeNull();
  });

  it('switches phase from idle without a question', async () => {
    const { world, room } = await openRoom();
    world.client.sendTimerCommand.mockResolvedValueOnce(
      timerOk(timerView(room.id, { phase: 'short_break', version: 1_001 })),
    );
    fireEvent.click(button('Short break'));
    await waitFor(() => {
      expect(world.client.sendTimerCommand).toHaveBeenCalledWith(room.id, {
        type: 'setPhase',
        phase: 'short_break',
        expectedVersion: 1_000,
      });
    });
  });
});

describe('the room timer: command failures', () => {
  const cases: Array<[string, RegExp]> = [
    ['NOT_HOST', /only the host can control the timer/],
    ['NOT_JOINED', /not connected to this room/],
    ['RATE_LIMITED', /too quickly/],
    ['TIMEOUT', /did not answer in time/],
    ['INTERNAL', /Something went wrong on the server/],
    ['VALIDATION_FAILED', /was not accepted/],
  ];
  it.each(cases)('explains %s inline and keeps the controls usable', async (code, text) => {
    const { world } = await openRoom();
    world.client.sendTimerCommand.mockResolvedValueOnce(
      code === 'TIMEOUT' ? ackFailure('TIMEOUT') : fail(code),
    );
    fireEvent.click(button('Start timer'));
    expect((await screen.findByRole('alert')).textContent).toMatch(text);
    expect(button('Start timer').disabled).toBe(false);
  });

  it('catches up from a version conflict and says so', async () => {
    const { world, room } = await openRoom({ timer: running({ version: 1_000 }) });
    world.client.sendTimerCommand.mockResolvedValueOnce(
      fail('VERSION_CONFLICT', {
        timer: timerView(room.id, { status: 'paused', elapsedBeforeMs: 60_000, version: 1_005 }),
        serverNowMs: Date.now(),
      }),
    );
    fireEvent.click(button('Reset timer'));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, reset' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The timer changed; here is the current state.',
    );
    expect(timerSection().getByText('Paused')).not.toBeNull();
    expect(button('Resume timer')).not.toBeNull();
    expect(world.client.sendTimerCommand).toHaveBeenCalledWith(room.id, {
      type: 'reset',
      expectedVersion: 1_000,
    });
  });

  it('catches up from an invalid transition, but never from an older state', async () => {
    const { world, room } = await openRoom({ timer: running({ version: 1_010 }) });
    world.client.sendTimerCommand.mockResolvedValueOnce(
      fail('INVALID_TRANSITION', {
        timer: timerView(room.id, { status: 'paused', version: 1_011 }),
        serverNowMs: Date.now(),
      }),
    );
    fireEvent.click(button('Pause timer'));
    expect((await screen.findByRole('alert')).textContent).toMatch(/not possible/);
    expect(timerSection().getByText('Paused')).not.toBeNull();

    world.client.sendTimerCommand.mockResolvedValueOnce(
      fail('INVALID_TRANSITION', {
        timer: timerView(room.id, { phase: 'long_break', version: 1_000 }),
        serverNowMs: Date.now(),
      }),
    );
    fireEvent.click(button('Resume timer'));
    await waitFor(() => {
      expect(world.client.sendTimerCommand).toHaveBeenCalledTimes(2);
    });
    expect(timerSection().queryByText('Long break', { selector: 'p' })).toBeNull();
  });

  it('refreshes from the snapshot once when the server holds a lower version (restored timer)', async () => {
    const { world, room } = await openRoom({ timer: running({ version: 10 }) });
    expect(world.client.joinRoom).toHaveBeenCalledTimes(1);
    world.client.joinRoom.mockImplementation(() =>
      Promise.resolve(joinOk(room, [ME], undefined, { status: 'paused', version: 3 })),
    );
    world.client.sendTimerCommand.mockResolvedValueOnce(
      fail('VERSION_CONFLICT', {
        timer: timerView(room.id, { status: 'paused', version: 3 }),
        serverNowMs: Date.now(),
      }),
    );
    fireEvent.click(button('Reset timer'));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, reset' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The timer was restored on the server; refreshing.',
    );
    await waitFor(() => {
      expect(timerSection().getByText('Paused')).not.toBeNull();
    });
    expect(world.client.joinRoom).toHaveBeenCalledTimes(2);
  });

  it('ignores malformed details and still shows the message', async () => {
    const { world } = await openRoom();
    world.client.sendTimerCommand.mockResolvedValueOnce(fail('INVALID_TRANSITION', { nope: 1 }));
    fireEvent.click(button('Start timer'));
    expect((await screen.findByRole('alert')).textContent).toMatch(/not possible/);
    expect(timerSection().getByText('Not started')).not.toBeNull();
  });
});

describe('the room timer: connection', () => {
  it('disables the host controls while reconnecting and restores the state after rejoining', async () => {
    const { world, room } = await openRoom();
    act(() => {
      world.client.setStatus('reconnecting');
    });
    expect(
      await timerSection().findByText(/Timer controls are paused while the room reconnects/),
    ).not.toBeNull();
    expect(button('Start timer').disabled).toBe(true);
    expect(button('Reset timer').disabled).toBe(true);
    expect(button('Short break').disabled).toBe(true);

    world.client.joinRoom.mockImplementation(() =>
      Promise.resolve(
        joinOk(room, [ME], undefined, {
          status: 'paused',
          elapsedBeforeMs: 600_000,
          version: 1_050,
        }),
      ),
    );
    act(() => {
      world.client.setStatus('connected');
    });
    expect(await timerSection().findByText('Paused')).not.toBeNull();
    expect(timerSection().queryByText(/while the room reconnects/)).toBeNull();
    expect(button('Resume timer').disabled).toBe(false);
  });

  it('says the user is offline when there is no connection at all', async () => {
    const { world } = await openRoom();
    act(() => {
      world.client.setStatus('idle');
    });
    expect(
      await timerSection().findByText(/No connection: timer controls are paused/),
    ).not.toBeNull();
    expect(button('Start timer').disabled).toBe(true);
  });
});

describe('the room timer: reaching zero', () => {
  it('shows "Finishing…" at 0:00 while the server still says running, never advancing the phase', async () => {
    let serverNow = 1_000_000;
    vi.spyOn(clock, 'serverNow').mockImplementation(() => serverNow);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { world, room } = await openRoom({
      timer: running({
        durationMs: 60_000,
        segmentStartedAtMs: serverNow,
        endsAtMs: serverNow + 60_000,
      }),
    });
    expect(timerSection().getByText('01:00')).not.toBeNull();
    expect(timerSection().queryByText(/Finishing/)).toBeNull();

    serverNow += 30_000;
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(timerSection().getByText('00:30')).not.toBeNull();

    serverNow += 31_000;
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(timerSection().getByText('00:00')).not.toBeNull();
    expect(timerSection().getByText('Finishing… waiting for the server')).not.toBeNull();
    // Still the server's phase and status; nothing was sent.
    expect(timerSection().getByText('Running')).not.toBeNull();
    expect(timerSection().getByText('Focus', { selector: 'p' })).not.toBeNull();
    expect(world.client.sendTimerCommand).not.toHaveBeenCalled();

    // The server's next state replaces it.
    push(world, room, { phase: 'short_break', version: 1_001, durationMs: 300_000 });
    expect(timerSection().getByText('Short break', { selector: 'p' })).not.toBeNull();
    expect(timerSection().queryByText(/Finishing/)).toBeNull();
  });

  it('asks the server again while it sits at 0:00, by rejoining', async () => {
    const serverNow = 1_000_000;
    vi.spyOn(clock, 'serverNow').mockImplementation(() => serverNow);
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
      shouldAdvanceTime: true,
    });
    const { world } = await openRoom({
      timer: running({
        durationMs: 60_000,
        segmentStartedAtMs: serverNow - 60_000,
        endsAtMs: serverNow,
      }),
    });
    expect(timerSection().getByText('Finishing… waiting for the server')).not.toBeNull();
    const before = world.client.joinRoom.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(world.client.joinRoom.mock.calls.length).toBe(before + 1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(world.client.joinRoom.mock.calls.length).toBe(before + 2);
  });
});

describe('the room timer: settings', () => {
  it('says changes apply from the next phase and applies them now with a reset', async () => {
    const { world, room } = await openRoom();
    const form = screen.getByRole('form', { name: 'Timer lengths' });
    expect(within(form).getByText(/Applies from the next phase/)).not.toBeNull();

    world.client.sendTimerCommand.mockResolvedValueOnce(
      timerOk(timerView(room.id, { version: 1_001 })),
    );
    fireEvent.click(button('Apply now (reset the timer)'));
    await waitFor(() => {
      expect(world.client.sendTimerCommand).toHaveBeenCalledWith(room.id, {
        type: 'reset',
        expectedVersion: 1_000,
      });
    });
  });

  it('asks before applying now to a timer that has run', async () => {
    const { world, room } = await openRoom({ timer: running({ version: 1_020 }) });
    fireEvent.click(button('Apply now (reset the timer)'));
    const group = screen.getByRole('group', { name: 'Confirm apply now' });
    expect(world.client.sendTimerCommand).not.toHaveBeenCalled();
    world.client.sendTimerCommand.mockResolvedValueOnce(
      timerOk(timerView(room.id, { version: 1_021 })),
    );
    fireEvent.click(within(group).getByRole('button', { name: 'Yes, apply now' }));
    await waitFor(() => {
      expect(world.client.sendTimerCommand).toHaveBeenCalledWith(room.id, {
        type: 'reset',
        expectedVersion: 1_020,
      });
    });
  });
});
