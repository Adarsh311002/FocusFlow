import {
  API_BASE_PATH,
  calendarDatesFrom,
  createCalendarDateFormatter,
  errorBodySchema,
  type FocusSessionListResponse,
  focusSessionListResponseSchema,
  focusSessionPaths,
  type FocusSessionSummaryResponse,
  focusSessionSummaryResponseSchema,
  type FocusSessionView,
} from '@focus-flow/contracts';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startTestHarness, stopTestHarness, type TestHarness } from '../../../test/harness.js';
import { signUpTestUser, type TestUser } from '../../../test/users.js';
import { authIdentities, authSessions, focusSessions, tasks, users } from '../../db/schema.js';
import { summarizeFocusSessions } from './review.js';
import { encodeHistoryCursor } from './review-cursor.js';

// Review: history and summary (Phase 5, V1–V8) against real PostgreSQL. Sessions are
// written directly with explicit timestamps, so every boundary is exact. The instance
// runs as `ROLE=api` (no worker): the reconciler never touches these hand-made rows.

let harness: TestHarness | undefined;

const requireHarness = (): TestHarness => {
  if (harness === undefined) {
    throw new Error('the API harness failed to start');
  }
  return harness;
};

type ApiResult = { status: number; body: unknown };

const get = async (user: TestUser | null, path: string): Promise<ApiResult> => {
  const response = await fetch(`${requireHarness().baseUrl}${API_BASE_PATH}${path}`, {
    headers: user === null ? {} : { Authorization: `Bearer ${user.accessToken}` },
  });
  const text = await response.text();
  return { status: response.status, body: text.length === 0 ? undefined : JSON.parse(text) };
};

const errorCode = (result: ApiResult): string => errorBodySchema.parse(result.body).error.code;

const history = async (user: TestUser, query = ''): Promise<FocusSessionListResponse> => {
  const result = await get(user, `${focusSessionPaths.collection}${query}`);
  expect(result.status).toBe(200);
  return focusSessionListResponseSchema.parse(result.body);
};

/** Every page, following `nextCursor` until it is `null`. */
const allPages = async (user: TestUser, query: string): Promise<FocusSessionView[][]> => {
  const pages: FocusSessionView[][] = [];
  let cursor: string | null = null;
  do {
    const suffix: string = cursor === null ? '' : `&cursor=${cursor}`;
    const page = await history(user, `?${query}${suffix}`);
    pages.push(page.sessions);
    cursor = page.nextCursor;
  } while (cursor !== null && pages.length < 50);
  return pages;
};

const summary = async (
  user: TestUser,
  from: string,
  to: string,
  tz: string,
): Promise<FocusSessionSummaryResponse> => {
  const result = await get(
    user,
    `${focusSessionPaths.summary}?from=${from}&to=${to}&tz=${encodeURIComponent(tz)}`,
  );
  expect(result.status).toBe(200);
  return focusSessionSummaryResponseSchema.parse(result.body);
};

type Seed = {
  readonly startedAt: string;
  readonly status?: 'completed' | 'abandoned' | 'in_progress';
  readonly abandonReason?: 'stopped' | 'grace_expired' | 'expired';
  readonly plannedSeconds?: number;
  readonly focusedSeconds?: number;
  /** Defaults to `startedAt` + focused seconds for ended sessions. */
  readonly endedAt?: string;
  /** In-progress only: `null` = paused (the default is running since the start). */
  readonly runningSince?: string | null;
  readonly taskId?: string;
  readonly id?: string;
};

/** Inserts a session satisfying every CHECK constraint; returns its id. */
const seed = async (user: TestUser, values: Seed): Promise<string> => {
  const status = values.status ?? 'completed';
  const plannedSeconds = values.plannedSeconds ?? 1_500;
  const focusedSeconds =
    status === 'completed'
      ? plannedSeconds
      : (values.focusedSeconds ?? Math.floor(plannedSeconds / 2));
  const startedAt = new Date(values.startedAt);
  const id = values.id ?? uuidv7();
  await requireHarness()
    .db.insert(focusSessions)
    .values({
      id,
      userId: user.userId,
      taskId: values.taskId ?? null,
      status,
      abandonReason: status === 'abandoned' ? (values.abandonReason ?? 'stopped') : null,
      plannedSeconds,
      focusedSeconds,
      runningSince:
        status === 'in_progress'
          ? values.runningSince === undefined
            ? startedAt
            : values.runningSince === null
              ? null
              : new Date(values.runningSince)
          : null,
      startedAt,
      endedAt:
        status === 'in_progress'
          ? null
          : new Date(values.endedAt ?? startedAt.getTime() + focusedSeconds * 1_000),
    });
  return id;
};

