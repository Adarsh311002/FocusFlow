import { roomIdSchema } from '@focus-flow/contracts';
import { act, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GRACE_ID, ME } from '../../test/fake-room-api';
import { joinOk } from '../../test/fake-room-client';
import { prepareRooms } from '../../test/room-route';
import { resetPendingRefresh } from '../auth/auth-client';
import { clearAccessToken } from '../auth/token-store';
import { roomAckSchemas } from '../realtime/room-events';
import { getRoomLiveStore, useKnockStore } from './room-live-store';

// The route tree loads lazily; see room-page.test.tsx.
configure({ asyncUtilTimeout: 4_000 });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearAccessToken();
  resetPendingRefresh();
});

// The server's approve/reject/expiry race (rooms/service.ts approveKnockOnce): the requester can
// be told `room:knock:resolved: rejected`, then receive `room:member:removed` about a membership
// that was created and undone in between. They never saw the room.

// The snapshot schema now requires participantsVersion; passed explicitly so this file does not
// depend on the shared fake's defaults.
const WITH_VERSION = { participantsVersion: 0 };
const knockOk = (expiresAtMs: number) => roomAckSchemas.knock.parse({ ok: true, expiresAtMs });

async function knockingWorld() {
  const world = prepareRooms();
  const room = world.api.addRoom({
    name: 'Quiet hours',
    isPrivate: true,
    hostId: GRACE_ID,
    code: 'ABC234',
    meIsMember: false,
  });
  world.client.joinRoom.mockImplementation(() =>
    Promise.resolve(joinOk(room, [ME, GRACE_ID], undefined, undefined, WITH_VERSION)),
  );
  world.client.knockRoom.mockResolvedValue(knockOk(Date.now() + 60_000));
  const router = world.render('/rooms');
  await screen.findByText(/You are not in any rooms yet/);
  fireEvent.change(screen.getByLabelText('Room code'), { target: { value: 'ABC234' } });
  fireEvent.click(screen.getByRole('button', { name: 'Find room' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Ask to join' }));
  await screen.findByText('Waiting for the host to answer…');
  return { world, room, router };
}

describe('a knock whose approval was compensated', () => {
  it('shows the requester a plain decline and leaves nothing that blocks the room', async () => {
    const { world, room } = await knockingWorld();

    act(() => {
      world.client.push('room:knock:resolved', { roomId: room.id, outcome: 'rejected' });
      world.client.push('room:member:removed', {
        roomId: room.id,
        userId: ME,
        reason: 'removed',
      });
    });

    // Still on the Rooms page with the decline; not sent to an unavailable-room page.
    expect(await screen.findByText('The host declined your request.')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).not.toBeNull();
    expect(screen.queryByRole('heading', { name: 'You are no longer in this room' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Room not available' })).toBeNull();
    // The room never appears in "My rooms".
    await waitFor(() => {
      expect(screen.getByText(/You are not in any rooms yet/)).not.toBeNull();
    });
    expect(screen.queryByRole('listitem', { name: 'Quiet hours' })).toBeNull();
    expect(useKnockStore.getState().outgoing[room.id]).toEqual({ status: 'rejected' });
  });

  it('lets a later legitimate approval open the room, even if it arrived away from the Rooms page', async () => {
    const { world, room, router } = await knockingWorld();

    act(() => {
      world.client.push('room:knock:resolved', { roomId: room.id, outcome: 'rejected' });
      world.client.push('room:member:removed', {
        roomId: room.id,
        userId: ME,
        reason: 'removed',
      });
    });
    await screen.findByText('The host declined your request.');
    // Documents the leftover the fix must neutralise: the removal notice is held for a room
    // the user never saw.
    expect(getRoomLiveStore(roomIdSchema.parse(room.id)).getState().removed).toBe('removed');

    // The user wanders off; the host later approves a second knock while no Rooms-page card
    // is mounted to react to it.
    await act(async () => {
      await router.navigate({ to: '/dashboard' });
    });
    room.members.push({
      userId: ME,
      displayName: 'Ada Lovelace',
      joinedAt: new Date().toISOString(),
      isHost: false,
    });
    act(() => {
      world.client.push('room:knock:resolved', { roomId: room.id, outcome: 'approved' });
    });
    expect(getRoomLiveStore(roomIdSchema.parse(room.id)).getState().removed).toBeNull();

    await act(async () => {
      await router.navigate({ to: '/rooms/$roomId', params: { roomId: room.id } });
    });
    expect(await screen.findByRole('heading', { name: 'Quiet hours' })).not.toBeNull();
    expect(screen.queryByRole('heading', { name: 'You are no longer in this room' })).toBeNull();
    expect(screen.getByText('Leave room', { selector: 'button' })).not.toBeNull();
  });

  it('a member:joined for the user also clears the stale notice', async () => {
    const { world, room } = await knockingWorld();
    act(() => {
      world.client.push('room:member:removed', {
        roomId: room.id,
        userId: ME,
        reason: 'removed',
      });
    });
    expect(getRoomLiveStore(roomIdSchema.parse(room.id)).getState().removed).toBe('removed');
    act(() => {
      world.client.push('room:member:joined', {
        roomId: room.id,
        member: {
          userId: ME,
          displayName: 'Ada Lovelace',
          avatarUrl: null,
          joinedAt: new Date().toISOString(),
          isHost: false,
        },
      });
    });
    expect(getRoomLiveStore(roomIdSchema.parse(room.id)).getState().removed).toBeNull();
  });

  it('shows the removal when the room page was already open (approved, then compensated)', async () => {
    const { world, room } = await knockingWorld();
    room.members.push({
      userId: ME,
      displayName: 'Ada Lovelace',
      joinedAt: new Date().toISOString(),
      isHost: false,
    });
    act(() => {
      world.client.push('room:knock:resolved', { roomId: room.id, outcome: 'approved' });
    });
    await screen.findByRole('heading', { name: 'Quiet hours' });
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
    expect(screen.getByRole('link', { name: 'Back to my rooms' })).not.toBeNull();
  });
});

describe('another member being removed', () => {
  it('updates presence and the member list for the others', async () => {
    const world = prepareRooms();
    const room = world.api.addRoom({ name: 'Deep work', hostId: ME, memberIds: [GRACE_ID] });
    world.client.joinRoom.mockImplementation(() =>
      Promise.resolve(joinOk(room, [ME, GRACE_ID], undefined, undefined, WITH_VERSION)),
    );
    world.render(`/rooms/${room.id}`);
    await screen.findByRole('heading', { name: 'Deep work' });
    const members = () => within(screen.getByRole('list', { name: 'Members' }));
    await waitFor(() => {
      expect(members().getByRole('listitem', { name: 'Grace Hopper' })).not.toBeNull();
    });

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
    expect(
      getRoomLiveStore(roomIdSchema.parse(room.id))
        .getState()
        .presence.map((user) => user.userId),
    ).toEqual([ME]);
    // The signed-in user is untouched.
    expect(getRoomLiveStore(roomIdSchema.parse(room.id)).getState().removed).toBeNull();
    expect(screen.getByRole('heading', { name: 'Deep work' })).not.toBeNull();
  });
});
