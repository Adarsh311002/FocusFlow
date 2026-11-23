import { act, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { clock } from '../../lib/time-sync';
import { parsedBody, type RecordedRequest } from '../../test/api-stub';
import { type FakeRoom, GRACE_ID, LINUS_ID, ME } from '../../test/fake-room-api';
import { ackFailure, joinOk } from '../../test/fake-room-client';
import { prepareRooms } from '../../test/room-route';
import { resetPendingRefresh } from '../auth/auth-client';
import { clearAccessToken } from '../auth/token-store';
import { roomAckSchemas } from '../realtime/room-events';

// The route tree loads lazily; in a busy full-suite run cold module loading can exceed the
// 1 s default of findBy*/waitFor, so the whole file waits longer (a passing wait returns at once).
configure({ asyncUtilTimeout: 4_000 });

/** Lets pending promises, renders and request dispatches run before a "nothing happened" check. */
const settle = () =>
  act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearAccessToken();
  resetPendingRefresh();
});

type World = ReturnType<typeof prepareRooms>;

/** Opens a room page whose join is answered with the given presence (default: just me). */
async function openRoom(
  options: {
    hostId?: string;
    isPrivate?: boolean;
    memberIds?: string[];
    present?: string[];
    knocks?: Array<{ userId: string; expiresAtMs: number }>;
    name?: string;
  } = {},
): Promise<{ world: World; room: FakeRoom }> {
  const world = prepareRooms();
  const room = world.api.addRoom({
    name: options.name ?? 'Deep work',
    hostId: options.hostId ?? ME,
    isPrivate: options.isPrivate ?? false,
    memberIds: options.memberIds ?? [GRACE_ID],
    code: 'ABC234',
  });
  world.client.joinRoom.mockImplementation(() =>
    Promise.resolve(joinOk(room, options.present ?? [ME], options.knocks)),
  );
  world.render(`/rooms/${room.id}`);
  await screen.findByRole('heading', { name: room.name });
  return { world, room };
}

const sentAck = (messageId = crypto.randomUUID()) =>
  roomAckSchemas.chat.parse({ ok: true, messageId, sentAtMs: Date.now() });

const members = () => within(screen.getByRole('list', { name: 'Members' }));
const memberRow = (name: string) => within(members().getByRole('listitem', { name }));
const requests = (world: World, method: string, suffix: string): RecordedRequest[] =>
  world.calls.filter((call) => call.method === method && call.url.endsWith(suffix));