const seedTask = async (user: TestUser, title: string, deleted = false): Promise<string> => {
  const id = uuidv7();
  await requireHarness()
    .db.insert(tasks)
    .values({ id, userId: user.userId, title, deletedAt: deleted ? new Date() : null });
  return id;
};

const ids = (sessions: readonly FocusSessionView[]): string[] => sessions.map((s) => s.id);

/** The summary's documented invariants (V7). */
const expectConsistent = (result: FocusSessionSummaryResponse, from: string, to: string): void => {
  expect(result.days.map((day) => day.date)).toEqual(calendarDatesFrom(from, to));
  const sum = (pick: (day: FocusSessionSummaryResponse['days'][number]) => number) =>
    result.days.reduce((total, day) => total + pick(day), 0);
  expect(sum((day) => day.completedFocusedSeconds)).toBe(result.completedFocusedSeconds);
  expect(sum((day) => day.totalFocusedSeconds)).toBe(result.totalFocusedSeconds);
  for (const day of result.days) {
    expect(day.completedFocusedSeconds).toBeLessThanOrEqual(day.totalFocusedSeconds);
  }
};

const dayOf = (result: FocusSessionSummaryResponse, date: string) => {
  const day = result.days.find((candidate) => candidate.date === date);
  if (day === undefined) {
    throw new Error(`no entry for ${date}`);
  }
  return day;
};

beforeAll(async () => {
  harness = await startTestHarness({ ROLE: 'api' });
}, 120_000);

afterAll(async () => {
  if (harness !== undefined) {
    await stopTestHarness(harness);
  }
}, 60_000);

beforeEach(async () => {
  const { db, redis } = requireHarness();
  await db.delete(authIdentities);
  await db.delete(authSessions);
  await db.delete(users);
  await redis.flushdb();
});

describe('authentication', () => {
  it.each([
    focusSessionPaths.collection,
    `${focusSessionPaths.summary}?from=2026-10-01&to=2026-10-07&tz=UTC`,
  ])('requires a bearer token for %s', async (path) => {
    const result = await get(null, path);
    expect(result.status).toBe(401);
    expect(errorCode(result)).toBe('UNAUTHENTICATED');
  });
});

