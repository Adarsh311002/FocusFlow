import { type Browser, expect, test } from '@playwright/test';

import {
  addTask,
  api,
  dismissOutcome,
  errorCodeOf,
  expectHistoryCount,
  expectHistoryItem,
  expectParticipants,
  flushThrowawayRedis,
  focusPanel,
  historyOf,
  type HistorySession,
  optIn,
  optOut,
  outcomeNotice,
  participantRow,
  sessionOf,
  watchSocketEvents,
} from '../support/focus';
import { closeAll, expectNoErrors, member, type Person, signUp } from '../support/people';
import {
  createTimerRoom,
  expectTimer,
  joinByCode,
  pause,
  remainingSeconds,
  reset,
  shot,
  start,
  switchPhase,
} from '../support/timer';

// Phase 8: room focus runs end to end in real browsers, one isolated, independently
// authenticated context per person. A focus phase is 60 s in these rooms (the shortest the API
// allows), so phase ends and grace periods are real time; every wait polls with web-first
// assertions and a generous timeout instead of sleeping.

const PHASE_END_TIMEOUT = 85_000;
const MOBILE = { viewport: { width: 390, height: 844 } };

interface Room {
  readonly roomName: string;
  readonly roomId: string;
  readonly url: string;
}

/** A host and the given guests in one fresh public room (60 s focus, 60 s short break). */
async function roomWith(
  browser: Browser,
  guestLabels: readonly string[],
): Promise<{ host: Person; guests: Person[]; room: Room }> {
  const host = await signUp(browser, 'Host');
  const guests: Person[] = [];
  for (const label of guestLabels) {
    guests.push(await signUp(browser, label));
  }
  return { host, guests, room: await enterRoom(host, guests) };
}

/** Creates the room as `host` and has every guest join it by code. */
async function enterRoom(host: Person, guests: readonly Person[], focusMinutes = 1): Promise<Room> {
  const roomName = `Focus ${host.name}`;
  const { code, url, roomId } = await createTimerRoom(host, roomName, { focusMinutes });
  for (const guest of guests) {
    await joinByCode(guest, code, roomName);
  }
  return { roomName, roomId, url };
}

test('journey: presence alone records nothing; two people opt in (one with a personal task), one leaves, the other completes at the real phase end', async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  const host = await signUp(browser, 'Host');
  const guest = await signUp(browser, 'Guest', MOBILE);
  try {
    const guestTask = `Guest task ${guest.name}`;
    await addTask(guest, guestTask);
    const room = await enterRoom(host, [guest]);

    // Both see the same idle 60 s Focus phase and nobody has joined the run.
    for (const viewer of [host, guest]) {
      await expectTimer(viewer.page, { phase: 'Focus', status: 'Not started' });
      expect(await remainingSeconds(viewer.page)).toBe(60);
      await expectParticipants(viewer.page, []);
    }
    // Being present in the room created no session for anyone (D11).
    await expectHistoryCount(host, 0);
    await expectHistoryCount(guest, 0);

    // Opt in: the host without a task, the guest with a personal one. Both lists agree, and the
    // host sees that the guest is focusing, not what on (RF14).
    await optIn(host);
    await optIn(guest, { taskTitle: guestTask });
    for (const viewer of [host, guest]) {
      await expectParticipants(viewer.page, [host, guest]);
    }
    await expect(participantRow(host.page, guest)).toContainText('Connected');
    await expect(focusPanel(host.page).getByText(guestTask)).toHaveCount(0);

    await start(host.page);
    for (const viewer of [host, guest]) {
      await expectTimer(viewer.page, { phase: 'Focus', status: 'Running' });
    }
    await shot(host.page, testInfo, 'room-focus-participants-desktop', { evidence: true });
    await shot(guest.page, testInfo, 'room-focus-participants-mobile', { evidence: true });

    // The guest opts out: abandoned with the opted-out wording, the host stays alone.
    await optOut(guest);
    await expect(
      outcomeNotice(guest.page, /^You left the focus run: .* recorded\./u),
    ).toBeVisible();
    await expectParticipants(host.page, [host]);
    await expectHistoryItem(guest, { title: guestTask, status: 'Left the focus run' });

    // The host stays to the real end: completed, the room moves to an idle short break and the
    // participant list is cleared.
    await expectTimer(
      host.page,
      { phase: 'Short break', status: 'Not started' },
      PHASE_END_TIMEOUT,
    );
    await expectParticipants(host.page, []);
    await expect(outcomeNotice(host.page, /^Completed: you focused together/u)).toBeVisible();
    await expectHistoryItem(host, { status: 'Completed' });
    // The guest's earlier abandonment is still the only record for the guest.
    await expectHistoryCount(guest, 1);

    // What was persisted: both rows belong to this room and to the same run; the completed one
    // holds exactly the planned time, the opt-out only what was focused before leaving.
    const [hostRow] = await historyOf(host);
    const [guestRow] = await historyOf(guest);
    expect(hostRow).toMatchObject({
      status: 'completed',
      context: { kind: 'room', roomId: room.roomId },
    });
    expect(hostRow?.abandonReason).toBeUndefined();
    expect(hostRow?.focusedSeconds).toBe(hostRow?.plannedSeconds);
    expect(guestRow).toMatchObject({
      status: 'abandoned',
      abandonReason: 'opted_out',
      context: { kind: 'room', roomId: room.roomId },
    });
    expect(guestRow?.focusedSeconds).toBeGreaterThanOrEqual(0);
    expect(guestRow?.focusedSeconds).toBeLessThanOrEqual(guestRow?.plannedSeconds ?? 0);
    expect(guestRow?.context).toEqual(hostRow?.context);

    expectNoErrors(host, guest);
  } finally {
    await closeAll(host, guest);
  }
});

