import net from 'node:net';

import { expect, type Locator, type Page } from '@playwright/test';

import { emailOf, PASSWORD, type Person } from './people';
import { THROWAWAY_REDIS_ENV, WEB_ORIGIN } from './stack';

// Helpers for room focus runs (Phase 8). Selectors use roles and accessible names only and
// live here, so a markup change is a one-place change.

// ---- The "Focus together" panel -------------------------------------------------------------

export const focusPanel = (page: Page): Locator =>
  page.getByRole('region', { name: 'Focus together' });

const participantList = (page: Page): Locator =>
  focusPanel(page).getByRole('list', { name: /focusing together$/u });

const NO_ONE = 'No one has joined this focus run yet.';

/** The panel lists exactly these people (any order); an empty list shows the empty sentence. */
export async function expectParticipants(
  page: Page,
  people: readonly Person[],
  timeout = 15_000,
): Promise<void> {
  if (people.length === 0) {
    await expect(focusPanel(page).getByText(NO_ONE)).toBeVisible({ timeout });
    return;
  }
  await expect(participantList(page).getByRole('listitem')).toHaveCount(people.length, {
    timeout,
  });
  for (const person of people) {
    await expect(
      participantList(page).getByRole('listitem').filter({ hasText: person.name }),
    ).toHaveCount(1, { timeout });
  }
}

export const participantRow = (page: Page, person: Person): Locator =>
  participantList(page).getByRole('listitem').filter({ hasText: person.name });

/** Opts in from the room page. `taskTitle` picks one of the person's own open tasks. */
export async function optIn(person: Person, options: { taskTitle?: string } = {}): Promise<void> {
  const panel = focusPanel(person.page);
  if (options.taskTitle !== undefined) {
    await panel.getByLabel('Your task for this run (optional)').selectOption({
      label: options.taskTitle,
    });
  }
  const join = panel.getByRole('button', { name: 'Join focus' });
  await expect(join).toBeEnabled();
  await join.click();
  await expect(panel.getByText(/^You are focusing with the room/u)).toBeVisible();
}

