import {
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  expect,
  type Locator,
  type Page,
} from '@playwright/test';

/** One person: an isolated browser context with a signed-up account and a console watch. */
export interface Person {
  readonly name: string;
  readonly context: BrowserContext;
  readonly page: Page;
  /** Console errors and uncaught exceptions seen so far (see `ignoreErrors`). */
  readonly errors: string[];
  /** While true, errors are not recorded (expected failures while the network is cut). */
  ignoreErrors: boolean;
}

const unique = (): string => Math.random().toString(36).slice(2, 8);

export const PASSWORD = 'correct horse battery staple';

/**
 * Extra time each test gets for page loads. The suite runs against the Vite dev server, where
 * every person's fresh browser context loads the app's modules one by one (about 2 s idle, up
 * to about 10 s while Docker, the API, Vite and several browsers share the machine). The real
 * waits a test makes (phase ends, the 60 s grace) are unchanged; only loading gets room.
 */
export const PAGE_LOAD_HEADROOM_MS = 60_000;

/** Opens a fresh context, signs a new, uniquely named user up and lands on the dashboard. */
export const emailOf = (name: string): string => `${name.toLowerCase()}@e2e.test`;

export async function signUp(
  browser: Browser,
  label: string,
  contextOptions: BrowserContextOptions = {},
): Promise<Person> {
  const name = `${label}${unique()}`;
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const person: Person = { name, context, page, errors: [], ignoreErrors: false };

  page.on('console', (message) => {
    // Expected 4xx answers (the signed-out refresh probe, a missing favicon, a refused room)
    // are logged by Chrome as "Failed to load resource"; unexpected 5xx answers are caught
    // by the response listener below.
    if (
      message.type() === 'error' &&
      !person.ignoreErrors &&
      !message.text().startsWith('Failed to load resource')
    ) {
      person.errors.push(`console: ${message.text()}`);
    }
  });
  page.on('response', (response) => {
    if (response.status() >= 500 && !person.ignoreErrors) {
      person.errors.push(`http ${String(response.status())}: ${response.url()}`);
    }
  });
  page.on('pageerror', (error) => {
    if (!person.ignoreErrors) {
      person.errors.push(`pageerror: ${error.message}`);
    }
  });

  await page.goto('/signup');
  await page.getByLabel('Display name').fill(name);
  await page.getByLabel('Email').fill(emailOf(name));
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await skipDailyIntention(page);
  return person;
}

/**
 * A new user meets the full-screen daily intention ritual (IN3) right after signing up. The
 * room suites are not about it, so each person answers "Not today", exactly as a user would;
 * the choice is remembered in this context's localStorage, so later tabs and reloads of the
 * same person are not asked again that day.
 */
async function skipDailyIntention(page: Page): Promise<void> {
  const ritual = page.getByRole('dialog', { name: /What would make today/u });
  await expect(ritual).toBeVisible();
  await ritual.getByRole('button', { name: 'Not today', exact: true }).click();
  await expect(ritual).toBeHidden();
}

export async function openRooms(person: Person): Promise<void> {
  await person.page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Rooms' })
    .click();
  await expect(person.page.getByRole('heading', { name: 'Rooms', exact: true })).toBeVisible();
}

/** Creates a room from /rooms; returns its code and URL and leaves the creator in the room. */
export async function createRoom(
  person: Person,
  roomName: string,
  options: { isPrivate: boolean },
): Promise<{ code: string; url: string }> {
  const { page } = person;
  await openRooms(person);
  await page.getByLabel('Room name').fill(roomName);
  if (options.isPrivate) {
    await page.getByLabel(/^Private/).check();
  }
  await page.getByRole('button', { name: 'Create room' }).click();
  await expect(page.getByRole('heading', { name: roomName })).toBeVisible();
  await expect(page.getByText('You are in the room.')).toBeVisible();
  const code = (await page.locator('code').first().innerText()).trim();
  expect(code).not.toBe('');
  return { code, url: page.url() };
}

/** Types a code on /rooms and presses "Find room". */
export async function findRoom(person: Person, code: string): Promise<void> {
  await openRooms(person);
  await person.page.getByLabel('Room code').fill(code);
  await person.page.getByRole('button', { name: 'Find room' }).click();
  await expect(person.page.getByRole('group', { name: 'Room found' })).toBeVisible();
}

export function member(person: Person, displayName: string): Locator {
  return person.page
    .getByRole('list', { name: 'Members' })
    .getByRole('listitem', { name: displayName });
}

export function chatLog(person: Person): Locator {
  return person.page.getByRole('log', { name: 'Chat messages' });
}

export async function sendChat(person: Person, body: string): Promise<void> {
  await person.page.getByLabel('Message', { exact: true }).fill(body);
  await person.page.getByRole('button', { name: 'Send' }).click();
}

export function expectNoErrors(...people: Person[]): void {
  for (const person of people) {
    expect(person.errors, `${person.name} console errors`).toEqual([]);
  }
}

export async function closeAll(...people: Person[]): Promise<void> {
  for (const person of people) {
    await person.context.close();
  }
}