test('host reset and phase switch end every opted-in run with the visible reason', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { host, guests } = await roomWith(browser, ['Guest']);
  const guest = guests[0] as Person;
  try {
    // Run 1: both opted in and the timer running; the host resets.
    await optIn(host);
    await optIn(guest);
    for (const viewer of [host, guest]) {
      await expectParticipants(viewer.page, [host, guest]);
    }
    await start(host.page);
    await expectTimer(guest.page, { phase: 'Focus', status: 'Running' });
    await reset(host.page, { confirm: true });
    for (const viewer of [host, guest]) {
      await expectTimer(viewer.page, { phase: 'Focus', status: 'Not started' });
      await expectParticipants(viewer.page, []);
    }
    await expect(outcomeNotice(guest.page, /The host reset the timer/u)).toBeVisible();
    await expectHistoryItem(host, { status: 'Timer reset' });
    await expectHistoryItem(guest, { status: 'Timer reset' });

    // Run 2 (a fresh run was issued by the reset): both join again; the host switches to the
    // short break and the run ends as phase_changed.
    await optIn(host);
    await optIn(guest);
    for (const viewer of [host, guest]) {
      await expectParticipants(viewer.page, [host, guest]);
    }
    await switchPhase(host.page, 'Short break', { confirm: false });
    for (const viewer of [host, guest]) {
      await expectTimer(viewer.page, { phase: 'Short break', status: 'Not started' });
      await expectParticipants(viewer.page, []);
    }
    await expect(outcomeNotice(guest.page, /switched the timer to another phase/u)).toBeVisible();
    await expectHistoryItem(host, { status: 'Phase changed' });
    await expectHistoryItem(guest, { status: 'Phase changed' });
    await expectHistoryCount(guest, 2);

    expectNoErrors(host, guest);
  } finally {
    await closeAll(host, ...guests);
  }
});

test('grace: a participant back within 60 s completes although the phase ended while away; one gone beyond 60 s ends as disconnected', async ({
  browser,
}, testInfo) => {
  // Real time: ~25 s until the server sees the cut, the 60 s phase end, then the 60 s grace.
  test.setTimeout(300_000);
  const { host, guests } = await roomWith(browser, ['Back', 'Gone']);
  const back = guests[0] as Person;
  const gone = guests[1] as Person;
  try {
    await optIn(back);
    await optIn(gone);
    for (const viewer of [host, back, gone]) {
      await expectParticipants(viewer.page, [back, gone]);
    }
    await start(host.page);
    await expectTimer(host.page, { phase: 'Focus', status: 'Running' });

    // Both lose their network. The server notices (ping timeout), the host sees them
    // reconnecting with the grace running, and the session is not abandoned yet.
    back.ignoreErrors = true;
    gone.ignoreErrors = true;
    await back.context.setOffline(true);
    await gone.context.setOffline(true);
    await expect(participantRow(host.page, back)).toContainText('Reconnecting', {
      timeout: 45_000,
    });
    await expect(participantRow(host.page, gone)).toContainText('Reconnecting');
    await shot(host.page, testInfo, 'room-focus-reconnecting-host', { evidence: true });

    // The phase ends while both are away, whoever is present (RT10).
    await expectTimer(
      host.page,
      { phase: 'Short break', status: 'Not started' },
      PHASE_END_TIMEOUT,
    );

    // "Back" returns inside its 60 s: the session completes (RF7).
    await back.context.setOffline(false);
    await expectHistoryItem(back, { status: 'Completed' }, 60_000);
    await expectHistoryCount(back, 1);
    back.ignoreErrors = false;

    // "Gone" stays away: observe the server's decision through REST (not the cut browser) and
    // only then let it back to see the record.
    await expect
      .poll(async () => sessionOf(await api(gone, 'GET', '/focus-sessions/current')), {
        timeout: 150_000,
        intervals: [2_000],
      })
      .toBeNull();
    await gone.context.setOffline(false);
    await expectHistoryItem(gone, { status: 'Disconnected' }, 60_000);
    await expectHistoryCount(gone, 1);
    gone.ignoreErrors = false;

    expectNoErrors(host, back, gone);
  } finally {
    await closeAll(host, ...guests);
  }
});