/** Opts out through the in-page confirmation. */
export async function optOut(person: Person): Promise<void> {
  const panel = focusPanel(person.page);
  await panel.getByRole('button', { name: 'Leave focus', exact: true }).click();
  await panel.getByRole('button', { name: 'Yes, leave the focus run', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Join focus' })).toBeVisible();
}

/** The "what just happened" notice of the panel (words come from review/outcome code). */
export const outcomeNotice = (page: Page, text: RegExp | string): Locator =>
  focusPanel(page).getByRole('status').filter({ hasText: text });

// ---- Tasks ----------------------------------------------------------------------------------

/** Adds an open task through the dashboard form (call right after `signUp`, before a room). */
export async function addTask(person: Person, title: string): Promise<void> {
  const { page } = person;
  if (!page.url().includes('/dashboard')) {
    await page.goto('/dashboard');
  }
  await page.getByLabel('New task', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(
    page.getByRole('list', { name: 'Open tasks' }).getByRole('listitem', { name: title }),
  ).toBeVisible();
}

// ---- Review ---------------------------------------------------------------------------------

/** Opens /review in a second tab of the person's context (a tab never joins a room). */
export async function openReview(person: Person): Promise<Page> {
  const page = await person.context.newPage();
  await page.goto('/review');
  await expect(page.getByRole('heading', { name: 'Review', exact: true })).toBeVisible();
  return page;
}

const historyList = (page: Page): Locator => page.getByRole('list', { name: 'Focus sessions' });

/** The history item "<task title or No task>, <status label>" (see review-format.ts). */
export const historyItem = (page: Page, title: string, status: string): Locator =>
  historyList(page).getByRole('listitem', { name: `${title}, ${status}`, exact: true });

export type HistoryStatus =
  | 'Completed'
  | 'Left the focus run'
  | 'Left the room'
  | 'Removed from the room'
  | 'Timer reset'
  | 'Phase changed'
  | 'Disconnected'
  | 'Timer lost'
  | 'In progress';

/**
 * Waits until the person's history shows the item, re-reading the page between attempts (a
 * session can end seconds after the page was opened; a reload always shows the truth).
 */
export async function expectHistoryItem(
  person: Person,
  expected: { title?: string; status: HistoryStatus },
  timeout = 30_000,
): Promise<void> {
  const page = await openReview(person);
  try {
    const item = historyItem(page, expected.title ?? 'No task', expected.status);
    await expect(async () => {
      await page.reload();
      await expect(item).toBeVisible({ timeout: 4_000 });
    }).toPass({ timeout });
  } finally {
    await page.close();
  }
}

/** The history shows exactly `count` sessions (and "No focus sessions yet." for 0). */
export async function expectHistoryCount(person: Person, count: number): Promise<void> {
  const page = await openReview(person);
  try {
    if (count === 0) {
      await expect(page.getByText('No focus sessions yet.')).toBeVisible();
    } else {
      await expect(historyList(page).getByRole('listitem')).toHaveCount(count);
    }
  } finally {
    await page.close();
  }
}

// ---- Crafted REST calls ---------------------------------------------------------------------

export interface ApiAnswer {
  readonly status: number;
  /** The parsed JSON body, or `null` when there is none (204). */
  readonly body: unknown;
}

const tokens = new WeakMap<Person, string>();

async function accessTokenOf(person: Person): Promise<string> {
  const known = tokens.get(person);
  if (known !== undefined) {
    return known;
  }
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
  tokens.set(person, body.accessToken);
  return body.accessToken;
}

/** A REST call as `person`, straight at the API through the web origin's proxy. */
export async function api(
  person: Person,
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<ApiAnswer> {
  const response = await fetch(`${WEB_ORIGIN}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${await accessTokenOf(person)}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** `error.code` of an API error answer, or `undefined`. */
export function errorCodeOf(answer: ApiAnswer): string | undefined {
  if (!isRecord(answer.body) || !isRecord(answer.body['error'])) {
    return undefined;
  }
  const code = answer.body['error']['code'];
  return typeof code === 'string' ? code : undefined;
}

/** `body.session` of an answer, or `null`/`undefined` as the API sent it. */
export function sessionOf(answer: ApiAnswer): Record<string, unknown> | null {
  if (!isRecord(answer.body)) {
    return null;
  }
  const session = answer.body['session'];
  return isRecord(session) ? session : null;
}

/** The persisted fields of a history entry that the tests check (`GET /focus-sessions`). */
export interface HistorySession {
  readonly id: string;
  readonly status: string;
  /** Present only on abandoned sessions. */
  readonly abandonReason?: string;
  readonly plannedSeconds: number;
  readonly focusedSeconds: number;
  readonly context: { kind: 'solo' } | { kind: 'room'; roomId: string; focusRunId: string };
}

/** The person's whole history as the API stores it, newest-started first. */
export async function historyOf(person: Person): Promise<HistorySession[]> {
  const answer = await api(person, 'GET', '/focus-sessions');
  expect(answer.status, `history of ${person.name}`).toBe(200);
  const sessions = isRecord(answer.body) ? answer.body['sessions'] : undefined;
  if (!Array.isArray(sessions)) {
    throw new Error('the history answer has no sessions array');
  }
  return sessions as HistorySession[];
}

/** Dismisses the panel's "what just happened" notice so the next one cannot be mistaken for it. */
export async function dismissOutcome(page: Page): Promise<void> {
  const dismiss = focusPanel(page).getByRole('button', { name: 'Dismiss', exact: true });
  if ((await dismiss.count()) > 0) {
    await dismiss.first().click();
  }
}

// ---- Socket frames ----------------------------------------------------------------------------

/**
 * Records every Socket.IO event name received over the page's WebSockets. Attach it BEFORE the
 * page (re)loads; it sees only upgraded WebSocket frames, so wait for `opened()` first.
 */
export function watchSocketEvents(page: Page): {
  received: (event: string) => number;
  opened: () => number;
} {
  const seen: string[] = [];
  let sockets = 0;
  page.on('websocket', (socket) => {
    sockets += 1;
    socket.on('framereceived', (frame) => {
      if (typeof frame.payload === 'string' && frame.payload.startsWith('42')) {
        seen.push(frame.payload);
      }
    });
  });
  return {
    received: (event) => seen.filter((payload) => payload.startsWith(`42["${event}"`)).length,
    opened: () => sockets,
  };
}

// ---- Redis data loss (the throwaway container only) ------------------------------------------

function redisInline(url: URL, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: url.hostname, port: Number(url.port) });
    let answer = '';
    let idle: NodeJS.Timeout | undefined;
    const finish = (): void => {
      socket.destroy();
      resolve(answer);
    };
    socket.on('connect', () => {
      socket.write(`${command}\r\n`);
    });
    socket.on('data', (chunk: Buffer) => {
      answer += chunk.toString('utf8');
      clearTimeout(idle);
      idle = setTimeout(finish, 400);
    });
    socket.on('error', reject);
    setTimeout(() => {
      reject(new Error(`redis did not answer ${command}`));
      socket.destroy();
    }, 10_000);
  });
}

/**
 * FLUSHALL on the Testcontainers Redis started by the global setup, and on nothing else: the
 * URL comes only from the environment variable the stack sets, must be a loopback address, and
 * the instance must hold this suite's keys (prefix `e2e:`) before it is flushed.
 */
export async function flushThrowawayRedis(): Promise<void> {
  const raw = process.env[THROWAWAY_REDIS_ENV];
  if (raw === undefined || raw === '') {
    throw new Error('the throwaway Redis URL is not available; run through the e2e global setup');
  }
  const url = new URL(raw);
  if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error(`refusing to flush a non-local Redis: ${url.hostname}`);
  }
  const keys = await redisInline(url, 'KEYS e2e:*');
  if (!keys.startsWith('*') || keys.startsWith('*0')) {
    throw new Error('refusing to flush: this Redis holds none of the e2e suite keys');
  }
  const flushed = await redisInline(url, 'FLUSHALL');
  expect(flushed.trim()).toBe('+OK');
}
