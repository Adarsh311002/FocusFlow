import { expect, test } from '@playwright/test';

import {
  chatLog,
  closeAll,
  expectNoErrors,
  findRoom,
  member,
  type Person,
  sendChat,
  signUp,
} from '../support/people';
import {
  control,
  craftTimerCommand,
  createTimerRoom,
  expectSameRemaining,
  expectTimer,
  joinByCode,
  offlineNotice,
  pause,
  remainingSeconds,
  reset,
  resume,
  roomIdOf,
  shot,
  start,
  switchPhase,
  timerPanel,
} from '../support/timer';

const HERE = 'Here now';
// A focus phase or a break is 60 s in these rooms; the real end plus job latency stays well
// inside this.
const PHASE_END_TIMEOUT = 85_000;

/** A host and a member in a fresh public room with 60 s focus and 60 s short break. */
async function roomWithMember(
  browser: Parameters<typeof signUp>[0],
): Promise<{ host: Person; guest: Person; roomName: string; roomId: string; url: string }> {
  const host = await signUp(browser, 'Host');
  const guest = await signUp(browser, 'Guest');
  const roomName = `Timer ${host.name}`;
  const { code, url, roomId } = await createTimerRoom(host, roomName);
  await joinByCode(guest, code, roomName);
  await expect(member(host, guest.name).getByText(HERE)).toBeVisible();
  await expect(member(guest, host.name).getByText(HERE)).toBeVisible();
  return { host, guest, roomName, roomId, url };
}

test('journey: idle, start, pause, resume, reset, phase switch; the member only watches', async ({
  browser,
}, testInfo) => {
  const { host, guest } = await roomWithMember(browser);
  try {
    // Both see the same idle Focus phase with the room's 60 s.
    for (const viewer of [host, guest]) {
      await expectTimer(viewer.page, { phase: 'Focus', status: 'Not started' });
      expect(await remainingSeconds(viewer.page)).toBe(60);
    }
    await shot(host.page, testInfo, 'timer-idle-host');

    // The member has no working controls and is told why; chat still works.
    await expect(timerPanel(guest.page).getByRole('button', { disabled: false })).toHaveCount(0);
    await expect(
      timerPanel(guest.page).getByText('Only the host controls the timer.'),
    ).toBeVisible();
    const body = `chat beside the timer ${guest.name}`;
    await sendChat(guest, body);
    await expect(chatLog(host).getByText(body)).toHaveCount(1);

    // Start: both run, with the same remaining time, counting down.
    await start(host.page);
    for (const viewer of [host, guest]) {
      await expectTimer(viewer.page, { phase: 'Focus', status: 'Running' });
    }
    const first = await expectSameRemaining(host.page, guest.page);
    expect(first).toBeLessThanOrEqual(60);
    await expect.poll(() => remainingSeconds(guest.page)).toBeLessThan(first);
    await expect.poll(() => remainingSeconds(host.page)).toBeLessThan(first);
    await shot(host.page, testInfo, 'timer-running-host', { evidence: true });
    await shot(guest.page, testInfo, 'timer-running-member', { evidence: true });

    // Pause: both frozen at the identical remaining time.
    await pause(host.page);
    for (const viewer of [host, guest]) {
      await expectTimer(viewer.page, { phase: 'Focus', status: 'Paused' });
    }
    const frozenHost = await remainingSeconds(host.page);
    const frozenGuest = await remainingSeconds(guest.page);
    expect(frozenGuest).toBe(frozenHost);
    // A negative claim ("it does not move") can only be checked by letting time pass.
    await host.page.waitForTimeout(2_500);
    expect(await remainingSeconds(host.page)).toBe(frozenHost);
    expect(await remainingSeconds(guest.page)).toBe(frozenHost);
    await shot(guest.page, testInfo, 'timer-paused-member', { evidence: true });

    // Resume: it moves again from where it stopped.
    await resume(host.page);
    for (const viewer of [host, guest]) {
      await expectTimer(viewer.page, { phase: 'Focus', status: 'Running' });
    }
    await expect.poll(() => remainingSeconds(guest.page)).toBeLessThan(frozenHost);
    expect(await remainingSeconds(guest.page)).toBeLessThanOrEqual(frozenHost);

    // Reset needs a confirmation while running, and returns to the full, idle phase. Declining
    // changes nothing.
    await control(host.page, 'Reset timer').click();
    await expect(timerPanel(host.page).getByRole('button', { name: 'Yes, reset' })).toBeVisible();
    await control(host.page, 'Cancel').click();
    await expectTimer(host.page, { phase: 'Focus', status: 'Running' });
    await reset(host.page, { confirm: true });
    for (const viewer of [host, guest]) {
      await expectTimer(viewer.page, { phase: 'Focus', status: 'Not started' });
      expect(await remainingSeconds(viewer.page)).toBe(60);
    }

    // Switching away from a run is also confirmed, and shows the break for both.
    await start(host.page);
    await expectTimer(guest.page, { phase: 'Focus', status: 'Running' });
    await switchPhase(host.page, 'Short break', { confirm: true });
    for (const viewer of [host, guest]) {
      await expectTimer(viewer.page, { phase: 'Short break', status: 'Not started' });
      expect(await remainingSeconds(viewer.page)).toBe(60);
    }

    expectNoErrors(host, guest);
  } finally {
    await closeAll(host, guest);
  }
});