test('two tabs: closing one tab of a participant does not disconnect them; closing the last does', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { host, guests, room } = await roomWith(browser, ['Guest']);
  const guest = guests[0] as Person;
  try {
    await optIn(guest);
    await expectParticipants(host.page, [guest]);
    await expect(participantRow(host.page, guest)).toContainText('Connected');

    // A second tab of the same person in the same room.
    const second = await guest.context.newPage();
    await second.goto(room.url);
    await expect(second.getByText('You are in the room.')).toBeVisible();
    await expect(focusPanel(second).getByText(/^You are focusing with the room/u)).toBeVisible();

    // The first tab goes away. A negative claim can only be checked by letting time pass: well
    // beyond the instant a (wrong) disconnect would show up on the host's screen.
    await guest.page.close();
    await host.page.waitForTimeout(6_000);
    await expect(participantRow(host.page, guest)).toContainText('Connected');
    await expect(participantRow(host.page, guest)).not.toContainText('Reconnecting');
    await expect(focusPanel(second).getByText(/^You are focusing with the room/u)).toBeVisible();

    // The last tab goes away: now it counts (the grace starts), so the contrast is real.
    await second.close();
    await expect(participantRow(host.page, guest)).toContainText('Reconnecting', {
      timeout: 30_000,
    });
  } finally {
    await closeAll(host, guest);
  }
});