function chatMessage(room: FakeRoom, fromId: string, body: string, ids = {}) {
  return {
    roomId: room.id,
    messageId: crypto.randomUUID(),
    clientMessageId: crypto.randomUUID(),
    sender: { userId: fromId, displayName: fromId === GRACE_ID ? 'Grace Hopper' : 'Someone' },
    body,
    sentAtMs: Date.now(),
    ...ids,
  };
}

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe('the room page: snapshot and presence', () => {
  it('shows the room, its code, privacy, members and who is here from the snapshot', async () => {
    const { world, room } = await openRoom({ present: [ME, GRACE_ID] });
    expect(await screen.findByText('You are in the room.')).not.toBeNull();
    expect(screen.getByText('Public')).not.toBeNull();
    expect(screen.getByText('ABC234')).not.toBeNull();
    expect(world.client.joinRoom).toHaveBeenCalledWith(room.id);
    await screen.findByRole('list', { name: 'Members' });
    expect(memberRow('Ada Lovelace').getByText('Host')).not.toBeNull();
    expect(memberRow('Ada Lovelace').getByText('Here now')).not.toBeNull();
    expect(memberRow('Grace Hopper').getByText('Here now')).not.toBeNull();
    expect(screen.getByText('2 here now')).not.toBeNull();
  });

  it('marks members who are not in the room as not here', async () => {
    await openRoom({ present: [ME] });
    await screen.findByRole('list', { name: 'Members' });
    expect(memberRow('Grace Hopper').getByText('Not here')).not.toBeNull();
  });

  it('follows presence events and shows a person once however many tabs they have', async () => {
    const { world, room } = await openRoom();
    await screen.findByRole('list', { name: 'Members' });
    const joined = {
      roomId: room.id,
      user: { userId: GRACE_ID, displayName: 'Grace Hopper', avatarUrl: null },
    };

    act(() => {
      world.client.push('room:presence:joined', joined);
      world.client.push('room:presence:joined', joined);
    });
    expect(screen.getByText('2 here now')).not.toBeNull();
    expect(memberRow('Grace Hopper').getByText('Here now')).not.toBeNull();

    act(() => {
      world.client.push('room:presence:left', { roomId: room.id, userId: GRACE_ID });
    });
    expect(screen.getByText('1 here now')).not.toBeNull();
    expect(memberRow('Grace Hopper').getByText('Not here')).not.toBeNull();
  });

  it("ignores another room's events", async () => {
    const { world } = await openRoom();
    await screen.findByRole('list', { name: 'Members' });
    act(() => {
      world.client.push('room:presence:joined', {
        roomId: crypto.randomUUID(),
        user: { userId: LINUS_ID, displayName: 'Linus Torvalds', avatarUrl: null },
      });
      world.client.push('room:chat:message', {
        ...chatMessage({ id: crypto.randomUUID() } as FakeRoom, LINUS_ID, 'elsewhere'),
      });
    });
    expect(screen.getByText('1 here now')).not.toBeNull();
    expect(screen.queryByText('elsewhere')).toBeNull();
  });

  it('refetches the member list when a member joins', async () => {
    const { world, room } = await openRoom({ memberIds: [] });
    await screen.findByRole('list', { name: 'Members' });
    room.members.push({
      userId: GRACE_ID,
      displayName: 'Grace Hopper',
      joinedAt: new Date().toISOString(),
      isHost: false,
    });
    act(() => {
      world.client.push('room:member:joined', {
        roomId: room.id,
        member: {
          userId: GRACE_ID,
          displayName: 'Grace Hopper',
          avatarUrl: null,
          joinedAt: new Date().toISOString(),
          isHost: false,
        },
      });
    });
    expect(await members().findByRole('listitem', { name: 'Grace Hopper' })).not.toBeNull();
  });

  it('shows a not-a-member page with a way back when the server refuses the join', async () => {
    const world = prepareRooms();
    const room = world.api.addRoom({ hostId: GRACE_ID, name: 'Deep work' });
    world.client.joinRoom.mockResolvedValue(ackFailure('NOT_A_MEMBER'));
    world.render(`/rooms/${room.id}`);

    expect(await screen.findByRole('heading', { name: 'You are not a member' })).not.toBeNull();
    expect(screen.getByRole('link', { name: 'Back to my rooms' })).not.toBeNull();
    expect(screen.queryByRole('log', { name: 'Chat messages' })).toBeNull();
  });

  it('shows "not available" with a way back for a room the server does not show', async () => {
    const world = prepareRooms();
    world.render(`/rooms/${crypto.randomUUID()}`);
    expect(await screen.findByRole('heading', { name: 'Room not available' })).not.toBeNull();
    expect(screen.getByRole('link', { name: 'Back to my rooms' })).not.toBeNull();
    expect(world.client.joinRoom).not.toHaveBeenCalled();
  });

  it('shows "not available" for an address that is not a room id', async () => {
    const world = prepareRooms();
    world.render('/rooms/not-a-room');
    expect(await screen.findByRole('heading', { name: 'Room not available' })).not.toBeNull();
  });
});

