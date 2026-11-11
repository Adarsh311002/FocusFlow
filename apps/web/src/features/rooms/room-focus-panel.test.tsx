import {
  focusSessionIdSchema,
  focusSessionViewSchema,
  type TimerView,
} from '@focus-flow/contracts';
import { act, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { errorResponse, parsedBody, type RecordedRequest } from '../../test/api-stub';
import { fakeSession } from '../../test/fake-focus-session-api';
import { type FakeRoom, GRACE_ID, ME } from '../../test/fake-room-api';
import { focusParticipant, joinOk, NEXT_RUN_ID, RUN_ID } from '../../test/fake-room-client';
import { prepareRooms } from '../../test/room-route';
import { resetPendingRefresh } from '../auth/auth-client';
import { clearAccessToken } from '../auth/token-store';

configure({ asyncUtilTimeout: 6_000 });
// Rendering the whole room page and querying it by role is slow on a busy machine.
vi.setConfig({ testTimeout: 20_000 });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearAccessToken();
  resetPendingRefresh();
});

type World = ReturnType<typeof prepareRooms>;

type OpenOptions = {
  timer?: Partial<TimerView>;
  focus?: Parameters<typeof joinOk>[4];
  /** Runs before the page renders, to seed the fake API. */
  seed?: (world: World, room: FakeRoom) => void;
};

async function openRoom(options: OpenOptions = {}): Promise<{ world: World; room: FakeRoom }> {
  const world = prepareRooms();
  const room = world.api.addRoom({ name: 'Deep work', hostId: GRACE_ID, code: 'ABC234' });
  options.seed?.(world, room);
  world.client.joinRoom.mockImplementation(() =>
    Promise.resolve(joinOk(room, [ME], undefined, options.timer, options.focus)),
  );
  world.render(`/rooms/${room.id}`);
  await screen.findByRole('heading', { name: room.name });
  await screen.findByText('You are in the room.');
  return { world, room };
}

const panel = () => within(screen.getByRole('region', { name: 'Focus together' }));
const isFocusPost = (request: RecordedRequest) =>
  request.method === 'POST' && request.url.endsWith('/focus-participation');
const focusWrites = (world: World) =>
  world.calls.filter((call) => call.method !== 'GET' && call.url.endsWith('/focus-participation'));
const firstWrite = (world: World): RecordedRequest => {
  const [write] = focusWrites(world);
  if (write === undefined) {
    throw new Error('No focus-participation write was sent.');
  }
  return write;
};

// Each push is a later server state of the run: the version grows (G2); a snapshot starts at 0.
let pushedVersion = 0;

const pushParticipants = (world: World, room: FakeRoom, runId: string | null, ids: string[]) => {
  pushedVersion += 1;
  act(() => {
    world.client.push('room:focus:participants', {
      roomId: room.id,
      focusRunId: runId,
      participants: ids.map((id) => focusParticipant(id)),
      participantsVersion: runId === null ? 0 : pushedVersion,
    });
  });
};

const myParticipation = () => ({
  sessionId: focusSessionIdSchema.parse(crypto.randomUUID()),
  focusRunId: RUN_ID,
});