test('unauthorized and invalid focus participation is refused over crafted REST calls', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const host = await signUp(browser, 'Host');
  const guest = await signUp(browser, 'Guest');
  const drifter = await signUp(browser, 'Drifter');
  const outsider = await signUp(browser, 'Outsider');
  try {
    const hostTask = `Host secret task ${host.name}`;
    await addTask(host, hostTask);
    const room = await enterRoom(host, [guest, drifter]);
    const path = `/rooms/${room.roomId}/focus-participation`;

    // The drifter stays a member but leaves the room (no presence).
    await drifter.page.getByRole('button', { name: 'Leave room' }).click();
    await expect(drifter.page).toHaveURL(/\/rooms$/);

    await optIn(host, { taskTitle: hostTask });
    await expectParticipants(guest.page, [host]);

    // A non-member cannot read or change anything, and the answer reveals nothing (M4).
    for (const method of ['GET', 'POST', 'DELETE'] as const) {
      const answer = await api(outsider, method, path, method === 'POST' ? {} : undefined);
      expect(answer.status, `outsider ${method}`).toBe(404);
      expect(errorCodeOf(answer), `outsider ${method}`).toBe('ROOM_NOT_FOUND');
    }
    expect(sessionOf(await api(outsider, 'GET', '/focus-sessions/current'))).toBeNull();

    // A member reads only their own session: none for the guest, and nothing of the host's
    // task or session leaks through the participant list.
    const hostCurrent = sessionOf(await api(host, 'GET', '/focus-sessions/current'));
    expect(hostCurrent).not.toBeNull();
    const hostSessionId = String(hostCurrent?.['id']);
    const guestRead = await api(guest, 'GET', path);
    expect(guestRead.status).toBe(200);
    expect(sessionOf(guestRead)).toBeNull();
    const serialized = JSON.stringify(guestRead.body);
    expect(serialized).not.toContain(hostTask);
    expect(serialized).not.toContain(hostSessionId);
    expect(serialized).toContain(host.name);

    // Another person's session is neither visible nor changeable.
    expect((await api(outsider, 'POST', `/focus-sessions/${hostSessionId}/stop`)).status).toBe(404);
    expect((await api(guest, 'POST', `/focus-sessions/${hostSessionId}/stop`)).status).toBe(404);

    // A crafted opt-in by a member who is not present is refused and creates nothing.
    const notPresent = await api(drifter, 'POST', path, {});
    expect(notPresent.status).toBe(409);
    expect(errorCodeOf(notPresent)).toBe('NOT_PRESENT');
    expect(sessionOf(await api(drifter, 'GET', '/focus-sessions/current'))).toBeNull();

    // Identity never comes from the body; and another person's task is not usable.
    const smuggled = await api(guest, 'POST', path, {
      userId: '01900000-0000-7000-8000-000000000000',
    });
    expect(smuggled.status).toBe(400);
    expect(errorCodeOf(smuggled)).toBe('VALIDATION_FAILED');
    const tasks = await api(host, 'GET', '/tasks');
    const hostTaskId =
      (tasks.body as { tasks: { id: string; title: string }[] }).tasks.find(
        (task) => task.title === hostTask,
      )?.id ?? '';
    expect(hostTaskId).not.toBe('');
    const foreignTask = await api(guest, 'POST', path, { taskId: hostTaskId });
    expect(foreignTask.status).toBe(404);
    expect(errorCodeOf(foreignTask)).toBe('TASK_NOT_FOUND');
    expect(sessionOf(await api(guest, 'GET', path))).toBeNull();

    // The host's room session blocks a solo start and cannot be driven through the solo API.
    const solo = await api(host, 'POST', '/focus-sessions', { plannedSeconds: 1_500 });
    expect(solo.status).toBe(409);
    expect(errorCodeOf(solo)).toBe('SESSION_IN_PROGRESS');
    for (const action of ['pause', 'resume', 'stop'] as const) {
      const answer = await api(host, 'POST', `/focus-sessions/${hostSessionId}/${action}`);
      expect(answer.status, action).toBe(409);
      expect(errorCodeOf(answer), action).toBe('NOT_SOLO_SESSION');
    }
    // ...and all of that changed nothing for the host.
    expect(sessionOf(await api(host, 'GET', '/focus-sessions/current'))?.['status']).toBe(
      'in_progress',
    );
    await expectParticipants(host.page, [host]);
  } finally {
    await closeAll(host, guest, drifter, outsider);
  }
});

test('Redis data loss: clients resync, the timer is idle again, room sessions end as timer lost, a solo session of someone else is untouched', async ({
  browser,
}, testInfo) => {
  // Recovery (resync, the reconciler's sweep) can take up to ~90 s after the flush.
  test.setTimeout(420_000);
  const host = await signUp(browser, 'Host');
  const guest = await signUp(browser, 'Guest', MOBILE);
  const solo = await signUp(browser, 'Solo');
  try {
    const room = await enterRoom(host, [guest]);

    // Watch the host's socket from a fresh page load, so no frame is missed.
    const hostEvents = watchSocketEvents(host.page);
    await host.page.reload();
    await expect(host.page.getByText('You are in the room.')).toBeVisible();
    await expect.poll(() => hostEvents.opened(), { timeout: 30_000 }).toBeGreaterThan(0);

    // Two people opted into a running run.
    await optIn(host);
    await optIn(guest);
    await start(host.page);
    for (const viewer of [host, guest]) {
      await expectTimer(viewer.page, { phase: 'Focus', status: 'Running' });
      await expectParticipants(viewer.page, [host, guest]);
    }

    // A third person, in no room, focuses alone (needs a live connection: retry until the
    // dashboard's socket is registered).
    let soloId = '';
    await expect(async () => {
      const started = await api(solo, 'POST', '/focus-sessions', { plannedSeconds: 1_500 });
      expect(started.status).toBe(201);
      soloId = String(sessionOf(started)?.['id']);
    }).toPass({ timeout: 30_000 });
    await shot(guest.page, testInfo, 'room-focus-before-redis-loss', { evidence: true });

    // The loss itself: FLUSHALL on the throwaway Redis only.
    await flushThrowawayRedis();

    // Clients are told to resync and read a fresh snapshot: the recreated timer is idle with
    // the saved 60 s and nobody is in the new run.
    await expect
      .poll(() => hostEvents.received('room:resync'), { timeout: 90_000, intervals: [1_000] })
      .toBeGreaterThan(0);
    for (const viewer of [host, guest]) {
      await expectTimer(viewer.page, { phase: 'Focus', status: 'Not started' }, 120_000);
      expect(await remainingSeconds(viewer.page)).toBe(60);
      await expectParticipants(viewer.page, [], 120_000);
    }

    // Both room sessions ended as timer_lost, visible in Review (the sweep may take a while).
    await expectHistoryItem(host, { status: 'Timer lost' }, 150_000);
    await expectHistoryItem(guest, { status: 'Timer lost' }, 150_000);
    await expectHistoryCount(host, 1);
    await expectHistoryCount(guest, 1);

    // The solo session of the other person is exactly as it was.
    const current = sessionOf(await api(solo, 'GET', '/focus-sessions/current'));
    expect(current?.['id']).toBe(soloId);
    expect(current?.['status']).toBe('in_progress');
    await expectHistoryItem(solo, { status: 'In progress' });
    await expectHistoryCount(solo, 1);

    // What was persisted: a lost timer records no time at all and keeps the room link; the solo
    // session stays solo, in progress, with nothing focused yet.
    for (const person of [host, guest]) {
      const [row] = await historyOf(person);
      expect(row, person.name).toMatchObject({
        status: 'abandoned',
        abandonReason: 'timer_lost',
        focusedSeconds: 0,
        context: { kind: 'room', roomId: room.roomId },
      });
    }
    expect((await historyOf(solo))[0]).toMatchObject({
      id: soloId,
      status: 'in_progress',
      focusedSeconds: 0,
      context: { kind: 'solo' },
    });

    // No console-error check here: the flush legitimately makes some requests fail.
  } finally {
    await closeAll(host, guest, solo);
  }
});

