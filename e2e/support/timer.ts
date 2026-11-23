import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';

import { emailOf, openRooms, PASSWORD, type Person } from './people';
import { WEB_ORIGIN } from './stack';

// Helpers for the shared room timer (Phase 7). Every selector for the timer panel lives here,
// so a change in the markup is a one-place change. They use roles and accessible names only.

export type Phase = 'Focus' | 'Short break' | 'Long break';
export type Status = 'Not started' | 'Running' | 'Paused';

/** The shortest lengths the API allows: 60 s focus, 60 s short break (whole minutes in the UI). */
export async function createTimerRoom(
  person: Person,
  roomName: string,
  options: { isPrivate?: boolean; focusMinutes?: number } = {},
): Promise<{ code: string; url: string; roomId: string }> {
  const { page } = person;
  await openRooms(person);
  await page.getByLabel('Room name').fill(roomName);
  if (options.isPrivate === true) {
    await page.getByLabel(/^Private/).check();
  }
  await page.getByText('Timer lengths').click();
  await page.getByLabel('Focus (minutes)').fill(String(options.focusMinutes ?? 1));
  await page.getByLabel('Short break (minutes)').fill('1');
  await page.getByRole('button', { name: 'Create room' }).click();
  await expect(page.getByRole('heading', { name: roomName })).toBeVisible();
  await expect(page.getByText('You are in the room.')).toBeVisible();
  const code = (await page.locator('code').first().innerText()).trim();
  expect(code).not.toBe('');
  return { code, url: page.url(), roomId: roomIdOf(page.url()) };
}