test('automatic transitions: focus ends into an idle short break (never auto-started), then the break ends into Focus; a member offline across the end catches up', async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  const { host, guest } = await roomWithMember(browser);
  try {
    await start(host.page);
    for (const viewer of [host, guest]) {
      await expectTimer(viewer.page, { phase: 'Focus', status: 'Running' });
    }

    // The member loses the network for the rest of the run and misses the transition.
    guest.ignoreErrors = true;
    await guest.context.setOffline(true);
    await expect(offlineNotice(guest.page)).toBeVisible({ timeout: 30_000 });

    // The real phase end: the host's browser moves to an idle short break at the end of 60 s.
    await expectTimer(
      host.page,
      { phase: 'Short break', status: 'Not started' },
      PHASE_END_TIMEOUT,
    );
    expect(await remainingSeconds(host.page)).toBe(60);
    await shot(host.page, testInfo, 'timer-short-break-idle-host', { evidence: true });

    // Back online, the member shows the current state, not the stale running Focus.
    await guest.context.setOffline(false);
    await expectTimer(guest.page, { phase: 'Short break', status: 'Not started' }, 60_000);
    expect(await remainingSeconds(guest.page)).toBe(60);
    guest.ignoreErrors = false;

    // The break is started by the host and ends into Focus (idle) for both, at the same moment.
    await start(host.page);
    for (const viewer of [host, guest]) {
      await expectTimer(viewer.page, { phase: 'Short break', status: 'Running' });
    }
    await expectSameRemaining(host.page, guest.page);
    for (const viewer of [host, guest]) {
      await expectTimer(viewer.page, { phase: 'Focus', status: 'Not started' }, PHASE_END_TIMEOUT);
      expect(await remainingSeconds(viewer.page)).toBe(60);
    }
    await shot(guest.page, testInfo, 'timer-back-to-focus-member');

    expectNoErrors(host, guest);
  } finally {
    await closeAll(host, guest);
  }
});

test('offline host: reconnecting banner, disabled controls, correct state after returning', async ({
  browser,
}) => {
  const { host, guest } = await roomWithMember(browser);
  try {
    await start(host.page);
    await expectTimer(guest.page, { phase: 'Focus', status: 'Running' });

    host.ignoreErrors = true;
    await host.context.setOffline(true);
    await expect(offlineNotice(host.page)).toBeVisible({ timeout: 30_000 });
    await expect(control(host.page, 'Pause timer')).toBeDisabled();

    // The room is unaffected by the host's network: the timer keeps running for the member.
    await expectTimer(guest.page, { phase: 'Focus', status: 'Running' });

    await host.context.setOffline(false);
    await expect(host.page.getByText('You are in the room.')).toBeVisible({ timeout: 60_000 });
    host.ignoreErrors = false;
    await expectTimer(host.page, { phase: 'Focus', status: 'Running' });
    await expect(control(host.page, 'Pause timer')).toBeEnabled();
    await expectSameRemaining(host.page, guest.page);

    // The recovered host can pause again, and a pause made by it reaches the member.
    await pause(host.page);
    await expectTimer(guest.page, { phase: 'Focus', status: 'Paused' });

    expectNoErrors(host, guest);
  } finally {
    await closeAll(host, guest);
  }
});