describe('the room page: joining over the socket', () => {
  it('shows offline and reconnecting states and rejoins on every reconnect', async () => {
    const { world, room } = await openRoom();
    await screen.findByText('You are in the room.');
    expect(world.client.joinRoom).toHaveBeenCalledTimes(1);

    act(() => {
      world.client.setStatus('reconnecting');
    });
    expect(await screen.findByText(/Reconnecting — the room will be rejoined/)).not.toBeNull();
    expect(screen.getByLabelText('Message')).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', true);
    expect(screen.getByText(/Chat is unavailable until the room is connected/)).not.toBeNull();

    // The new snapshot replaces what the events had built up.
    world.client.joinRoom.mockImplementation(() => Promise.resolve(joinOk(room, [ME, GRACE_ID])));
    act(() => {
      world.client.setStatus('connected');
    });
    expect(await screen.findByText('2 here now')).not.toBeNull();
    expect(world.client.joinRoom).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText('Message')).toHaveProperty('disabled', false);

    act(() => {
      world.client.setStatus('idle');
    });
    expect(await screen.findByText(/You are offline/)).not.toBeNull();
    act(() => {
      world.client.setStatus('connected');
    });
    await waitFor(() => {
      expect(world.client.joinRoom).toHaveBeenCalledTimes(3);
    });
  });

  it('rejoins after room:resync, only for its own room', async () => {
    const { world, room } = await openRoom();
    await screen.findByText('You are in the room.');
    act(() => {
      world.client.push('room:resync', { roomId: crypto.randomUUID() });
    });
    expect(world.client.joinRoom).toHaveBeenCalledTimes(1);

    world.client.joinRoom.mockImplementation(() => Promise.resolve(joinOk(room, [ME, GRACE_ID])));
    act(() => {
      world.client.push('room:resync', { roomId: room.id });
    });
    expect(await screen.findByText('2 here now')).not.toBeNull();
    expect(world.client.joinRoom).toHaveBeenCalledTimes(2);
  });

  it('ignores a join answer that arrives after a reconnect already rejoined', async () => {
    const world = prepareRooms();
    const room = world.api.addRoom({ name: 'Deep work', memberIds: [GRACE_ID] });
    let answerStale: (ack: ReturnType<typeof joinOk>) => void = () => undefined;
    world.client.joinRoom.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answerStale = resolve;
        }),
    );
    world.client.joinRoom.mockImplementation(() => Promise.resolve(joinOk(room, [ME, GRACE_ID])));
    world.render(`/rooms/${room.id}`);
    await screen.findByRole('heading', { name: room.name });
    await waitFor(() => {
      expect(world.client.joinRoom).toHaveBeenCalledTimes(1);
    });

    act(() => {
      world.client.setStatus('reconnecting');
    });
    act(() => {
      world.client.setStatus('connected');
    });
    expect(await screen.findByText('2 here now')).not.toBeNull();

    // The answer to the request sent before the reconnect shows up late, with older presence.
    await act(async () => {
      answerStale(joinOk(room, [ME]));
      await Promise.resolve();
    });
    await settle();
    expect(screen.getByText('2 here now')).not.toBeNull();
  });

  it('shows a failed join with a retry', async () => {
    const world = prepareRooms();
    const room = world.api.addRoom({ name: 'Deep work' });
    world.client.joinRoom.mockResolvedValueOnce(ackFailure('ROOM_FULL'));
    world.client.joinRoom.mockImplementation(() => Promise.resolve(joinOk(room, [ME])));
    world.render(`/rooms/${room.id}`);

    expect(await screen.findByText(/This room is full right now/)).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try joining again' }));
    expect(await screen.findByText('You are in the room.')).not.toBeNull();
  });
});