describe('Focus together: the panel', () => {
  it('explains that presence does not start a session, links to the timer and offers Join focus', async () => {
    await openRoom();
    const focus = panel();
    expect(focus.getByRole('heading', { name: 'Focus together' })).not.toBeNull();
    expect(focus.getByText(/does not start a focus session/)).not.toBeNull();
    expect(focus.getByText(/Focus · not started · 25:00 left/)).not.toBeNull();
    expect(focus.getByRole('link', { name: 'Go to the timer' }).getAttribute('href')).toBe(
      '#timer-heading',
    );
    expect(focus.getByRole('button', { name: 'Join focus' })).toHaveProperty('disabled', false);
    expect(focus.getByText('No one has joined this focus run yet.')).not.toBeNull();
    expect(focus.queryByRole('button', { name: 'Leave focus' })).toBeNull();
  });

  it('joins without a task by sending an empty body, then shows Leave focus', async () => {
    const { world } = await openRoom();
    fireEvent.click(panel().getByRole('button', { name: 'Join focus' }));

    expect(await panel().findByRole('button', { name: 'Leave focus' })).not.toBeNull();
    expect(focusWrites(world)).toHaveLength(1);
    expect(firstWrite(world).method).toBe('POST');
    expect(parsedBody(firstWrite(world))).toEqual({});
    expect(panel().getByText(/You are focusing with the room, 25 min planned\./)).not.toBeNull();
    expect(panel().queryByRole('button', { name: 'Join focus' })).toBeNull();
  });

  it('sends the chosen open task, and no task unless one is chosen', async () => {
    const world = prepareRooms();
    const task = world.api.addTask('Write the report');
    world.api.addTask('Review the code');
    const room = world.api.addRoom({ hostId: GRACE_ID, code: 'ABC234' });
    world.client.joinRoom.mockImplementation(() => Promise.resolve(joinOk(room, [ME])));
    world.render(`/rooms/${room.id}`);
    await screen.findByText('You are in the room.');

    const select = await panel().findByLabelText<HTMLSelectElement>(
      'Your task for this run (optional)',
    );
    await waitFor(() => {
      expect(within(select).getAllByRole('option')).toHaveLength(3);
    });
    expect(select.value).toBe('');
    fireEvent.change(select, { target: { value: task.id } });
    fireEvent.click(panel().getByRole('button', { name: 'Join focus' }));

    expect(await panel().findByRole('button', { name: 'Leave focus' })).not.toBeNull();
    expect(parsedBody(firstWrite(world))).toEqual({ taskId: task.id });
    expect(panel().getByText(/on “Write the report”/)).not.toBeNull();
  });

  it('disables every control while a request is pending and never sends a duplicate', async () => {
    const { world } = await openRoom();
    const release = world.hold(isFocusPost);
    const join = panel().getByRole('button', { name: 'Join focus' });
    fireEvent.click(join);
    fireEvent.click(join);
    fireEvent.submit(panel().getByRole('form', { name: 'Join the focus run' }));

    const pending = await panel().findByRole('button', { name: 'Joining…' });
    expect(pending).toHaveProperty('disabled', true);
    expect(panel().getByLabelText('Your task for this run (optional)')).toHaveProperty(
      'disabled',
      true,
    );
    expect(panel().getByText('Sending to the server…')).not.toBeNull();
    expect(focusWrites(world)).toHaveLength(1);

    release();
    expect(await panel().findByRole('button', { name: 'Leave focus' })).not.toBeNull();
    expect(focusWrites(world)).toHaveLength(1);
  });

  it('asks for confirmation before leaving, then explains the outcome from the server record', async () => {
    const { world } = await openRoom();
    fireEvent.click(panel().getByRole('button', { name: 'Join focus' }));
    fireEvent.click(await panel().findByRole('button', { name: 'Leave focus' }));

    const confirm = panel().getByRole('group', { name: 'Confirm leaving the focus run' });
    expect(within(confirm).getByText(/will not count as completed/)).not.toBeNull();
    // Keyboard: the confirming button already has focus.
    expect(document.activeElement).toBe(
      within(confirm).getByRole('button', { name: 'Yes, leave the focus run' }),
    );
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(focusWrites(world)).toHaveLength(1);

    fireEvent.click(panel().getByRole('button', { name: 'Leave focus' }));
    fireEvent.click(panel().getByRole('button', { name: 'Yes, leave the focus run' }));

    expect(await panel().findByText(/You left the focus run: 0 min recorded/)).not.toBeNull();
    expect(world.calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
    expect(await panel().findByRole('button', { name: 'Join focus' })).not.toBeNull();
    fireEvent.click(panel().getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => {
      expect(panel().queryByText(/You left the focus run/)).toBeNull();
    });
  });
});

describe('Focus together: refusals', () => {
  it.each([
    [409, 'RUN_CHANGED', /run changed/],
    [409, 'RUN_ENDING', /about to end/],
    [409, 'NOT_PRESENT', /in the room and connected/],
    [409, 'NOT_FOCUS_PHASE', /only join during a focus phase/],
    [409, 'SESSION_IN_PROGRESS', /already have a focus session/],
    [404, 'NOT_A_MEMBER', /not a member/],
    [503, 'INTERNAL', /changed nothing/],
  ] as const)(
    'shows %i %s in plain words and lets the person try again',
    async (status, code, pattern) => {
      const { world } = await openRoom();
      world.api.setOverride((request) =>
        isFocusPost(request) ? errorResponse(status, code, 'Server words.') : undefined,
      );
      fireEvent.click(panel().getByRole('button', { name: 'Join focus' }));

      expect((await panel().findByRole('alert')).textContent).toMatch(pattern);
      // Nothing is claimed locally: still not participating, and the person can retry.
      expect(panel().getByRole('button', { name: 'Join focus' })).toHaveProperty('disabled', false);
      expect(panel().queryByRole('button', { name: 'Leave focus' })).toBeNull();
    },
  );

  it('asks the server for a fresh snapshot when the run changed under the click', async () => {
    const { world } = await openRoom();
    const before = world.client.joinRoom.mock.calls.length;
    world.api.setOverride((request) =>
      isFocusPost(request) ? errorResponse(409, 'RUN_CHANGED') : undefined,
    );
    fireEvent.click(panel().getByRole('button', { name: 'Join focus' }));
    await panel().findByRole('alert');
    await waitFor(() => {
      expect(world.client.joinRoom.mock.calls.length).toBeGreaterThan(before);
    });
  });

  it('offers no join while another focus session of the person is known', async () => {
    const { world } = await openRoom({
      seed: (seeded, room) => {
        seeded.api.focus.other = { ...seeded.api.roomSession(room), context: { kind: 'solo' } };
      },
    });
    expect(
      await panel().findByText(/already have a focus session in progress on your own/),
    ).not.toBeNull();
    expect(panel().queryByRole('button', { name: 'Join focus' })).toBeNull();
    expect(world.calls.filter(isFocusPost)).toHaveLength(0);
  });
});

describe('Focus together: phases and connection', () => {
  it('offers no join during a break and says why', async () => {
    await openRoom({ timer: { phase: 'short_break', durationMs: 300_000 } });
    expect(
      panel().getByText(/The room is in a short break\. You can join the next focus phase/),
    ).not.toBeNull();
    expect(panel().queryByRole('button', { name: 'Join focus' })).toBeNull();
  });

  it('pauses joining while offline or reconnecting, with the reason in words', async () => {
    const { world } = await openRoom();
    act(() => {
      world.client.setStatus('reconnecting');
    });
    expect(await panel().findByText('Joining is paused while the room connects.')).not.toBeNull();
    expect(panel().getByRole('button', { name: 'Join focus' })).toHaveProperty('disabled', true);

    act(() => {
      world.client.setStatus('idle');
    });
    expect(await panel().findByText(/Joining needs a live connection/)).not.toBeNull();
    expect(panel().getByRole('button', { name: 'Join focus' })).toHaveProperty('disabled', true);
  });

  it('warns a disconnected participant about the minute of grace and still allows leaving', async () => {
    const { world } = await openRoom({
      focus: { participants: [focusParticipant(ME)], me: { participation: myParticipation() } },
      seed: (seeded, room) => {
        seeded.api.focus.session = seeded.api.roomSession(room);
        seeded.api.focus.participants = [seeded.api.focusParticipant()];
      },
    });
    expect(await panel().findByRole('button', { name: 'Leave focus' })).not.toBeNull();
    act(() => {
      world.client.setStatus('idle');
    });
    expect(
      await panel().findByText(/session ends if you stay away for about a minute/),
    ).not.toBeNull();
    // Leaving is a REST call and stays available.
    expect(panel().getByRole('button', { name: 'Leave focus' })).toHaveProperty('disabled', false);
  });

  it('shows the running phase read-only from the server timer', async () => {
    const now = Date.now();
    await openRoom({
      timer: { status: 'running', segmentStartedAtMs: now, endsAtMs: now + 600_000 },
    });
    expect(panel().getByText(/Focus · running · \d+:\d\d left/)).not.toBeNull();
  });
});

describe('Focus together: participants', () => {
  it('lists participants from the snapshot, marks the caller, and follows events by run id', async () => {
    const { world, room } = await openRoom({
      focus: { participants: [focusParticipant(GRACE_ID), focusParticipant(ME)] },
    });
    const list = panel().getByRole('list', { name: '2 people focusing together' });
    expect(within(list).getByText('Grace Hopper')).not.toBeNull();
    expect(within(list).getByText('(you)')).not.toBeNull();
    expect(within(list).getAllByText('Connected')).toHaveLength(2);

    pushParticipants(world, room, RUN_ID, [GRACE_ID]);
    expect(await panel().findByRole('list', { name: '1 person focusing together' })).not.toBeNull();

    // A new run starts empty; a late event of the old run cannot bring Grace back.
    pushParticipants(world, room, NEXT_RUN_ID, []);
    expect(await panel().findByText('No one has joined this focus run yet.')).not.toBeNull();
    pushParticipants(world, room, RUN_ID, [GRACE_ID]);
    expect(panel().getByText('No one has joined this focus run yet.')).not.toBeNull();
  });

  it('announces who joined and left in a polite live region', async () => {
    const { world, room } = await openRoom();
    pushParticipants(world, room, RUN_ID, [GRACE_ID]);
    const joined = await panel().findByText('Grace Hopper joined the focus run.');
    expect(joined.getAttribute('role')).toBe('status');
    expect(joined.getAttribute('aria-live')).toBe('polite');
    pushParticipants(world, room, RUN_ID, []);
    expect(await panel().findByText('Grace Hopper left the focus run.')).not.toBeNull();
  });

  it('shows a reconnecting participant with the grace left, display only', async () => {
    await openRoom({
      focus: {
        participants: [
          focusParticipant(GRACE_ID, { connected: false, disconnectedAtMs: Date.now() - 20_000 }),
          focusParticipant(ME),
        ],
      },
    });
    const text = panel().getByText(/Reconnecting — about \d+ s left before their session ends/);
    const seconds = Number(/about (\d+) s/.exec(text.textContent)?.[1]);
    expect(seconds).toBeGreaterThanOrEqual(38);
    expect(seconds).toBeLessThanOrEqual(41);
  });

  it('keeps showing the participant, waiting for the server, when the grace display reaches zero', async () => {
    await openRoom({
      focus: {
        participants: [
          focusParticipant(GRACE_ID, { connected: false, disconnectedAtMs: Date.now() - 90_000 }),
        ],
      },
    });
    expect(panel().getByText('Reconnecting — waiting for the server')).not.toBeNull();
    expect(panel().getByText('Grace Hopper')).not.toBeNull();
  });

  it('replaces the list from the snapshot after a resync', async () => {
    const { world, room } = await openRoom({
      focus: { participants: [focusParticipant(GRACE_ID)] },
    });
    expect(panel().getByText('Grace Hopper')).not.toBeNull();
    world.client.joinRoom.mockImplementation(() =>
      Promise.resolve(joinOk(room, [ME], undefined, undefined, { participants: [] })),
    );
    act(() => {
      world.client.push('room:resync', { roomId: room.id });
    });
    expect(await panel().findByText('No one has joined this focus run yet.')).not.toBeNull();
  });
});

describe('Focus together: restoring after a reload', () => {
  it('shows the person as focusing, with their task, from the snapshot and the REST read', async () => {
    await openRoom({
      focus: {
        participants: [focusParticipant(ME), focusParticipant(GRACE_ID)],
        me: { participation: myParticipation() },
      },
      seed: (seeded, room) => {
        const task = seeded.api.addTask('Write the report');
        seeded.api.focus.session = seeded.api.roomSession(room, {
          taskId: task.id,
          plannedSeconds: 900,
        });
      },
    });
    expect(
      await panel().findByText(
        /You are focusing with the room on “Write the report”, 15 min planned\./,
      ),
    ).not.toBeNull();
    expect(panel().getByRole('button', { name: 'Leave focus' })).not.toBeNull();
    expect(panel().queryByRole('button', { name: 'Join focus' })).toBeNull();
  });
});

describe('Focus together: what happened', () => {
  const ended = (room: FakeRoom, reason: string, roomId: string = room.id) =>
    focusSessionViewSchema.parse(
      fakeSession({
        context: { kind: 'room', roomId, focusRunId: RUN_ID },
        status: 'abandoned',
        abandonReason: reason as 'reset',
        focusedSeconds: 300,
        endedAt: '2026-03-09T10:05:00.000Z',
      }),
    );
  const lastEndedKey = ['focus-sessions', ME, 'last-ended'];

  it.each([
    ['reset', /host reset the timer.*5 min recorded/],
    ['phase_changed', /switched the timer to another phase.*5 min recorded/],
    ['removed', /removed from the room/],
    ['left_room', /You left the room/],
    ['grace_expired', /disconnected: 5 min recorded/],
    ['timer_lost', /No time was recorded/],
  ] as const)('explains %s from the session record', async (reason, pattern) => {
    const { world, room } = await openRoom();
    act(() => {
      world.queryClient.setQueryData(lastEndedKey, ended(room, reason));
    });
    expect((await panel().findByText(pattern)).closest('[role="status"]')).not.toBeNull();
  });

  it('shows the completed outcome and ignores the outcome of another room', async () => {
    const { world, room } = await openRoom();
    act(() => {
      world.queryClient.setQueryData(lastEndedKey, ended(room, 'reset', crypto.randomUUID()));
    });
    expect(panel().queryByText(/host reset the timer/)).toBeNull();
    act(() => {
      world.queryClient.setQueryData(
        lastEndedKey,
        focusSessionViewSchema.parse(
          fakeSession({ context: { kind: 'room', roomId: room.id, focusRunId: RUN_ID } }),
        ),
      );
    });
    expect(await panel().findByText(/Completed: you focused together for 25 min/)).not.toBeNull();
  });
});