// ---- Lifecycle gaps closed after the Phase 8 audit ----------------------------------------------

/** The persisted outcome of an ended room session, checked the same way everywhere. */
function expectEndedInRoom(
  row: HistorySession | undefined,
  expected: { reason: string; roomId: string; maxFocusedSeconds: number },
): void {
  expect(row).toMatchObject({
    status: 'abandoned',
    abandonReason: expected.reason,
    context: { kind: 'room', roomId: expected.roomId },
  });
  expect(row?.focusedSeconds).toBeGreaterThanOrEqual(0);
  expect(row?.focusedSeconds).toBeLessThanOrEqual(expected.maxFocusedSeconds);
  expect(row?.focusedSeconds).toBeLessThanOrEqual(row?.plannedSeconds ?? 0);
}

test('reconnect within the grace while the phase still runs keeps the same session, which then completes; a present watcher never gets one', async ({
  browser,
}) => {
  // A 2-minute phase: detection of the cut (~25 s) and the reconnect both fit well inside it.
  test.setTimeout(420_000);
  const host = await signUp(browser, 'Host');
  const back = await signUp(browser, 'Back');
  const watcher = await signUp(browser, 'Watcher');
  try {
    const room = await enterRoom(host, [back, watcher], 2);
    await optIn(host);
    await optIn(back);
    await start(host.page);
    for (const viewer of [host, back, watcher]) {
      await expectTimer(viewer.page, { phase: 'Focus', status: 'Running' });
      await expectParticipants(viewer.page, [host, back]);
    }
    const before = sessionOf(await api(back, 'GET', '/focus-sessions/current'));
    expect(before).toMatchObject({ status: 'in_progress', context: { kind: 'room' } });

    // The network is cut: the host sees the participant reconnecting; the session stays open.
    back.ignoreErrors = true;
    await back.context.setOffline(true);
    await expect(participantRow(host.page, back)).toContainText('Reconnecting', {
      timeout: 45_000,
    });
    const during = sessionOf(await api(back, 'GET', '/focus-sessions/current'));
    expect(during).toMatchObject({ id: before?.['id'], status: 'in_progress' });

    // Back inside the 60 s grace, with the phase still running: the same session continues.
    await back.context.setOffline(false);
    await expect(participantRow(host.page, back)).toContainText('Connected', { timeout: 45_000 });
    back.ignoreErrors = false;
    await expectTimer(host.page, { phase: 'Focus', status: 'Running' });
    expect(await remainingSeconds(host.page)).toBeGreaterThan(0);
    const after = sessionOf(await api(back, 'GET', '/focus-sessions/current'));
    expect(after).toMatchObject({ id: before?.['id'], status: 'in_progress' });
    expect(after?.['abandonReason']).toBeUndefined();

    // It completes normally at the real phase end.
    await expectTimer(host.page, { phase: 'Short break', status: 'Not started' }, 150_000);
    await expectHistoryItem(back, { status: 'Completed' }, 60_000);
    await expectHistoryItem(host, { status: 'Completed' }, 60_000);
    const backRows = await historyOf(back);
    const hostRows = await historyOf(host);
    expect(backRows).toHaveLength(1);
    expect(backRows[0]).toMatchObject({
      id: before?.['id'],
      status: 'completed',
      context: { kind: 'room', roomId: room.roomId },
    });
    expect(backRows[0]?.abandonReason).toBeUndefined();
    expect(backRows[0]?.focusedSeconds).toBe(backRows[0]?.plannedSeconds);
    expect(hostRows).toHaveLength(1);
    expect(hostRows[0]?.status).toBe('completed');
    // Same run for both participants.
    expect(hostRows[0]?.context).toEqual(backRows[0]?.context);

    // The watcher was present for the whole run and never opted in: no record of any kind.
    expect(await historyOf(watcher)).toEqual([]);
    expect(sessionOf(await api(watcher, 'GET', '/focus-sessions/current'))).toBeNull();
    await expectHistoryCount(watcher, 0);

    expectNoErrors(host, back, watcher);
  } finally {
    await closeAll(host, back, watcher);
  }
});