describe('room chat', () => {
  it('sends a trimmed message with a client id, shows it as sent, and counts characters', async () => {
    const { world, room } = await openRoom();
    await screen.findByText('You are in the room.');
    world.client.sendChat.mockResolvedValue(sentAck());

    type('Message', '  hello team  ');
    expect(screen.getByText('14 / 1000')).not.toBeNull();
    fireEvent.submit(screen.getByRole('form', { name: 'Send a message' }));

    const log = within(screen.getByRole('log', { name: 'Chat messages' }));
    expect(await log.findByText('hello team')).not.toBeNull();
    await waitFor(() => {
      expect(log.queryByText('Sending…')).toBeNull();
    });
    expect(world.client.sendChat).toHaveBeenCalledTimes(1);
    const [roomId, clientMessageId, body] = world.client.sendChat.mock.calls[0] ?? [];
    expect(roomId).toBe(room.id);
    expect(clientMessageId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(body).toBe('hello team');
    expect(screen.getByLabelText<HTMLInputElement>('Message').value).toBe('');
  });

  it('refuses an empty message without sending', async () => {
    const { world } = await openRoom();
    await screen.findByText('You are in the room.');
    type('Message', '   ');
    fireEvent.submit(screen.getByRole('form', { name: 'Send a message' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/1 to 1000 characters/);
    expect(world.client.sendChat).not.toHaveBeenCalled();
  });

  it("shows other people's messages and the temporary-chat note", async () => {
    const { world, room } = await openRoom();
    await screen.findByText('You are in the room.');
    expect(screen.getByText(/Messages are temporary/)).not.toBeNull();
    expect(screen.getByRole('log', { name: 'Chat messages' }).getAttribute('aria-live')).toBe(
      'polite',
    );
    act(() => {
      world.client.push('room:chat:message', chatMessage(room, GRACE_ID, 'hi from grace'));
    });
    const log = within(screen.getByRole('log', { name: 'Chat messages' }));
    expect(log.getByText('hi from grace')).not.toBeNull();
    expect(log.getByText('Grace Hopper')).not.toBeNull();
  });

  it('shows my own message once when the server echoes it, and once for a repeated delivery', async () => {
    const { world, room } = await openRoom();
    await screen.findByText('You are in the room.');
    const messageId = crypto.randomUUID();
    world.client.sendChat.mockResolvedValue(sentAck(messageId));

    type('Message', 'only once');
    fireEvent.submit(screen.getByRole('form', { name: 'Send a message' }));
    await waitFor(() => {
      expect(world.client.sendChat).toHaveBeenCalled();
    });
    const clientMessageId = world.client.sendChat.mock.calls[0]?.[1] ?? '';
    const echo = chatMessage(room, ME, 'only once', { messageId, clientMessageId });
    act(() => {
      world.client.push('room:chat:message', echo);
      world.client.push('room:chat:message', echo);
      // The same message arriving under another client id is still the same message.
      world.client.push('room:chat:message', { ...echo, clientMessageId: crypto.randomUUID() });
    });
    const log = within(screen.getByRole('log', { name: 'Chat messages' }));
    expect(log.getAllByText('only once')).toHaveLength(1);
  });

  it('marks a failed message and retries it with the same client message id', async () => {
    const { world } = await openRoom();
    await screen.findByText('You are in the room.');
    world.client.sendChat.mockResolvedValueOnce(ackFailure('TIMEOUT'));
    world.client.sendChat.mockResolvedValueOnce(sentAck());

    type('Message', 'try me');
    fireEvent.submit(screen.getByRole('form', { name: 'Send a message' }));
    const log = within(screen.getByRole('log', { name: 'Chat messages' }));
    expect(await log.findByText(/Not sent\./)).not.toBeNull();

    fireEvent.click(log.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(world.client.sendChat).toHaveBeenCalledTimes(2);
    });
    const [first, second] = world.client.sendChat.mock.calls;
    expect(second?.[1]).toBe(first?.[1]);
    expect(second?.[2]).toBe('try me');
    await waitFor(() => {
      expect(log.queryByText(/Not sent\./)).toBeNull();
    });
    expect(log.getAllByText('try me')).toHaveLength(1);
  });

  it.each([
    ['RATE_LIMITED', /too often/],
    ['NOT_JOINED', /not connected to this room/],
  ] as const)('explains %s on a message that was refused', async (code, pattern) => {
    const { world } = await openRoom();
    await screen.findByText('You are in the room.');
    world.client.sendChat.mockResolvedValue(ackFailure(code));
    type('Message', 'nope');
    fireEvent.submit(screen.getByRole('form', { name: 'Send a message' }));
    const log = within(screen.getByRole('log', { name: 'Chat messages' }));
    expect((await log.findByText(/Not sent\./)).textContent).toMatch(pattern);
  });

  it('keeps at most 200 messages', async () => {
    const { world, room } = await openRoom();
    await screen.findByText('You are in the room.');
    act(() => {
      for (let index = 0; index < 205; index += 1) {
        world.client.push(
          'room:chat:message',
          chatMessage(room, GRACE_ID, `message ${String(index)}`),
        );
      }
    });
    const log = within(screen.getByRole('log', { name: 'Chat messages' }));
    expect(log.getAllByRole('listitem')).toHaveLength(200);
    expect(log.queryByText('message 0')).toBeNull();
    expect(log.getByText('message 204')).not.toBeNull();
  });
});

describe('host controls', () => {
  it('shows the host the members, timer settings and (for a private room) join requests', async () => {
    await openRoom({ isPrivate: true });
    await screen.findByRole('list', { name: 'Members' });
    expect(screen.getByRole('button', { name: 'Remove Grace Hopper' })).not.toBeNull();
    expect(screen.getByRole('form', { name: 'Timer lengths' })).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Join requests' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Leave permanently' })).toBeNull();
  });

  it('shows a member none of the host controls', async () => {
    await openRoom({ hostId: GRACE_ID, memberIds: [], isPrivate: true });
    await screen.findByRole('list', { name: 'Members' });
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Timer lengths' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Join requests' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Leave room' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Leave permanently' })).not.toBeNull();
  });

  it('approves a knock from the snapshot over REST and drops the entry', async () => {
    const { world, room } = await openRoom({
      isPrivate: true,
      memberIds: [],
      knocks: [{ userId: LINUS_ID, expiresAtMs: Date.now() + 60_000 }],
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Approve Linus Torvalds' }));
    await waitFor(() => {
      expect(requests(world, 'POST', `/rooms/${room.id}/knocks/${LINUS_ID}/approve`)).toHaveLength(
        1,
      );
    });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Approve Linus Torvalds' })).toBeNull();
    });
    expect(screen.getByText('No one is waiting to join.')).not.toBeNull();
  });

  it('rejects a knock that arrived as an event, and drops entries on knock:removed or expiry', async () => {
    const { world, room } = await openRoom({ isPrivate: true, memberIds: [] });
    await screen.findByText('No one is waiting to join.');
    act(() => {
      world.client.push('room:knock:received', {
        roomId: room.id,
        requester: { userId: GRACE_ID, displayName: 'Grace Hopper', avatarUrl: null },
        expiresAtMs: Date.now() + 60_000,
      });
      world.client.push('room:knock:received', {
        roomId: room.id,
        requester: { userId: LINUS_ID, displayName: 'Linus Torvalds', avatarUrl: null },
        expiresAtMs: Date.now() + 60_000,
      });
      world.client.push('room:knock:received', {
        roomId: room.id,
        requester: { userId: crypto.randomUUID(), displayName: 'Late Larry', avatarUrl: null },
        expiresAtMs: Date.now() - 1_000,
      });
    });
    expect(screen.queryByText('Late Larry')).toBeNull();
    expect(screen.getByRole('button', { name: 'Reject Grace Hopper' })).not.toBeNull();

    act(() => {
      world.client.push('room:knock:removed', {
        roomId: room.id,
        userId: LINUS_ID,
        reason: 'cancelled',
      });
    });
    expect(screen.queryByText('Linus Torvalds')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Reject Grace Hopper' }));
    await waitFor(() => {
      expect(requests(world, 'POST', `/rooms/${room.id}/knocks/${GRACE_ID}/reject`)).toHaveLength(
        1,
      );
    });
    await waitFor(() => {
      expect(screen.queryByText('Grace Hopper')).toBeNull();
    });
  });

  it('stops showing a displayed knock when its time passes on the server clock', async () => {
    // Clock and one-second tick are controlled before the page renders (the hook samples on mount).
    let serverNow = 1_000_000;
    vi.spyOn(clock, 'serverNow').mockImplementation(() => serverNow);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { world, room } = await openRoom({ isPrivate: true, memberIds: [] });
    await screen.findByText('No one is waiting to join.');
    act(() => {
      world.client.push('room:knock:received', {
        roomId: room.id,
        requester: { userId: GRACE_ID, displayName: 'Grace Hopper', avatarUrl: null },
        expiresAtMs: serverNow + 5_000,
      });
    });
    expect(screen.getByRole('button', { name: 'Reject Grace Hopper' })).not.toBeNull();

    serverNow += 5_001;
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.queryByRole('button', { name: 'Reject Grace Hopper' })).toBeNull();
    expect(screen.getByText('No one is waiting to join.')).not.toBeNull();
  });

  it('removes a member only after an in-page confirmation', async () => {
    const { world, room } = await openRoom();
    await screen.findByRole('list', { name: 'Members' });

    fireEvent.click(screen.getByRole('button', { name: 'Remove Grace Hopper' }));
    await settle();
    expect(requests(world, 'DELETE', `/members/${GRACE_ID}`)).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/Remove Grace Hopper from the room\?/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Grace Hopper' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, remove' }));
    await waitFor(() => {
      expect(requests(world, 'DELETE', `/rooms/${room.id}/members/${GRACE_ID}`)).toHaveLength(1);
    });
    await waitFor(() => {
      expect(members().queryByRole('listitem', { name: 'Grace Hopper' })).toBeNull();
    });
  });

  it('cannot remove the host or oneself', async () => {
    await openRoom();
    await screen.findByRole('list', { name: 'Members' });
    expect(screen.queryByRole('button', { name: 'Remove Ada Lovelace' })).toBeNull();
  });

  it('saves only the changed timer lengths, in seconds, and follows room:settings:updated', async () => {
    const { world, room } = await openRoom();
    await screen.findByRole('form', { name: 'Timer lengths' });
    const form = within(screen.getByRole('form', { name: 'Timer lengths' }));
    expect(form.getByText('Applies from the next phase.')).not.toBeNull();
    expect(form.getByRole('button', { name: 'Save lengths' })).toHaveProperty('disabled', true);

    fireEvent.change(form.getByLabelText('Focus (minutes)'), { target: { value: '30' } });
    fireEvent.click(form.getByRole('button', { name: 'Save lengths' }));
    expect(
      await form.findByText(/Saved\. The new lengths apply from the next phase\./),
    ).not.toBeNull();
    const patch = requests(world, 'PATCH', `/rooms/${room.id}/timer-settings`)[0];
    expect(parsedBody(patch as RecordedRequest)).toEqual({ focusSeconds: 1_800 });

    // Another tab of the host changes the break; this form follows without a reload.
    room.timerSettings.shortBreakSeconds = 600;
    act(() => {
      world.client.push('room:settings:updated', {
        roomId: room.id,
        timerSettings: { ...room.timerSettings },
        effectiveFrom: 'next_phase',
      });
    });
    await waitFor(() => {
      expect(form.getByLabelText<HTMLInputElement>('Short break (minutes)').value).toBe('10');
    });
  });

  it('refuses out-of-range lengths before calling the API', async () => {
    const { world, room } = await openRoom();
    const form = within(await screen.findByRole('form', { name: 'Timer lengths' }));
    fireEvent.change(form.getByLabelText('Focus (minutes)'), { target: { value: '500' } });
    fireEvent.click(form.getByRole('button', { name: 'Save lengths' }));
    expect((await form.findByRole('alert')).textContent).toMatch(/whole minutes from 1 to 240/);
    expect(requests(world, 'PATCH', `/rooms/${room.id}/timer-settings`)).toHaveLength(0);
  });
});

