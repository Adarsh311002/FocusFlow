import { act, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { roomAckSchemas } from '../../features/realtime/room-events';
import { clock } from '../../lib/time-sync';
import { errorResponse, parsedBody } from '../../test/api-stub';
import { GRACE_ID, ME } from '../../test/fake-room-api';
import { ackFailure } from '../../test/fake-room-client';
import { prepareRooms } from '../../test/room-route';
import { resetPendingRefresh } from '../auth/auth-client';
import { clearAccessToken } from '../auth/token-store';

// The route tree loads lazily; in a busy full-suite run cold module loading can exceed the
// 1 s default of findBy*/waitFor, so the whole file waits longer (a passing wait returns at once).
configure({ asyncUtilTimeout: 4_000 });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearAccessToken();
  resetPendingRefresh();
});

const knockOk = (expiresAtMs: number) => roomAckSchemas.knock.parse({ ok: true, expiresAtMs });
const roomsGets = (calls: Array<{ url: string; method: string }>) =>
  calls.filter((call) => call.method === 'GET' && call.url.includes('/rooms?scope=mine'));

describe('the rooms list', () => {
  it('shows a loading state, then each room with its badges, code and present count', async () => {
    const world = prepareRooms();
    world.api.addRoom({ name: 'Morning sprint', code: 'ABC234', presentCount: 3 });
    world.api.addRoom({
      name: 'Quiet hours',
      isPrivate: true,
      hostId: GRACE_ID,
      code: 'DEF567',
      presentCount: 1,
    });
    const release = world.hold((request) => request.url.includes('/rooms?scope=mine'));
    world.render('/rooms');

    expect(await screen.findByText('Loading your rooms…')).not.toBeNull();
    release();

    const mine = await screen.findByRole('list', { name: 'My rooms' });
    const sprint = within(within(mine).getByRole('listitem', { name: 'Morning sprint' }));
    expect(sprint.getByText('Public')).not.toBeNull();
    expect(sprint.getByText('Host')).not.toBeNull();
    expect(sprint.getByText('ABC234')).not.toBeNull();
    expect(sprint.getByText('3 present')).not.toBeNull();
    expect(sprint.getByRole('link', { name: 'Morning sprint' })).not.toBeNull();

    const quiet = within(within(mine).getByRole('listitem', { name: 'Quiet hours' }));
    expect(quiet.getByText('Private')).not.toBeNull();
    expect(quiet.queryByText('Host')).toBeNull();
    expect(quiet.getByText('1 present')).not.toBeNull();
  });

  it('says so when the user has no rooms', async () => {
    const world = prepareRooms();
    world.render('/rooms');
    expect(await screen.findByText(/You are not in any rooms yet/)).not.toBeNull();
  });

  it('shows an error with a retry that loads the list', async () => {
    const world = prepareRooms();
    world.api.addRoom({ name: 'Morning sprint' });
    let fail = true;
    world.api.setOverride((request) =>
      fail && request.url.includes('/rooms?scope=mine')
        ? errorResponse(500, 'INTERNAL', 'Boom.')
        : undefined,
    );
    world.render('/rooms');

    expect(await screen.findByText(/Something went wrong on the server/)).not.toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: 'Morning sprint' })).not.toBeNull();
    expect(screen.queryByText(/Something went wrong on the server/)).toBeNull();
  });

  it('shows how many people are waiting on a hosted private room, from knock events', async () => {
    const world = prepareRooms();
    const room = world.api.addRoom({ name: 'Quiet hours', isPrivate: true });
    world.render('/rooms');
    const item = await screen.findByRole('listitem', { name: 'Quiet hours' });
    expect(within(item).queryByText(/waiting to join/)).toBeNull();

    world.client.push('room:knock:received', {
      roomId: room.id,
      requester: { userId: GRACE_ID, displayName: 'Grace Hopper', avatarUrl: null },
      expiresAtMs: Date.now() + 60_000,
    });
    expect(await within(item).findByText('1 waiting to join')).not.toBeNull();

    world.client.push('room:knock:removed', {
      roomId: room.id,
      userId: GRACE_ID,
      reason: 'cancelled',
    });
    await waitFor(() => {
      expect(within(item).queryByText(/waiting to join/)).toBeNull();
    });
  });
});