test('leaving the room, leaving permanently and opting out each end the session with their own reason', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const host = await signUp(browser, 'Host');
  const leaver = await signUp(browser, 'Leaver');
  const quitter = await signUp(browser, 'Quitter');
  const opter = await signUp(browser, 'Opter');
  try {
    const task = `Leaver task ${leaver.name}`;
    await addTask(leaver, task);
    const room = await enterRoom(host, [leaver, quitter, opter]);
    await optIn(leaver, { taskTitle: task });
    await optIn(quitter);
    await optIn(opter);
    await start(host.page);
    await expectTimer(host.page, { phase: 'Focus', status: 'Running' });
    await expectParticipants(host.page, [leaver, quitter, opter]);

    // Opting out keeps the person in the room and ends only the session.
    await optOut(opter);
    await expect(
      outcomeNotice(opter.page, /^You left the focus run: .* recorded\./u),
    ).toBeVisible();
    await expectParticipants(host.page, [leaver, quitter]);

    // "Leave room": presence ends, the membership stays, the session is abandoned at once.
    await leaver.page.getByRole('button', { name: 'Leave room' }).click();
    await expect(leaver.page).toHaveURL(/\/rooms$/);
    await expectParticipants(host.page, [quitter]);
    await expect(member(host, leaver.name).getByText('Not here')).toBeVisible();

    // "Leave permanently": the membership goes as well; same outcome for the session.
    await quitter.page.getByRole('button', { name: 'Leave permanently' }).click();
    await quitter.page.getByRole('button', { name: 'Yes, leave permanently' }).click();
    await expect(quitter.page).toHaveURL(/\/rooms$/);
    await expect(quitter.page.getByRole('heading', { name: 'Room not available' })).toHaveCount(0);
    await expectParticipants(host.page, []);
    await expect(member(host, quitter.name)).toHaveCount(0);

    // The visible outcome in Review (the task stays attached) ...
    await expectHistoryItem(leaver, { title: task, status: 'Left the room' });
    await expectHistoryItem(quitter, { status: 'Left the room' });
    await expectHistoryItem(opter, { status: 'Left the focus run' });

    // ... and what was persisted: one row each, the right reason, this room, one shared run,
    // and only time that was actually focused (the phase has run for well under a minute).
    const rows = {
      leaver: await historyOf(leaver),
      quitter: await historyOf(quitter),
      opter: await historyOf(opter),
    };
    for (const [who, reason] of [
      ['leaver', 'left_room'],
      ['quitter', 'left_room'],
      ['opter', 'opted_out'],
    ] as const) {
      expect(rows[who], who).toHaveLength(1);
      expectEndedInRoom(rows[who][0], { reason, roomId: room.roomId, maxFocusedSeconds: 60 });
    }
    expect(rows.quitter[0]?.context).toEqual(rows.leaver[0]?.context);
    expect(rows.opter[0]?.context).toEqual(rows.leaver[0]?.context);
    for (const person of [leaver, quitter, opter]) {
      expect(
        sessionOf(await api(person, 'GET', '/focus-sessions/current')),
        person.name,
      ).toBeNull();
    }
  } finally {
    await closeAll(host, leaver, quitter, opter);
  }
});