export function roomIdOf(url: string): string {
  const match = /\/rooms\/([^/?#]+)/u.exec(url);
  if (match?.[1] === undefined) {
    throw new Error(`not a room URL: ${url}`);
  }
  return match[1];
}

/** A public room joined by its code from /rooms. */
export async function joinByCode(person: Person, code: string, roomName: string): Promise<void> {
  await openRooms(person);
  await person.page.getByLabel('Room code').fill(code);
  await person.page.getByRole('button', { name: 'Find room' }).click();
  await expect(person.page.getByRole('group', { name: 'Room found' })).toBeVisible();
  await person.page.getByRole('button', { name: 'Join room' }).click();
  await expect(person.page.getByRole('heading', { name: roomName })).toBeVisible();
  await expect(person.page.getByText('You are in the room.')).toBeVisible();
}

// ---- Reading the panel ---------------------------------------------------------------

export const timerPanel = (page: Page): Locator => page.getByRole('region', { name: 'Room timer' });

/** The element carrying the clock: its text is "Time remaining 01:00" (the prefix is for screen readers). */
const clock = (page: Page): Locator =>
  timerPanel(page)
    .locator('p')
    .filter({ hasText: /^Time remaining/u });

export async function remainingSeconds(page: Page): Promise<number> {
  const text = (await clock(page).innerText()).trim();
  const match = /(\d{1,3}):(\d{2})$/u.exec(text);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`unreadable timer text: "${text}"`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * The phase and status the panel announces to screen readers ("Focus, running."), a polite
 * live region that changes only with the state: web-first, retried until it holds.
 */
export async function expectTimer(
  page: Page,
  expected: { phase: Phase; status: Status },
  timeout = 15_000,
): Promise<void> {
  const announced = timerPanel(page)
    .getByRole('status')
    .filter({ hasText: /^(Focus|Short break|Long break), (not started|running|paused).$/u });
  await expect(announced).toHaveText(`${expected.phase}, ${expected.status.toLowerCase()}.`, {
    timeout,
  });
}

/** Both pages show the same remaining time to within `toleranceSeconds` (default 2). */
export async function expectSameRemaining(a: Page, b: Page, toleranceSeconds = 2): Promise<number> {
  const [first, second] = await Promise.all([remainingSeconds(a), remainingSeconds(b)]);
  expect(
    Math.abs(first - second),
    `remaining ${String(first)} s vs ${String(second)} s`,
  ).toBeLessThanOrEqual(toleranceSeconds);
  return first;
}

// ---- Controls ------------------------------------------------------------------------

export type ControlName = 'Start timer' | 'Pause timer' | 'Resume timer' | 'Reset timer' | 'Cancel';

export const control = (page: Page, name: ControlName): Locator =>
  timerPanel(page).getByRole('button', { name, exact: true });

export async function start(page: Page): Promise<void> {
  await control(page, 'Start timer').click();
}
export async function pause(page: Page): Promise<void> {
  await control(page, 'Pause timer').click();
}
export async function resume(page: Page): Promise<void> {
  await control(page, 'Resume timer').click();
}

/** Reset; unless the timer is idle the UI asks first ("Yes, reset"). */
export async function reset(page: Page, options: { confirm: boolean }): Promise<void> {
  await control(page, 'Reset timer').click();
  if (options.confirm) {
    await timerPanel(page).getByRole('button', { name: 'Yes, reset', exact: true }).click();
  }
}

/** Switches the phase; unless the timer is idle the UI asks first ("Yes, switch"). */
export async function switchPhase(
  page: Page,
  phase: Phase,
  options: { confirm: boolean },
): Promise<void> {
  await timerPanel(page)
    .getByRole('group', { name: 'Switch phase' })
    .getByRole('button', { name: phase, exact: true })
    .click();
  if (options.confirm) {
    await timerPanel(page).getByRole('button', { name: 'Yes, switch', exact: true }).click();
  }
}

/** The timer panel's own offline / reconnecting notice. */
export const offlineNotice = (page: Page): Locator =>
  timerPanel(page).getByText(/No connection|while the room reconnects/u);

// ---- Evidence ------------------------------------------------------------------------

/** Attaches a full-page screenshot; with E2E_EVIDENCE_DIR set it is also saved there. */
export async function shot(
  page: Page,
  testInfo: TestInfo,
  name: string,
  options: { evidence?: boolean } = {},
): Promise<void> {
  const body = await page.screenshot({ fullPage: true });
  await testInfo.attach(name, { body, contentType: 'image/png' });
  const dir = process.env['E2E_EVIDENCE_DIR'];
  if (options.evidence === true && dir !== undefined && dir !== '') {
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true });
  }
}

// ---- Crafted socket commands ---------------------------------------------------------

// The web app's own socket.io-client, loaded from its package (the e2e package does not
// depend on it): a raw connection that behaves like a hostile client.
interface RawSocket {
  once(event: string, listener: (...args: unknown[]) => void): RawSocket;
  emit(event: string, payload: unknown, ack: (response: unknown) => void): RawSocket;
  disconnect(): void;
}
type RawIo = (url: string, options: Record<string, unknown>) => RawSocket;

const webPackage = fileURLToPath(new URL('../../apps/web/package.json', import.meta.url));

async function accessTokenOf(person: Person): Promise<string> {
  const response = await fetch(`${WEB_ORIGIN}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: emailOf(person.name), password: PASSWORD }),
  });
  expect(response.ok, `login of ${person.name}`).toBe(true);
  const body = (await response.json()) as { accessToken?: unknown };
  if (typeof body.accessToken !== 'string') {
    throw new Error('login answered without an access token');
  }
  return body.accessToken;
}

/**
 * Connects as `person` over a raw socket, optionally joins `roomId`, sends `room:timer:command`
 * for `roomId` and resolves with the raw acknowledgement.
 */
export async function craftTimerCommand(
  person: Person,
  roomId: string,
  command: Record<string, unknown>,
  options: { join: boolean },
): Promise<unknown> {
  const requireFromWeb = createRequire(webPackage);
  const { io } = requireFromWeb('socket.io-client') as { io: RawIo };
  const token = await accessTokenOf(person);
  const socket = io(WEB_ORIGIN, {
    path: '/socket.io',
    transports: ['websocket'],
    auth: { token },
    reconnection: false,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('raw socket did not connect'));
      }, 15_000);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('connect_error', (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error('connect_error'));
      });
    });
    const emit = (event: string, payload: unknown): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`no acknowledgement for ${event}`));
        }, 15_000);
        socket.emit(event, payload, (response) => {
          clearTimeout(timer);
          resolve(response);
        });
      });
    if (options.join) {
      const joined = (await emit('room:join', { roomId })) as { ok?: unknown };
      expect(joined.ok, 'the crafted socket could join the room').toBe(true);
    }
    return await emit('room:timer:command', { roomId, command });
  } finally {
    socket.disconnect();
  }
}