describe('creating a room', () => {
  it('sends the trimmed name, privacy and timer lengths in seconds, then opens the room', async () => {
    const world = prepareRooms();
    world.render('/rooms');
    await screen.findByText(/You are not in any rooms yet/);

    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: '  Study group  ' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Private/ }));
    fireEvent.change(screen.getByLabelText('Focus (minutes)'), { target: { value: '50' } });
    fireEvent.change(screen.getByLabelText('Short break (minutes)'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create room' }));

    expect(await screen.findByRole('heading', { name: 'Study group' })).not.toBeNull();
    const post = world.calls.find((call) => call.method === 'POST' && call.url.endsWith('/rooms'));
    expect(post).toBeDefined();
    expect(parsedBody(post!)).toEqual({
      name: 'Study group',
      isPrivate: true,
      timerSettings: { focusSeconds: 3_000, shortBreakSeconds: 600, longBreakSeconds: 900 },
    });
  });

  it('starts from the 25 / 5 / 15 minute defaults', async () => {
    const world = prepareRooms();
    world.render('/rooms');
    await screen.findByText(/You are not in any rooms yet/);
    expect(screen.getByLabelText<HTMLInputElement>('Focus (minutes)').value).toBe('25');
    expect(screen.getByLabelText<HTMLInputElement>('Short break (minutes)').value).toBe('5');
    expect(screen.getByLabelText<HTMLInputElement>('Long break (minutes)').value).toBe('15');
  });

  it('refuses an empty name, an over-long name and out-of-range minutes without calling the API', async () => {
    const world = prepareRooms();
    world.render('/rooms');
    await screen.findByText(/You are not in any rooms yet/);
    const create = () => screen.getByRole('button', { name: 'Create room' });
    const posts = () =>
      world.calls.filter((call) => call.method === 'POST' && call.url.endsWith('/rooms'));

    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: '   ' } });
    fireEvent.click(create());
    expect((await screen.findByRole('alert')).textContent).toMatch(/room name of 1 to 60/);

    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: 'x'.repeat(61) } });
    fireEvent.click(create());
    expect((await screen.findByRole('alert')).textContent).toMatch(/room name of 1 to 60/);

    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: 'Ok' } });
    fireEvent.change(screen.getByLabelText('Focus (minutes)'), { target: { value: '241' } });
    fireEvent.click(create());
    expect((await screen.findByRole('alert')).textContent).toMatch(/whole minutes from 1 to 240/);

    fireEvent.change(screen.getByLabelText('Focus (minutes)'), { target: { value: '1.5' } });
    fireEvent.click(create());
    expect((await screen.findByRole('alert')).textContent).toMatch(/whole minutes/);
    expect(posts()).toHaveLength(0);
  });

  it('shows the server error and stays on the page', async () => {
    const world = prepareRooms();
    world.api.setOverride((request) =>
      request.method === 'POST' && request.url.endsWith('/rooms')
        ? errorResponse(429, 'RATE_LIMITED', 'Slow down.')
        : undefined,
    );
    world.render('/rooms');
    await screen.findByText(/You are not in any rooms yet/);
    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: 'Study group' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create room' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/too often/);
    expect(screen.getByRole('heading', { name: 'Create a room' })).not.toBeNull();
  });
});