test('removing an opted-in member ends their session as removed and leaves the others focusing', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { host, guests, room } = await roomWith(browser, ['Removed', 'Stays']);
  const removed = guests[0] as Person;
  const stays = guests[1] as Person;
  try {
    await optIn(removed);
    await optIn(stays);
    await start(host.page);
    await expectTimer(removed.page, { phase: 'Focus', status: 'Running' });
    await expectParticipants(host.page, [removed, stays]);

    await host.page.getByRole('button', { name: `Remove ${removed.name}` }).click();
    await host.page.getByRole('button', { name: 'Yes, remove' }).click();
    await expect(member(host, removed.name)).toHaveCount(0);

    // The removed person loses the room; the list of everyone still in it no longer names them.
    await expect(
      removed.page.getByRole('heading', { name: 'You are no longer in this room' }),
    ).toBeVisible();
    await expect(
      removed.page.getByText('You were removed from this room by the host.'),
    ).toBeVisible();
    await expectParticipants(host.page, [stays]);
    await expectParticipants(stays.page, [stays]);

    await expectHistoryItem(removed, { status: 'Removed from the room' });
    const [row] = await historyOf(removed);
    expectEndedInRoom(row, { reason: 'removed', roomId: room.roomId, maxFocusedSeconds: 60 });
    expect(sessionOf(await api(removed, 'GET', '/focus-sessions/current'))).toBeNull();
    // They can no longer read anything about the room's run.
    const peek = await api(removed, 'GET', `/rooms/${room.roomId}/focus-participation`);
    expect([peek.status, errorCodeOf(peek)]).toEqual([404, 'ROOM_NOT_FOUND']);

    // The other participant is untouched: still in progress, still in the same room.
    const staying = sessionOf(await api(stays, 'GET', '/focus-sessions/current'));
    expect(staying).toMatchObject({ status: 'in_progress', context: { kind: 'room' } });
    expect(staying?.['context']).toMatchObject({ roomId: room.roomId });
  } finally {
    await closeAll(host, ...guests);
  }
});

test('cross-room isolation: a run in room A never shows in room B, and one person cannot focus in both', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const hostA = await signUp(browser, 'HostA');
  const hostB = await signUp(browser, 'HostB');
  const x = await signUp(browser, 'X');
  try {
    const roomA = await enterRoom(hostA, [x]);
    const roomNameB = `Other ${hostB.name}`;
    const roomB = await createTimerRoom(hostB, roomNameB);

    await optIn(x);
    await expectParticipants(hostA.page, [x]);
    const first = sessionOf(await api(x, 'GET', '/focus-sessions/current'));
    expect(first?.['context']).toMatchObject({ kind: 'room', roomId: roomA.roomId });

    // The same person also sits in room B (a second tab), present but not focusing there.
    const tab = await x.context.newPage();
    await tab.goto('/rooms');
    await tab.getByLabel('Room code').fill(roomB.code);
    await tab.getByRole('button', { name: 'Find room' }).click();
    await expect(tab.getByRole('group', { name: 'Room found' })).toBeVisible();
    await tab.getByRole('button', { name: 'Join room' }).click();
    await expect(tab.getByRole('heading', { name: roomNameB })).toBeVisible();
    await expect(tab.getByText('You are in the room.')).toBeVisible();

    // Room B shows nothing of room A's run: no participants, and X is not "focusing" there.
    await expectParticipants(tab, []);
    await expectParticipants(hostB.page, []);
    await expect(focusPanel(tab).getByText(/^You are focusing with the room/u)).toHaveCount(0);

    // The global rule: one session at a time. The page says so and offers no way to join; a
    // crafted request is refused by the server with the existing session, and nothing moves.
    await expect(
      focusPanel(tab).getByText(/You already have a focus session in progress in another room/u),
    ).toBeVisible();
    await expect(focusPanel(tab).getByRole('button', { name: 'Join focus' })).toHaveCount(0);
    const crafted = await api(x, 'POST', `/rooms/${roomB.roomId}/focus-participation`, {});
    expect([crafted.status, errorCodeOf(crafted)]).toEqual([409, 'SESSION_IN_PROGRESS']);
    expect(JSON.stringify(crafted.body)).toContain(String(first?.['id']));
    await expectParticipants(tab, []);
    await expectParticipants(hostB.page, []);
    await expectParticipants(hostA.page, [x]);
    const unchanged = sessionOf(await api(x, 'GET', '/focus-sessions/current'));
    expect(unchanged).toMatchObject({ id: first?.['id'], status: 'in_progress' });
    expect(await historyOf(x)).toHaveLength(1);

    // Room B's own run is independent: B's host focuses, and A's list does not change.
    await optIn(hostB);
    await expectParticipants(hostB.page, [hostB]);
    await expectParticipants(tab, [hostB]);
    await expectParticipants(hostA.page, [x]);
    await expectParticipants(x.page, [x]);
    const [rowA] = await historyOf(x);
    const [rowB] = await historyOf(hostB);
    expect(rowA?.context).toMatchObject({ kind: 'room', roomId: roomA.roomId });
    expect(rowB?.context).toMatchObject({ kind: 'room', roomId: roomB.roomId });
    const runA = rowA?.context.kind === 'room' ? rowA.context.focusRunId : '';
    const runB = rowB?.context.kind === 'room' ? rowB.context.focusRunId : '';
    expect(runA).not.toBe('');
    expect(runB).not.toBe('');
    expect(runA).not.toBe(runB);

    expectNoErrors(hostA, hostB, x);
  } finally {
    await closeAll(hostA, hostB, x);
  }
});