describe('GET /focus-sessions (history)', () => {
  it('returns an empty first page for a user without sessions', async () => {
    const user = await signUpTestUser(requireHarness());
    expect(await history(user)).toEqual({ sessions: [], nextCursor: null });
  });

  it('orders by start time, newest first, not by id', async () => {
    const user = await signUpTestUser(requireHarness());
    // Ids are created oldest-first, start times newest-first: id order would be reversed.
    const a = await seed(user, { startedAt: '2026-10-05T10:00:00.000Z' });
    const b = await seed(user, { startedAt: '2026-10-03T10:00:00.000Z' });
    const c = await seed(user, { startedAt: '2026-10-04T10:00:00.000Z' });
    expect(ids((await history(user)).sessions)).toEqual([a, c, b]);
  });

  it('pages without duplicates or gaps, including sessions with the same start time', async () => {
    const user = await signUpTestUser(requireHarness());
    const seeded: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      seeded.push(await seed(user, { startedAt: '2026-10-05T10:00:00.000Z' }));
    }
    seeded.push(await seed(user, { startedAt: '2026-10-06T10:00:00.000Z' }));
    seeded.push(await seed(user, { startedAt: '2026-10-04T10:00:00.000Z' }));
    seeded.push(await seed(user, { startedAt: '2026-10-05T10:00:00.001Z' }));

    const pages = await allPages(user, 'limit=2');
    expect(pages.map((page) => page.length)).toEqual([2, 2, 2, 1]);
    const listed = pages.flat();
    expect(new Set(ids(listed)).size).toBe(seeded.length);
    expect([...ids(listed)].sort()).toEqual([...seeded].sort());
    // (started_at DESC, id DESC): ties are broken by the larger id first.
    const order = [...listed].sort(
      (left, right) =>
        Date.parse(right.startedAt) - Date.parse(left.startedAt) ||
        (right.id > left.id ? 1 : right.id < left.id ? -1 : 0),
    );
    expect(ids(listed)).toEqual(ids(order));
  });

  it('returns a null cursor when the last page is exactly full', async () => {
    const user = await signUpTestUser(requireHarness());
    await seed(user, { startedAt: '2026-10-05T10:00:00.000Z' });
    await seed(user, { startedAt: '2026-10-06T10:00:00.000Z' });
    const first = await history(user, '?limit=2');
    expect(first.sessions).toHaveLength(2);
    expect(first.nextCursor).toBeNull();
  });

  it('uses the default limit of 50', async () => {
    const user = await signUpTestUser(requireHarness());
    for (let index = 0; index < 51; index += 1) {
      await seed(user, {
        startedAt: new Date(Date.UTC(2026, 0, 1) + index * 3_600_000).toISOString(),
      });
    }
    const first = await history(user);
    expect(first.sessions).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    const second = await history(user, `?cursor=${String(first.nextCursor)}`);
    expect(second.sessions).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });

  it('filters by start time in [from, to), exactly at the millisecond', async () => {
    const user = await signUpTestUser(requireHarness());
    await seed(user, { startedAt: '2026-10-04T23:59:59.999Z' });
    const atFrom = await seed(user, { startedAt: '2026-10-05T00:00:00.000Z' });
    const beforeTo = await seed(user, { startedAt: '2026-10-05T23:59:59.999Z' });
    await seed(user, { startedAt: '2026-10-06T00:00:00.000Z' });

    const page = await history(user, '?from=2026-10-05T00:00:00.000Z&to=2026-10-06T00:00:00.000Z');
    expect(ids(page.sessions)).toEqual([beforeTo, atFrom]);

    // An offset in the bound means the same instant.
    const shifted = await history(
      user,
      `?from=${encodeURIComponent('2026-10-05T05:30:00.000+05:30')}&to=2026-10-06T00:00:00Z`,
    );
    expect(ids(shifted.sessions)).toEqual([beforeTo, atFrom]);

    expect(ids((await history(user, '?from=2026-10-05T00:00:00.000Z')).sessions)).toHaveLength(3);
    expect(ids((await history(user, '?to=2026-10-05T00:00:00.000Z')).sessions)).toHaveLength(1);
  });

  it('keeps the range filter across pages', async () => {
    const user = await signUpTestUser(requireHarness());
    const inside: string[] = [];
    for (let day = 1; day <= 9; day += 1) {
      const id = await seed(user, { startedAt: `2026-10-0${String(day)}T12:00:00.000Z` });
      if (day >= 3 && day <= 7) {
        inside.push(id);
      }
    }
    const pages = await allPages(
      user,
      'limit=2&from=2026-10-03T00:00:00.000Z&to=2026-10-08T00:00:00.000Z',
    );
    expect(ids(pages.flat())).toEqual([...inside].reverse());
  });

  it('never shows another user’s sessions, and rejects a cursor naming one', async () => {
    const h = requireHarness();
    const me = await signUpTestUser(h, 'me');
    const other = await signUpTestUser(h, 'other');
    const mine = await seed(me, { startedAt: '2026-10-05T10:00:00.000Z' });
    const theirs = await seed(other, { startedAt: '2026-10-06T10:00:00.000Z' });
    await seed(other, { startedAt: '2026-10-04T10:00:00.000Z' });

    expect(ids((await history(me)).sessions)).toEqual([mine]);

    const foreign = await get(
      me,
      `${focusSessionPaths.collection}?cursor=${encodeHistoryCursor(theirs)}`,
    );
    expect(foreign.status).toBe(400);
    expect(errorCode(foreign)).toBe('VALIDATION_FAILED');
    const unknown = await get(
      me,
      `${focusSessionPaths.collection}?cursor=${encodeHistoryCursor(uuidv7())}`,
    );
    expect(unknown.status).toBe(400);
  });

  it('includes each session’s task, keeping soft-deleted tasks marked as deleted (D38)', async () => {
    const user = await signUpTestUser(requireHarness());
    const live = await seedTask(user, 'Write report');
    const removed = await seedTask(user, 'Old chore', true);
    const withLive = await seed(user, { startedAt: '2026-10-05T10:00:00.000Z', taskId: live });
    const withRemoved = await seed(user, {
      startedAt: '2026-10-04T10:00:00.000Z',
      taskId: removed,
    });
    const withNone = await seed(user, { startedAt: '2026-10-03T10:00:00.000Z' });

    const byId = new Map<string, FocusSessionView>(
      (await history(user)).sessions.map((session) => [session.id, session]),
    );
    expect(byId.get(withLive)?.task).toEqual({ id: live, title: 'Write report', deleted: false });
    expect(byId.get(withRemoved)?.task).toEqual({ id: removed, title: 'Old chore', deleted: true });
    expect(byId.get(withNone)?.task).toBeNull();
    // Persistence-only fields never leave the API.
    for (const session of byId.values()) {
      expect(session).not.toHaveProperty('userId');
      expect(session.task ?? {}).not.toHaveProperty('deletedAt');
    }
  });

  it('shows completed, abandoned, running and paused sessions as the contract defines them', async () => {
    const user = await signUpTestUser(requireHarness());
    const now = Date.now();
    const at = (offsetMinutes: number) => new Date(now - offsetMinutes * 60_000).toISOString();
    const completed = await seed(user, { startedAt: at(500), plannedSeconds: 1_500 });
    const stopped = await seed(user, {
      startedAt: at(400),
      status: 'abandoned',
      abandonReason: 'stopped',
      focusedSeconds: 600,
    });
    const graceExpired = await seed(user, {
      startedAt: at(300),
      status: 'abandoned',
      abandonReason: 'grace_expired',
      focusedSeconds: 120,
    });
    const expired = await seed(user, {
      startedAt: at(200),
      status: 'abandoned',
      abandonReason: 'expired',
      focusedSeconds: 0,
    });
    const paused = await seed(user, {
      startedAt: at(10),
      status: 'in_progress',
      runningSince: null,
      focusedSeconds: 300,
    });

    const sessions = (await history(user)).sessions;
    expect(ids(sessions)).toEqual([paused, expired, graceExpired, stopped, completed]);
    expect(sessions[0]).toMatchObject({
      status: 'in_progress',
      runningSince: null,
      focusedSeconds: 300,
    });
    expect(sessions[1]).toMatchObject({
      status: 'abandoned',
      abandonReason: 'expired',
      focusedSeconds: 0,
    });
    expect(sessions[2]).toMatchObject({ status: 'abandoned', abandonReason: 'grace_expired' });
    expect(sessions[3]).toMatchObject({
      status: 'abandoned',
      abandonReason: 'stopped',
      plannedSeconds: 1_500,
      focusedSeconds: 600,
    });
    expect(sessions[4]).toMatchObject({
      status: 'completed',
      plannedSeconds: 1_500,
      focusedSeconds: 1_500,
    });

    // A running session reports when its current stretch began.
    await requireHarness()
      .db.delete(focusSessions)
      .where(sql`${focusSessions.id} = ${paused}`);
    const running = await seed(user, { startedAt: at(5), status: 'in_progress' });
    const [first] = (await history(user)).sessions;
    expect(first).toMatchObject({ id: running, status: 'in_progress', runningSince: at(5) });
  });

  it.each([
    'limit=0',
    'limit=101',
    'limit=abc',
    'from=yesterday',
    'from=2026-10-05',
    'from=2026-10-05T10:00:00',
    'from=2026-10-05T10:00:00.0001Z',
    'from=2026-10-06T00:00:00Z&to=2026-10-05T00:00:00Z',
    'from=2026-10-05T00:00:00Z&to=2026-10-05T00:00:00Z',
    'cursor=not-a-cursor',
    'userId=someone',
    'limit=2&limit=3',
    'limit=',
    'cursor=',
    'from=2026-10-05T00:00:00Z&from=2026-10-06T00:00:00Z',
    'cursor=a&cursor=b',
    // Instants outside the supported range: before 1970, the BC era and year 10000. A
    // four-digit year is not enough on its own — the offset decides the instant.
    'from=1969-12-31T23:59:59.999Z',
    'from=0000-01-01T00:00:00.000Z',
    `from=${encodeURIComponent('0000-01-01T00:00:00.000+14:00')}`,
    `to=${encodeURIComponent('9999-12-31T23:59:59.999-12:00')}`,
    'to=%2B010000-01-01T00:00:00.000Z',
    'from=2026-12-31T23:59:60.000Z',
  ])('rejects the query %s with 400 VALIDATION_FAILED', async (query) => {
    const user = await signUpTestUser(requireHarness());
    const result = await get(user, `${focusSessionPaths.collection}?${query}`);
    expect(result.status).toBe(400);
    expect(errorCode(result)).toBe('VALIDATION_FAILED');
  });
});