describe('joining by code', () => {
  async function find(world: ReturnType<typeof prepareRooms>, typed: string) {
    world.render('/rooms');
    await screen.findByText(/You are not in any rooms yet|My rooms/);
    fireEvent.change(screen.getByLabelText('Room code'), { target: { value: typed } });
    fireEvent.click(screen.getByRole('button', { name: 'Find room' }));
  }

  it('forgives case and spaces and looks the room up by its normalised code', async () => {
    const world = prepareRooms();
    world.api.addRoom({ name: 'Open desk', hostId: GRACE_ID, code: 'ABC234', meIsMember: false });
    await find(world, ' abc 234 ');
    await screen.findByRole('group', { name: 'Room found' });
    expect(world.calls.some((call) => call.url.endsWith('/rooms/by-code/ABC234'))).toBe(true);
  });

  it('offers "Open room" to the host and to a member', async () => {
    const world = prepareRooms();
    world.api.addRoom({ name: 'Mine', code: 'ABC234' });
    world.api.addRoom({ name: 'Theirs', hostId: GRACE_ID, code: 'DEF567' });
    await find(world, 'ABC234');
    const hostCard = await screen.findByRole('group', { name: 'Room found' });
    expect(within(hostCard).getByRole('link', { name: 'Open room' })).not.toBeNull();

    fireEvent.change(screen.getByLabelText('Room code'), { target: { value: 'DEF567' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find room' }));
    await waitFor(() => {
      expect(
        within(screen.getByRole('group', { name: 'Room found' })).getByText('Theirs'),
      ).not.toBeNull();
    });
    expect(screen.getByRole('link', { name: 'Open room' })).not.toBeNull();
  });

  it('joins a public room (POST membership) and opens it', async () => {
    const world = prepareRooms();
    const room = world.api.addRoom({
      name: 'Open desk',
      hostId: GRACE_ID,
      code: 'ABC234',
      meIsMember: false,
    });
    await find(world, 'ABC234');
    fireEvent.click(await screen.findByRole('button', { name: 'Join room' }));

    expect(await screen.findByRole('heading', { name: 'Open desk' })).not.toBeNull();
    expect(
      world.calls.some(
        (call) => call.method === 'POST' && call.url.endsWith(`/rooms/${room.id}/membership`),
      ),
    ).toBe(true);
    expect(room.members.some((member) => member.userId === ME)).toBe(true);
  });

  it('says what happened when joining fails', async () => {
    const world = prepareRooms();
    world.api.addRoom({ name: 'Open desk', hostId: GRACE_ID, code: 'ABC234', meIsMember: false });
    world.api.setOverride((request) =>
      request.url.endsWith('/membership') ? errorResponse(409, 'ROOM_FULL', 'Full.') : undefined,
    );
    await find(world, 'ABC234');
    fireEvent.click(await screen.findByRole('button', { name: 'Join room' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/room is full/);
  });

  it('explains an unknown code and a malformed one', async () => {
    const world = prepareRooms();
    await find(world, 'ZZZ999');
    expect((await screen.findByRole('alert')).textContent).toMatch(/No room was found/);

    fireEvent.change(screen.getByLabelText('Room code'), { target: { value: 'ab1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find room' }));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/6 letters and numbers/);
    });
    expect(screen.queryByRole('group', { name: 'Room found' })).toBeNull();
  });
});

describe('asking to join a private room', () => {
  async function toKnockCard() {
    const world = prepareRooms();
    const room = world.api.addRoom({
      name: 'Quiet hours',
      isPrivate: true,
      hostId: GRACE_ID,
      code: 'ABC234',
      meIsMember: false,
    });
    world.render('/rooms');
    await screen.findByText(/You are not in any rooms yet/);
    fireEvent.change(screen.getByLabelText('Room code'), { target: { value: 'ABC234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find room' }));
    await screen.findByRole('button', { name: 'Ask to join' });
    return { world, room };
  }

  it('knocks over the socket, waits, and can cancel', async () => {
    const { world, room } = await toKnockCard();
    world.client.knockRoom.mockResolvedValue(knockOk(Date.now() + 60_000));
    fireEvent.click(screen.getByRole('button', { name: 'Ask to join' }));

    expect(await screen.findByText('Waiting for the host to answer…')).not.toBeNull();
    expect(world.client.knockRoom).toHaveBeenCalledWith(room.id);
    expect(screen.queryByRole('button', { name: 'Ask to join' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
    expect(await screen.findByRole('button', { name: 'Ask to join' })).not.toBeNull();
    expect(world.client.cancelKnock).toHaveBeenCalledWith(room.id);
    expect(screen.queryByText('Waiting for the host to answer…')).toBeNull();
  });

  it('opens the room when the host approves', async () => {
    const { world, room } = await toKnockCard();
    world.client.knockRoom.mockResolvedValue(knockOk(Date.now() + 60_000));
    fireEvent.click(screen.getByRole('button', { name: 'Ask to join' }));
    await screen.findByText('Waiting for the host to answer…');

    // The host's approval makes this user a member; the event tells their browser.
    room.members.push({
      userId: ME,
      displayName: 'Ada Lovelace',
      joinedAt: new Date().toISOString(),
      isHost: false,
    });
    world.client.push('room:knock:resolved', { roomId: room.id, outcome: 'approved' });

    expect(await screen.findByRole('heading', { name: 'Quiet hours' })).not.toBeNull();
    expect(screen.getByText('Leave room', { selector: 'button' })).not.toBeNull();
  });

  it('tells the requester when the host declines, and lets them try again', async () => {
    const { world, room } = await toKnockCard();
    world.client.knockRoom.mockResolvedValue(knockOk(Date.now() + 60_000));
    fireEvent.click(screen.getByRole('button', { name: 'Ask to join' }));
    await screen.findByText('Waiting for the host to answer…');

    world.client.push('room:knock:resolved', { roomId: room.id, outcome: 'rejected' });
    expect(await screen.findByText('The host declined your request.')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).not.toBeNull();
  });

  it('shows an expiry message and re-checks access when the knock runs out', async () => {
    // The server clock is under the test's control and only the one-second tick is faked; both
    // are in place before the page renders, because the hook samples the clock on mount.
    let serverNow = 1_000_000;
    vi.spyOn(clock, 'serverNow').mockImplementation(() => serverNow);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { world } = await toKnockCard();
    world.client.knockRoom.mockResolvedValue(knockOk(serverNow + 5_000));
    const lookups = () => world.calls.filter((call) => call.url.includes('/rooms/by-code/')).length;
    const before = lookups();
    fireEvent.click(screen.getByRole('button', { name: 'Ask to join' }));
    await screen.findByText('Waiting for the host to answer…');

    serverNow += 5_001;
    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(
      await screen.findByText('Your request expired before the host answered.'),
    ).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).not.toBeNull();
    await waitFor(() => {
      expect(lookups()).toBeGreaterThan(before);
    });
  });

  it.each([
    ['HOST_OFFLINE', /host is not online right now/],
    ['RATE_LIMITED', /too often/],
    ['ROOM_FULL', /room is full/],
    ['OFFLINE', /You are offline/],
  ] as const)('shows a human message for %s', async (code, pattern) => {
    const { world } = await toKnockCard();
    world.client.knockRoom.mockResolvedValue(ackFailure(code));
    fireEvent.click(screen.getByRole('button', { name: 'Ask to join' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(pattern);
    expect(screen.getByRole('button', { name: 'Ask to join' })).not.toBeNull();
  });

  it('re-checks access when the server says the user is already a member', async () => {
    const { world, room } = await toKnockCard();
    room.members.push({
      userId: ME,
      displayName: 'Ada Lovelace',
      joinedAt: new Date().toISOString(),
      isHost: false,
    });
    world.client.knockRoom.mockResolvedValue(ackFailure('ALREADY_MEMBER'));
    fireEvent.click(screen.getByRole('button', { name: 'Ask to join' }));
    expect(await screen.findByRole('link', { name: 'Open room' })).not.toBeNull();
  });
});

describe('the Rooms navigation', () => {
  it('has a Rooms link in the shell', async () => {
    const world = prepareRooms();
    world.render('/rooms');
    await screen.findByText(/You are not in any rooms yet/);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Rooms' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(roomsGets(world.calls).length).toBeGreaterThan(0);
  });
});
