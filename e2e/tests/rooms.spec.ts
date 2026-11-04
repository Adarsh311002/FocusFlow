import { expect, test } from '@playwright/test';

import {
  chatLog,
  closeAll,
  createRoom,
  expectNoErrors,
  findRoom,
  member,
  openRooms,
  sendChat,
  signUp,
} from '../support/people';

const HERE = 'Here now';
const NOT_HERE = 'Not here';

test('public room: join by code, presence, chat, leave, membership stays', async ({ browser }) => {
  const host = await signUp(browser, 'Host');
  const guest = await signUp(browser, 'Guest');
  try {
    const roomName = `Public ${host.name}`;
    const { code } = await createRoom(host, roomName, { isPrivate: false });

    await findRoom(guest, code);
    await guest.page.getByRole('button', { name: 'Join room' }).click();
    await expect(guest.page.getByRole('heading', { name: roomName })).toBeVisible();
    await expect(guest.page.getByText('You are in the room.')).toBeVisible();

    // Both see both people present.
    for (const viewer of [host, guest]) {
      await expect(member(viewer, host.name).getByText(HERE)).toBeVisible();
      await expect(member(viewer, guest.name).getByText(HERE)).toBeVisible();
    }

    // Chat from the guest reaches both, once.
    const body = `hello from ${guest.name}`;
    await sendChat(guest, body);
    await expect(chatLog(host).getByText(body)).toHaveCount(1);
    await expect(chatLog(guest).getByText(body)).toHaveCount(1);
    // Give a duplicate time to show up, then check again.
    await host.page.waitForTimeout(1_000);
    await expect(chatLog(host).getByText(body)).toHaveCount(1);
    await expect(chatLog(guest).getByText(body)).toHaveCount(1);

    // Leave: no longer present for the host, but still a member for both.
    await guest.page.getByRole('button', { name: 'Leave room' }).click();
    await expect(guest.page).toHaveURL(/\/rooms$/);
    await expect(member(host, guest.name)).toBeVisible();
    await expect(member(host, guest.name).getByText(NOT_HERE)).toBeVisible();
    await expect(member(host, host.name).getByText(HERE)).toBeVisible();

    await openRooms(guest);
    await expect(
      guest.page.getByRole('list', { name: 'My rooms' }).getByRole('listitem', { name: roomName }),
    ).toBeVisible();

    expectNoErrors(host, guest);
  } finally {
    await closeAll(host, guest);
  }
});

test('private room: knock, approve and reject', async ({ browser }) => {
  const host = await signUp(browser, 'Host');
  const guest = await signUp(browser, 'Guest');
  const other = await signUp(browser, 'Other');
  try {
    const roomName = `Private ${host.name}`;
    const { code } = await createRoom(host, roomName, { isPrivate: true });

    // Approve.
    await findRoom(guest, code);
    await guest.page.getByRole('button', { name: 'Ask to join' }).click();
    await expect(guest.page.getByText('Waiting for the host to answer…')).toBeVisible();

    await expect(host.page.getByRole('list', { name: 'Join requests' })).toBeVisible();
    await host.page.getByRole('button', { name: `Approve ${guest.name}` }).click();

    await expect(guest.page.getByRole('heading', { name: roomName })).toBeVisible();
    await expect(guest.page.getByText('You are in the room.')).toBeVisible();
    await expect(member(host, guest.name).getByText(HERE)).toBeVisible();
    await expect(member(guest, guest.name).getByText(HERE)).toBeVisible();

    // Reject.
    await findRoom(other, code);
    await other.page.getByRole('button', { name: 'Ask to join' }).click();
    await expect(other.page.getByText('Waiting for the host to answer…')).toBeVisible();
    await host.page.getByRole('button', { name: `Reject ${other.name}` }).click();
    await expect(other.page.getByText('The host declined your request.')).toBeVisible();
    await expect(other.page).toHaveURL(/\/rooms$/);
    await expect(member(host, other.name)).toHaveCount(0);
    await expect(
      other.page.getByRole('list', { name: 'My rooms' }).getByRole('listitem', { name: roomName }),
    ).toHaveCount(0);

    expectNoErrors(host, guest, other);
  } finally {
    await closeAll(host, guest, other);
  }
});