test('reload mid-run keeps the same remaining time; a late joiner sees the running state', async ({
  browser,
}) => {
  const { host, guest } = await roomWithMember(browser);
  const late = await signUp(browser, 'Late');
  try {
    await start(host.page);
    await expectTimer(guest.page, { phase: 'Focus', status: 'Running' });
    const before = await expectSameRemaining(host.page, guest.page);

    await host.page.reload();
    await expectTimer(host.page, { phase: 'Focus', status: 'Running' });
    const after = await expectSameRemaining(host.page, guest.page);
    // Reloading does not restart or reset the run: at most a few seconds have passed.
    expect(after).toBeLessThanOrEqual(before);
    expect(before - after).toBeLessThanOrEqual(15);
    await expect(control(host.page, 'Pause timer')).toBeEnabled();

    // A member who opens the room later (join by code) sees the same running timer.
    const joinCode = (await host.page.locator('code').first().innerText()).trim();
    await findRoom(late, joinCode);
    await late.page.getByRole('button', { name: 'Join room' }).click();
    await expect(late.page.getByText('You are in the room.')).toBeVisible();
    await expectTimer(late.page, { phase: 'Focus', status: 'Running' });
    await expectSameRemaining(host.page, late.page);

    expectNoErrors(host, guest, late);
  } finally {
    await closeAll(host, guest, late);
  }
});

test('a stale host tab: reset with an old version is a conflict that shows the current state', async ({
  browser,
}) => {
  const { host, guest } = await roomWithMember(browser);
  const tab2 = await host.context.newPage();
  try {
    // Tab 2 never receives timer events: server frames carrying them are dropped, so it keeps
    // the version it saw.
    let dropping = false;
    let upgraded = false;
    await tab2.routeWebSocket(/socket\.io/u, (ws) => {
      upgraded = true;
      const server = ws.connectToServer();
      ws.onMessage((message) => {
        server.send(message);
      });
      server.onMessage((message) => {
        if (dropping && typeof message === 'string' && message.includes('room:timer:state')) {
          return;
        }
        ws.send(message);
      });
    });
    await tab2.goto(host.page.url());
    await expectTimer(tab2, { phase: 'Focus', status: 'Not started' });

    await start(host.page);
    await expectTimer(guest.page, { phase: 'Focus', status: 'Running' });
    await expectTimer(tab2, { phase: 'Focus', status: 'Running' });
    // Events now travel over the WebSocket (not the polling fallback), where they can be dropped.
    await expect.poll(() => upgraded).toBe(true);
    dropping = true;

    // Tab 1 pauses; tab 2 (still showing Running at the older version) does not hear of it.
    await pause(host.page);
    await expectTimer(host.page, { phase: 'Focus', status: 'Paused' });
    await expectTimer(guest.page, { phase: 'Focus', status: 'Paused' });
    await expectTimer(tab2, { phase: 'Focus', status: 'Running' });

    // Tab 2 resets with that older version: refused, and it catches up from the rejection.
    await reset(tab2, { confirm: true });
    await expect(timerPanel(tab2).getByText(/changed|out of date|newer/i)).toBeVisible();
    await expectTimer(tab2, { phase: 'Focus', status: 'Paused' });
    // Nothing was reset anywhere.
    await expectTimer(host.page, { phase: 'Focus', status: 'Paused' });
    await expectTimer(guest.page, { phase: 'Focus', status: 'Paused' });
    // A reset would have shown idle; the clock stays frozen at the same value everywhere.
    await expectSameRemaining(host.page, guest.page, 0);
    await expectSameRemaining(tab2, guest.page, 0);

    expectNoErrors(host, guest);
  } finally {
    await closeAll(host, guest);
  }
});