describe('GET /focus-sessions/summary', () => {
  it('returns zeros and one entry per date for an empty period', async () => {
    const user = await signUpTestUser(requireHarness());
    const result = await summary(user, '2026-10-01', '2026-10-07', 'Europe/Berlin');
    expect(result).toEqual({
      completedCount: 0,
      completedFocusedSeconds: 0,
      totalFocusedSeconds: 0,
      days: calendarDatesFrom('2026-10-01', '2026-10-07').map((date) => ({
        date,
        completedFocusedSeconds: 0,
        totalFocusedSeconds: 0,
      })),
    });
  });

  it('returns a single entry for a one-day range', async () => {
    const user = await signUpTestUser(requireHarness());
    await seed(user, { startedAt: '2026-10-05T10:00:00.000Z', plannedSeconds: 600 });
    const result = await summary(user, '2026-10-05', '2026-10-05', 'UTC');
    expect(result).toEqual({
      completedCount: 1,
      completedFocusedSeconds: 600,
      totalFocusedSeconds: 600,
      days: [{ date: '2026-10-05', completedFocusedSeconds: 600, totalFocusedSeconds: 600 }],
    });
  });

  it('counts completed time in both totals, abandoned time only in the total, and skips in-progress sessions', async () => {
    const user = await signUpTestUser(requireHarness());
    await seed(user, { startedAt: '2026-10-05T08:00:00.000Z', plannedSeconds: 1_500 });
    await seed(user, { startedAt: '2026-10-05T09:00:00.000Z', plannedSeconds: 3_000 });
    await seed(user, {
      startedAt: '2026-10-05T10:00:00.000Z',
      status: 'abandoned',
      abandonReason: 'stopped',
      focusedSeconds: 700,
    });
    await seed(user, {
      startedAt: '2026-10-05T11:00:00.000Z',
      status: 'abandoned',
      abandonReason: 'grace_expired',
      focusedSeconds: 200,
    });
    await seed(user, {
      startedAt: '2026-10-05T12:00:00.000Z',
      status: 'abandoned',
      abandonReason: 'expired',
      focusedSeconds: 50,
    });
    // In progress (paused, with recorded time): not final, so not counted.
    await seed(user, {
      startedAt: '2026-10-05T13:00:00.000Z',
      status: 'in_progress',
      runningSince: null,
      focusedSeconds: 900,
    });

    const result = await summary(user, '2026-10-05', '2026-10-05', 'UTC');
    expect(result.completedCount).toBe(2);
    expect(result.completedFocusedSeconds).toBe(4_500);
    expect(result.totalFocusedSeconds).toBe(4_500 + 700 + 200 + 50);
    expectConsistent(result, '2026-10-05', '2026-10-05');
  });

  it('skips a running session too', async () => {
    const user = await signUpTestUser(requireHarness());
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    await seed(user, { startedAt, status: 'in_progress', focusedSeconds: 0 });
    const today = startedAt.slice(0, 10);
    const result = await summary(user, today, today, 'UTC');
    expect(result.completedCount).toBe(0);
    expect(result.totalFocusedSeconds).toBe(0);
  });

  it('reports a period with only abandoned sessions', async () => {
    const user = await signUpTestUser(requireHarness());
    await seed(user, {
      startedAt: '2026-10-03T10:00:00.000Z',
      status: 'abandoned',
      focusedSeconds: 400,
    });
    const result = await summary(user, '2026-10-01', '2026-10-07', 'UTC');
    expect(result.completedCount).toBe(0);
    expect(result.completedFocusedSeconds).toBe(0);
    expect(result.totalFocusedSeconds).toBe(400);
    expect(dayOf(result, '2026-10-03')).toEqual({
      date: '2026-10-03',
      completedFocusedSeconds: 0,
      totalFocusedSeconds: 400,
    });
    expectConsistent(result, '2026-10-01', '2026-10-07');
  });

  it('counts a session that crosses midnight entirely on the date it started', async () => {
    const user = await signUpTestUser(requireHarness());
    await seed(user, {
      startedAt: '2026-10-05T23:50:00.000Z',
      plannedSeconds: 1_500,
      endedAt: '2026-10-06T00:15:00.000Z',
    });
    const result = await summary(user, '2026-10-05', '2026-10-06', 'UTC');
    expect(dayOf(result, '2026-10-05').completedFocusedSeconds).toBe(1_500);
    expect(dayOf(result, '2026-10-06').completedFocusedSeconds).toBe(0);
  });

  it('never counts another user’s sessions', async () => {
    const h = requireHarness();
    const me = await signUpTestUser(h, 'me');
    const other = await signUpTestUser(h, 'other');
    await seed(me, { startedAt: '2026-10-05T10:00:00.000Z', plannedSeconds: 600 });
    await seed(other, { startedAt: '2026-10-05T11:00:00.000Z', plannedSeconds: 1_200 });
    await seed(other, {
      startedAt: '2026-10-05T12:00:00.000Z',
      status: 'abandoned',
      focusedSeconds: 99,
    });
    const result = await summary(me, '2026-10-05', '2026-10-05', 'UTC');
    expect(result.completedCount).toBe(1);
    expect(result.totalFocusedSeconds).toBe(600);
  });

  it('includes the first and last local instants of the range and nothing outside it', async () => {
    const user = await signUpTestUser(requireHarness());
    // Europe/Berlin is UTC+2 in early October 2026.
    await seed(user, { startedAt: '2026-09-30T21:59:59.999Z', plannedSeconds: 60 }); // 09-30 23:59:59.999
    await seed(user, { startedAt: '2026-09-30T22:00:00.000Z', plannedSeconds: 120 }); // 10-01 00:00
    await seed(user, { startedAt: '2026-10-07T21:59:59.999Z', plannedSeconds: 180 }); // 10-07 23:59:59.999
    await seed(user, { startedAt: '2026-10-07T22:00:00.000Z', plannedSeconds: 240 }); // 10-08 00:00
    const result = await summary(user, '2026-10-01', '2026-10-07', 'Europe/Berlin');
    expect(result.completedCount).toBe(2);
    expect(dayOf(result, '2026-10-01').completedFocusedSeconds).toBe(120);
    expect(dayOf(result, '2026-10-07').completedFocusedSeconds).toBe(180);
    expectConsistent(result, '2026-10-01', '2026-10-07');
  });

  it('includes the extreme local edges the widened range exists for', async () => {
    const user = await signUpTestUser(requireHarness());
    // The read range is widened by whole days because a local date can sit up to 14 hours
    // ahead of UTC or 12 behind. These two sessions are the outermost local instants of
    // the range in those zones, and each one lies outside the unwidened UTC window: with
    // less slack on either side they would silently vanish from the totals.
    await seed(user, { startedAt: '2026-10-14T10:00:00.000Z', plannedSeconds: 300 }); // +14: 10-15 00:00
    await seed(user, { startedAt: '2026-10-18T10:59:00.000Z', plannedSeconds: 420 }); // −11: 10-17 23:59
    const east = await summary(user, '2026-10-15', '2026-10-17', 'Pacific/Kiritimati');
    expect(dayOf(east, '2026-10-15').completedFocusedSeconds).toBe(300);
    expectConsistent(east, '2026-10-15', '2026-10-17');
    const west = await summary(user, '2026-10-15', '2026-10-17', 'Pacific/Pago_Pago');
    expect(dayOf(west, '2026-10-17').completedFocusedSeconds).toBe(420);
    expectConsistent(west, '2026-10-15', '2026-10-17');
  });

  it('answers for a range at the last supported date instead of failing', async () => {
    // Widening 9999-12-31 by three days leaves the four-digit ISO year, which the driver
    // would spell `+010000-…`; the end is clamped instead, so this is an ordinary 200.
    const user = await signUpTestUser(requireHarness());
    // A session on the last full day still counts; the clamp only removes slack past it.
    await seed(user, { startedAt: '9999-12-31T12:00:00.000Z', plannedSeconds: 600 });
    const result = await summary(user, '9999-12-29', '9999-12-31', 'UTC');
    expect(dayOf(result, '9999-12-31').completedFocusedSeconds).toBe(600);
    expect(result.completedCount).toBe(1);
    expectConsistent(result, '9999-12-29', '9999-12-31');
  });

  it('assigns the same instant to different dates in different time zones', async () => {
    const user = await signUpTestUser(requireHarness());
    await seed(user, { startedAt: '2026-10-16T10:30:00.000Z', plannedSeconds: 600 });
    const east = await summary(user, '2026-10-15', '2026-10-17', 'Pacific/Kiritimati'); // UTC+14
    const west = await summary(user, '2026-10-15', '2026-10-17', 'Pacific/Pago_Pago'); // UTC−11
    const utc = await summary(user, '2026-10-15', '2026-10-17', 'UTC');
    expect(dayOf(east, '2026-10-17').completedFocusedSeconds).toBe(600);
    expect(dayOf(west, '2026-10-15').completedFocusedSeconds).toBe(600);
    expect(dayOf(utc, '2026-10-16').completedFocusedSeconds).toBe(600);
    for (const result of [east, west, utc]) {
      expect(result.completedFocusedSeconds).toBe(600);
    }
  });

  it('splits days at local midnight for a half-hour offset, and accepts the legacy alias', async () => {
    const user = await signUpTestUser(requireHarness());
    await seed(user, { startedAt: '2026-10-15T18:29:59.999Z', plannedSeconds: 60 }); // 23:59:59.999 IST
    await seed(user, { startedAt: '2026-10-15T18:30:00.000Z', plannedSeconds: 120 }); // 00:00 IST
    const kolkata = await summary(user, '2026-10-15', '2026-10-16', 'Asia/Kolkata');
    expect(dayOf(kolkata, '2026-10-15').completedFocusedSeconds).toBe(60);
    expect(dayOf(kolkata, '2026-10-16').completedFocusedSeconds).toBe(120);
    // Browsers may report the legacy name; it must mean the same zone.
    expect(await summary(user, '2026-10-15', '2026-10-16', 'Asia/Calcutta')).toEqual(kolkata);
  });

  it('handles the 23-hour day when daylight saving time starts (America/New_York)', async () => {
    const user = await signUpTestUser(requireHarness());
    await seed(user, { startedAt: '2026-03-08T04:59:59.999Z', plannedSeconds: 60 }); // 03-07 23:59:59 EST
    await seed(user, { startedAt: '2026-03-08T05:00:00.000Z', plannedSeconds: 120 }); // 03-08 00:00 EST
    await seed(user, { startedAt: '2026-03-08T07:30:00.000Z', plannedSeconds: 180 }); // 03-08 03:30 EDT
    await seed(user, { startedAt: '2026-03-09T03:59:59.999Z', plannedSeconds: 240 }); // 03-08 23:59:59 EDT
    await seed(user, { startedAt: '2026-03-09T04:00:00.000Z', plannedSeconds: 300 }); // 03-09 00:00 EDT
    const result = await summary(user, '2026-03-07', '2026-03-09', 'America/New_York');
    expect(result.days.map((day) => day.completedFocusedSeconds)).toEqual([
      60,
      120 + 180 + 240,
      300,
    ]);
    expectConsistent(result, '2026-03-07', '2026-03-09');
  });

  it('handles the 25-hour day when daylight saving time ends (America/New_York)', async () => {
    const user = await signUpTestUser(requireHarness());
    await seed(user, { startedAt: '2026-11-01T05:30:00.000Z', plannedSeconds: 60 }); // 01:30 EDT
    await seed(user, { startedAt: '2026-11-01T06:30:00.000Z', plannedSeconds: 120 }); // 01:30 EST
    await seed(user, { startedAt: '2026-11-02T04:59:59.999Z', plannedSeconds: 180 }); // 11-01 23:59:59 EST
    await seed(user, { startedAt: '2026-11-02T05:00:00.000Z', plannedSeconds: 240 }); // 11-02 00:00 EST
    const result = await summary(user, '2026-11-01', '2026-11-02', 'America/New_York');
    expect(result.days.map((day) => day.completedFocusedSeconds)).toEqual([60 + 120 + 180, 240]);
  });

  it('handles a day whose midnight does not exist (America/Santiago)', async () => {
    const user = await signUpTestUser(requireHarness());
    await seed(user, { startedAt: '2026-09-06T03:59:59.999Z', plannedSeconds: 60 }); // 09-05 23:59:59 −04
    await seed(user, { startedAt: '2026-09-06T04:00:00.000Z', plannedSeconds: 120 }); // 09-06 01:00 −03
    const result = await summary(user, '2026-09-05', '2026-09-06', 'America/Santiago');
    expect(result.days.map((day) => day.completedFocusedSeconds)).toEqual([60, 120]);
  });

  it('handles a half-hour daylight saving change (Australia/Lord_Howe)', async () => {
    const user = await signUpTestUser(requireHarness());
    await seed(user, { startedAt: '2026-10-03T13:29:59.999Z', plannedSeconds: 60 }); // 10-03 23:59:59 +10:30
    await seed(user, { startedAt: '2026-10-03T13:30:00.000Z', plannedSeconds: 120 }); // 10-04 00:00 +10:30
    await seed(user, { startedAt: '2026-10-03T15:30:00.000Z', plannedSeconds: 180 }); // 10-04 02:30 +11
    const result = await summary(user, '2026-10-03', '2026-10-04', 'Australia/Lord_Howe');
    expect(result.days.map((day) => day.completedFocusedSeconds)).toEqual([60, 120 + 180]);
  });

  it('matches an independent per-session calculation for many sessions and zones', async () => {
    const user = await signUpTestUser(requireHarness());
    // A deterministic spread of sessions over 12 days (a simple LCG, no randomness).
    let state = 42;
    const next = (bound: number): number => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state % bound;
    };
    const seeded: { startedAtMs: number; status: 'completed' | 'abandoned'; focused: number }[] =
      [];
    let cursorMs = Date.parse('2026-10-20T00:00:00.000Z');
    for (let index = 0; index < 60; index += 1) {
      cursorMs += (next(300) + 60) * 60_000;
      const completed = next(3) !== 0;
      const planned = 60 + next(3_000);
      const focused = completed ? planned : next(planned);
      seeded.push({
        startedAtMs: cursorMs,
        status: completed ? 'completed' : 'abandoned',
        focused,
      });
      await seed(user, {
        startedAt: new Date(cursorMs).toISOString(),
        status: completed ? 'completed' : 'abandoned',
        plannedSeconds: planned,
        focusedSeconds: focused,
      });
    }
    const from = '2026-10-21';
    const to = '2026-10-29';
    for (const tz of [
      'UTC',
      'America/Los_Angeles',
      'Asia/Kathmandu',
      'Pacific/Chatham',
      'Europe/London',
    ]) {
      const dateOf = createCalendarDateFormatter(tz);
      const expected = new Map(calendarDatesFrom(from, to).map((date) => [date, { c: 0, t: 0 }]));
      let completedCount = 0;
      for (const session of seeded) {
        const entry = expected.get(dateOf(session.startedAtMs));
        if (entry === undefined) {
          continue;
        }
        entry.t += session.focused;
        if (session.status === 'completed') {
          entry.c += session.focused;
          completedCount += 1;
        }
      }
      const result = await summary(user, from, to, tz);
      expect(result.completedCount).toBe(completedCount);
      expect(result.days).toEqual(
        [...expected].map(([date, { c, t }]) => ({
          date,
          completedFocusedSeconds: c,
          totalFocusedSeconds: t,
        })),
      );
      expectConsistent(result, from, to);
    }
  });

  it('does not depend on the database session time zone', async () => {
    const user = await signUpTestUser(requireHarness());
    await seed(user, { startedAt: '2026-10-15T18:29:59.999Z', plannedSeconds: 60 });
    await seed(user, { startedAt: '2026-10-15T18:30:00.000Z', plannedSeconds: 120 });
    const query = { from: '2026-10-15', to: '2026-10-16', tz: 'Asia/Kolkata' };
    const viaApi = await summary(user, query.from, query.to, query.tz);
    const h = requireHarness();
    const withOtherZone = await h.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL TimeZone = 'America/St_Johns'`);
      return summarizeFocusSessions({ db: tx }, user.userId, query);
    });
    expect(withOtherZone).toEqual(viaApi);
  });

  it('accepts a range of exactly 366 days', async () => {
    const user = await signUpTestUser(requireHarness());
    const result = await summary(user, '2027-01-01', '2028-01-01', 'UTC');
    expect(result.days).toHaveLength(366);
  });

  it.each([
    ['missing tz', 'from=2026-10-01&to=2026-10-07'],
    ['missing from', 'to=2026-10-07&tz=UTC'],
    ['missing to', 'from=2026-10-01&tz=UTC'],
    ['to before from', 'from=2026-10-07&to=2026-10-01&tz=UTC'],
    ['367 days', 'from=2027-01-01&to=2028-01-02&tz=UTC'],
    ['an impossible date', 'from=2026-02-29&to=2026-03-01&tz=UTC'],
    ['a timestamp instead of a date', 'from=2026-10-01T00:00:00Z&to=2026-10-07&tz=UTC'],
    ['a date before 1970', 'from=1969-12-31&to=1970-01-01&tz=UTC'],
    ['a date past the four-digit year range', 'from=10000-01-01&to=10000-01-02&tz=UTC'],
    ['an unknown key', 'from=2026-10-01&to=2026-10-07&tz=UTC&userId=x'],
    ['a repeated tz', 'from=2026-10-01&to=2026-10-07&tz=UTC&tz=Europe/Berlin'],
    ['a repeated from', 'from=2026-10-01&from=2026-10-02&to=2026-10-07&tz=UTC'],
    ...[
      'UTC+3',
      '+05:30',
      '-03:00',
      'PST',
      'EST5EDT',
      'localtime',
      'posixrules',
      'Foo/Bar',
      '',
      "UTC'; --",
      `Europe/${'x'.repeat(80)}`,
    ].map((tz) => [
      `tz ${JSON.stringify(tz)}`,
      `from=2026-10-01&to=2026-10-07&tz=${encodeURIComponent(tz)}`,
    ]),
  ])('rejects %s with 400 VALIDATION_FAILED', async (_label, query) => {
    const user = await signUpTestUser(requireHarness());
    const result = await get(user, `${focusSessionPaths.summary}?${query}`);
    expect(result.status).toBe(400);
    expect(errorCode(result)).toBe('VALIDATION_FAILED');
  });
});