test('removal: the removed member loses the room and must knock again', async ({ browser }) => {
  const host = await signUp(browser, 'Host');
  const guest = await signUp(browser, 'Guest');
  try {
    const roomName = `Removal ${host.name}`;
    const { code, url } = await createRoom(host, roomName, { isPrivate: true });

    await findRoom(guest, code);
    await guest.page.getByRole('button', { name: 'Ask to join' }).click();
    await host.page.getByRole('button', { name: `Approve ${guest.name}` }).click();
    await expect(member(guest, guest.name).getByText(HERE)).toBeVisible();

    await host.page.getByRole('button', { name: `Remove ${guest.name}` }).click();
    await host.page.getByRole('button', { name: 'Yes, remove' }).click();
    await expect(member(host, guest.name)).toHaveCount(0);

    await expect(
      guest.page.getByRole('heading', { name: 'You are no longer in this room' }),
    ).toBeVisible();
    await expect(
      guest.page.getByText('You were removed from this room by the host.'),
    ).toBeVisible();

    // The chat no longer reaches the removed guest.
    const body = `after removal ${host.name}`;
    await sendChat(host, body);
    await expect(chatLog(host).getByText(body)).toHaveCount(1);
    await guest.page.waitForTimeout(1_500);
    await expect(guest.page.getByText(body)).toHaveCount(0);

    // Opening the room again is refused; a code lookup offers only "Ask to join".
    await guest.page.goto(url);
    await expect(guest.page.getByRole('heading', { name: 'Room not available' })).toBeVisible();
    await expect(guest.page.getByRole('list', { name: 'Members' })).toHaveCount(0);
    await findRoom(guest, code);
    await expect(guest.page.getByRole('button', { name: 'Ask to join' })).toBeVisible();
    await expect(guest.page.getByRole('log', { name: 'Chat messages' })).toHaveCount(0);

    expectNoErrors(host);
  } finally {
    await closeAll(host, guest);
  }
});

test('reconnect: offline state, automatic rejoin, presence and chat restored', async ({
  browser,
}) => {
  const host = await signUp(browser, 'Host');
  const guest = await signUp(browser, 'Guest');
  try {
    const roomName = `Reconnect ${host.name}`;
    const { code } = await createRoom(host, roomName, { isPrivate: false });
    await findRoom(guest, code);
    await guest.page.getByRole('button', { name: 'Join room' }).click();
    await expect(member(guest, guest.name).getByText(HERE)).toBeVisible();
    await expect(member(host, guest.name).getByText(HERE)).toBeVisible();

    guest.ignoreErrors = true;
    await guest.context.setOffline(true);

    // The guest's own UI: reconnecting, chat unavailable.
    await expect(guest.page.getByText(/Reconnecting|You are offline/)).toBeVisible({
      timeout: 30_000,
    });
    await expect(guest.page.getByLabel('Message', { exact: true })).toBeDisabled();
    await expect(guest.page.getByRole('button', { name: 'Send' })).toBeDisabled();

    await guest.context.setOffline(false);

    await expect(guest.page.getByText('You are in the room.')).toBeVisible({ timeout: 60_000 });
    await expect(guest.page.getByLabel('Message', { exact: true })).toBeEnabled();
    await expect(member(host, guest.name).getByText(HERE)).toBeVisible({ timeout: 60_000 });
    await expect(member(guest, guest.name).getByText(HERE)).toBeVisible();
    guest.ignoreErrors = false;

    const body = `back online ${guest.name}`;
    await sendChat(guest, body);
    await expect(chatLog(host).getByText(body)).toHaveCount(1);
    await expect(chatLog(guest).getByText(body)).toHaveCount(1);

    expectNoErrors(host, guest);
  } finally {
    await closeAll(host, guest);
  }
});

test('isolation: a non-member never sees a private room', async ({ browser }) => {
  const host = await signUp(browser, 'Host');
  const stranger = await signUp(browser, 'Stranger');
  try {
    const roomName = `Secret ${host.name}`;
    const { url } = await createRoom(host, roomName, { isPrivate: true });
    await sendChat(host, `secret chat ${host.name}`);

    await stranger.page.goto(url);
    await expect(
      stranger.page.getByRole('heading', { name: /Room not available|You are not a member/ }),
    ).toBeVisible();
    await expect(stranger.page.getByRole('list', { name: 'Members' })).toHaveCount(0);
    await expect(stranger.page.getByRole('log', { name: 'Chat messages' })).toHaveCount(0);
    await expect(stranger.page.getByText(`secret chat ${host.name}`)).toHaveCount(0);
    await expect(stranger.page.getByText(host.name)).toHaveCount(0);
    await expect(stranger.page.getByRole('heading', { name: roomName })).toHaveCount(0);

    await openRooms(stranger);
    await expect(stranger.page.getByRole('listitem', { name: roomName })).toHaveCount(0);

    expectNoErrors(host);
  } finally {
    await closeAll(host, stranger);
  }
});