test('authorization: a non-member sees no room and no timer; a member cannot control by crafted command', async ({
  browser,
}) => {
  const { host, guest, roomId, url } = await roomWithMember(browser);
  const stranger = await signUp(browser, 'Stranger');
  try {
    await start(host.page);
    await expectTimer(guest.page, { phase: 'Focus', status: 'Running' });

    await stranger.page.goto(url);
    await expect(
      stranger.page.getByRole('heading', { name: /Room not available|You are not a member/ }),
    ).toBeVisible();
    await expect(timerPanel(stranger.page)).toHaveCount(0);
    await expect(stranger.page.getByRole('timer')).toHaveCount(0);

    // A member bypassing the UI: the server answers NOT_HOST and nothing changes.
    const memberAck = await craftTimerCommand(guest, roomId, { type: 'pause' }, { join: true });
    expect(memberAck).toMatchObject({ ok: false, error: { code: 'NOT_HOST' } });
    // A non-member who never joined: refused too (not in the room).
    const strangerAck = await craftTimerCommand(
      stranger,
      roomId,
      { type: 'pause' },
      { join: false },
    );
    expect(strangerAck).toMatchObject({ ok: false, error: { code: 'NOT_JOINED' } });

    await expectTimer(host.page, { phase: 'Focus', status: 'Running' });
    await expectTimer(guest.page, { phase: 'Focus', status: 'Running' });

    expect(roomIdOf(url)).toBe(roomId);
    expectNoErrors(host, guest);
  } finally {
    await closeAll(host, guest, stranger);
  }
});

test('isolation: two rooms never show each other’s timer', async ({ browser }) => {
  const { host: hostA, guest: guestA } = await roomWithMember(browser);
  const hostB = await signUp(browser, 'HostB');
  try {
    await createTimerRoom(hostB, `Other ${hostB.name}`);
    await expectTimer(hostB.page, { phase: 'Focus', status: 'Not started' });

    await start(hostA.page);
    await expectTimer(guestA.page, { phase: 'Focus', status: 'Running' });
    // Room B stays idle with the full time while A runs.
    await expectTimer(hostB.page, { phase: 'Focus', status: 'Not started' });
    expect(await remainingSeconds(hostB.page)).toBe(60);

    // B moves to a paused-looking different state: switch to a break; A is unaffected.
    await switchPhase(hostB.page, 'Short break', { confirm: false });
    await expectTimer(hostB.page, { phase: 'Short break', status: 'Not started' });
    await expectTimer(hostA.page, { phase: 'Focus', status: 'Running' });
    await expectTimer(guestA.page, { phase: 'Focus', status: 'Running' });

    await pause(hostA.page);
    await expectTimer(guestA.page, { phase: 'Focus', status: 'Paused' });
    await expectTimer(hostB.page, { phase: 'Short break', status: 'Not started' });

    expectNoErrors(hostA, guestA, hostB);
  } finally {
    await closeAll(hostA, guestA, hostB);
  }
});

test('mobile: the timer and its controls fit a 390 x 844 screen without sideways scrolling', async ({
  browser,
}, testInfo) => {
  const host = await signUp(browser, 'Host', { viewport: { width: 390, height: 844 } });
  try {
    await createTimerRoom(host, `Phone ${host.name}`);
    await expectTimer(host.page, { phase: 'Focus', status: 'Not started' });
    await expect(control(host.page, 'Start timer')).toBeVisible();
    await control(host.page, 'Start timer').scrollIntoViewIfNeeded();
    await expect(control(host.page, 'Start timer')).toBeInViewport();

    const overflow = await host.page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'horizontal overflow in px').toBeLessThanOrEqual(0);

    await start(host.page);
    await expectTimer(host.page, { phase: 'Focus', status: 'Running' });
    await expect(control(host.page, 'Pause timer')).toBeInViewport();
    await shot(host.page, testInfo, 'timer-mobile-running', { evidence: true });
    expectNoErrors(host);
  } finally {
    await closeAll(host);
  }
});