test('a phase change from a running or a paused focus phase, and a reset from a paused one, each end every opted-in session', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { host, guests, room } = await roomWith(browser, ['Guest']);
  const guest = guests[0] as Person;
  const people = [host, guest];
  try {
    const runBoth = async (): Promise<void> => {
      await optIn(host);
      await optIn(guest);
      for (const viewer of people) {
        await expectParticipants(viewer.page, [host, guest]);
      }
    };
    const expectEnded = async (count: number, reason: string, notice: RegExp): Promise<void> => {
      for (const viewer of people) {
        await expectParticipants(viewer.page, []);
      }
      await expect(outcomeNotice(guest.page, notice)).toBeVisible();
      for (const viewer of people) {
        await dismissOutcome(viewer.page);
        await expect
          .poll(
            async () => {
              const rows = await historyOf(viewer);
              return `${String(rows.length)}:${rows[0]?.abandonReason ?? ''}`;
            },
            { timeout: 30_000 },
          )
          .toBe(`${String(count)}:${reason}`);
        expectEndedInRoom((await historyOf(viewer))[0], {
          reason,
          roomId: room.roomId,
          maxFocusedSeconds: 60,
        });
      }
    };
    const backToFocus = async (): Promise<void> => {
      await switchPhase(host.page, 'Focus', { confirm: false });
      for (const viewer of people) {
        await expectTimer(viewer.page, { phase: 'Focus', status: 'Not started' });
      }
    };

    // 1. Running focus phase, host switches to the short break.
    await runBoth();
    await start(host.page);
    await expectTimer(guest.page, { phase: 'Focus', status: 'Running' });
    await switchPhase(host.page, 'Short break', { confirm: true });
    for (const viewer of people) {
      await expectTimer(viewer.page, { phase: 'Short break', status: 'Not started' });
    }
    await expectEnded(1, 'phase_changed', /switched the timer to another phase/u);
    await backToFocus();

    // 2. Paused focus phase, host switches to the short break.
    await runBoth();
    await start(host.page);
    await pause(host.page);
    for (const viewer of people) {
      await expectTimer(viewer.page, { phase: 'Focus', status: 'Paused' });
    }
    await switchPhase(host.page, 'Short break', { confirm: true });
    for (const viewer of people) {
      await expectTimer(viewer.page, { phase: 'Short break', status: 'Not started' });
    }
    await expectEnded(2, 'phase_changed', /switched the timer to another phase/u);
    await backToFocus();

    // 3. Paused focus phase, host resets.
    await runBoth();
    await start(host.page);
    await pause(host.page);
    for (const viewer of people) {
      await expectTimer(viewer.page, { phase: 'Focus', status: 'Paused' });
    }
    await reset(host.page, { confirm: true });
    for (const viewer of people) {
      await expectTimer(viewer.page, { phase: 'Focus', status: 'Not started' });
    }
    await expectEnded(3, 'reset', /The host reset the timer/u);

    // Every change issued a new run: three sessions, three different runs, none reused.
    const runs = (await historyOf(guest)).map((row) =>
      row.context.kind === 'room' ? row.context.focusRunId : '',
    );
    expect(new Set(runs).size).toBe(3);
    expect(runs).not.toContain('');

    expectNoErrors(host, guest);
  } finally {
    await closeAll(host, ...guests);
  }
});