describe('leaving and being removed', () => {
  it('"Leave room" sends room:leave and goes back to the list, keeping the membership', async () => {
    const { world, room } = await openRoom({ hostId: GRACE_ID, memberIds: [] });
    await screen.findByText('You are in the room.');
    fireEvent.click(screen.getByRole('button', { name: 'Leave room' }));

    expect(await screen.findByRole('heading', { name: 'My rooms' })).not.toBeNull();
    expect(world.client.leaveRoom).toHaveBeenCalledWith(room.id);
    expect(requests(world, 'DELETE', `/rooms/${room.id}/membership`)).toHaveLength(0);
    expect(await screen.findByRole('link', { name: room.name })).not.toBeNull();
  });

  it('sends no room:leave when the user navigates away from the room page', async () => {
    const { world } = await openRoom();
    await screen.findByText('You are in the room.');
    fireEvent.click(screen.getByRole('link', { name: 'Rooms' }));
    expect(await screen.findByRole('heading', { name: 'My rooms' })).not.toBeNull();
    await settle();
    expect(world.client.leaveRoom).not.toHaveBeenCalled();
  });

  it('keeps the page and shows the error when room:leave is refused', async () => {
    const { world } = await openRoom();
    await screen.findByText('You are in the room.');
    world.client.leaveRoom.mockResolvedValue(ackFailure('RATE_LIMITED'));
    fireEvent.click(screen.getByRole('button', { name: 'Leave room' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/too often/);
    expect(screen.getByRole('heading', { name: 'Deep work' })).not.toBeNull();
  });

  it('"Leave permanently" asks first, then deletes the membership and goes back', async () => {
    const { world, room } = await openRoom({ hostId: GRACE_ID, memberIds: [] });
    await screen.findByText('You are in the room.');
    fireEvent.click(screen.getByRole('button', { name: 'Leave permanently' }));
    await settle();
    expect(requests(world, 'DELETE', `/rooms/${room.id}/membership`)).toHaveLength(0);
    expect(screen.getByRole('group', { name: 'Confirm leaving permanently' })).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Yes, leave permanently' }));
    expect(await screen.findByRole('heading', { name: 'My rooms' })).not.toBeNull();
    expect(requests(world, 'DELETE', `/rooms/${room.id}/membership`)).toHaveLength(1);
    expect(await screen.findByText(/You are not in any rooms yet/)).not.toBeNull();
  });

  it('"Leave permanently" still goes back when the server\'s removal event beats the DELETE answer', async () => {
    const { world, room } = await openRoom({ hostId: GRACE_ID, memberIds: [] });
    await screen.findByText('You are in the room.');
    fireEvent.click(screen.getByRole('button', { name: 'Leave permanently' }));
    const release = world.hold(
      (request) =>
        request.method === 'DELETE' && request.url.endsWith(`/rooms/${room.id}/membership`),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Yes, leave permanently' }));
    await waitFor(() => {
      expect(requests(world, 'DELETE', `/rooms/${room.id}/membership`)).toHaveLength(1);
    });

    // The server deleted the membership and told the socket first: the room page is replaced
    // (its leave button unmounts) before the HTTP answer arrives.
    act(() => {
      world.client.push('room:member:removed', { roomId: room.id, userId: ME, reason: 'left' });
    });
    expect(
      await screen.findByRole('heading', { name: 'You are no longer in this room' }),
    ).not.toBeNull();
    release();

    expect(await screen.findByRole('heading', { name: 'My rooms' })).not.toBeNull();
    expect(screen.queryByRole('heading', { name: 'Room not available' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'You are no longer in this room' })).toBeNull();
    expect(await screen.findByText(/You are not in any rooms yet/)).not.toBeNull();
  });

  it('can cancel leaving permanently', async () => {
    const { world, room } = await openRoom({ hostId: GRACE_ID, memberIds: [] });
    await screen.findByText('You are in the room.');
    fireEvent.click(screen.getByRole('button', { name: 'Leave permanently' }));
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Confirm leaving permanently' })).getByRole(
        'button',
        { name: 'Cancel' },
      ),
    );
    expect(screen.queryByRole('group', { name: 'Confirm leaving permanently' })).toBeNull();
    await settle();
    expect(requests(world, 'DELETE', `/rooms/${room.id}/membership`)).toHaveLength(0);
  });

  it('shows the user they were removed and drops the room', async () => {
    const { world, room } = await openRoom({ hostId: GRACE_ID, memberIds: [] });
    await screen.findByText('You are in the room.');
    act(() => {
      world.client.push('room:member:removed', {
        roomId: room.id,
        userId: ME,
        reason: 'removed',
      });
    });
    expect(
      await screen.findByRole('heading', { name: 'You are no longer in this room' }),
    ).not.toBeNull();
    expect(screen.getByText('You were removed from this room by the host.')).not.toBeNull();
    expect(screen.queryByRole('log', { name: 'Chat messages' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to my rooms' })).not.toBeNull();
  });

  it('shows that the user left when another tab of theirs leaves permanently', async () => {
    const { world, room } = await openRoom({ hostId: GRACE_ID, memberIds: [] });
    await screen.findByText('You are in the room.');
    act(() => {
      world.client.push('room:member:removed', { roomId: room.id, userId: ME, reason: 'left' });
    });
    expect(
      await screen.findByRole('heading', { name: 'You are no longer in this room' }),
    ).not.toBeNull();
    expect(screen.getByText('You left this room.')).not.toBeNull();
    expect(screen.queryByRole('log', { name: 'Chat messages' })).toBeNull();
  });

  it('shows the removal when it arrives while reconnecting, and does not rejoin afterwards', async () => {
    const { world, room } = await openRoom({ hostId: GRACE_ID, memberIds: [] });
    await screen.findByText('You are in the room.');
    act(() => {
      world.client.setStatus('reconnecting');
    });
    await screen.findByText(/Reconnecting/);
    act(() => {
      world.client.push('room:member:removed', {
        roomId: room.id,
        userId: ME,
        reason: 'removed',
      });
    });
    expect(
      await screen.findByRole('heading', { name: 'You are no longer in this room' }),
    ).not.toBeNull();

    act(() => {
      world.client.setStatus('connected');
    });
    await settle();
    expect(world.client.joinRoom).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: 'You are no longer in this room' })).not.toBeNull();
  });

  it('shows the not-a-member page when a reconnect rejoin is refused with NOT_A_MEMBER', async () => {
    const { world } = await openRoom();
    await screen.findByText('You are in the room.');
    act(() => {
      world.client.setStatus('reconnecting');
    });
    world.client.joinRoom.mockResolvedValue(ackFailure('NOT_A_MEMBER'));
    act(() => {
      world.client.setStatus('connected');
    });
    expect(await screen.findByRole('heading', { name: 'You are not a member' })).not.toBeNull();
    expect(screen.queryByRole('log', { name: 'Chat messages' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to my rooms' })).not.toBeNull();
  });

  it("drops another member's removal from presence and refetches members", async () => {
    const { world, room } = await openRoom({ present: [ME, GRACE_ID] });
    await screen.findByRole('list', { name: 'Members' });
    room.members = room.members.filter((entry) => entry.userId !== GRACE_ID);
    act(() => {
      world.client.push('room:member:removed', {
        roomId: room.id,
        userId: GRACE_ID,
        reason: 'removed',
      });
    });
    await waitFor(() => {
      expect(members().queryByRole('listitem', { name: 'Grace Hopper' })).toBeNull();
    });
    expect(screen.getByText('1 here now')).not.toBeNull();
  });
});
