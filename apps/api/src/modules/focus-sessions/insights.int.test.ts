import {
  API_BASE_PATH,
  DAILY_GOAL_SECONDS,
  errorBodySchema,
  type FocusSessionInsightsResponse,
  focusSessionInsightsResponseSchema,
  focusSessionPaths,
  mePaths,
  meResponseSchema,
} from '@focus-flow/contracts';
import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startTestHarness, stopTestHarness, type TestHarness } from '../../../test/harness.js';
import { signUpTestUser, type TestUser } from '../../../test/users.js';
import {
  authIdentities,
  authSessions,
  focusSessions,
  rooms,
  tasks,
  users,
} from '../../db/schema.js';
import { getFocusInsights } from './review.js';

// Dashboard insights (A1–A10) against real PostgreSQL. Sessions are written directly with
// explicit timestamps. `getFocusInsights` is called with an injected clock where "today"
// matters; the HTTP route is covered for validation, isolation and the goal endpoint.

let harness: TestHarness | undefined;

const requireHarness = (): TestHarness => {
  if (harness === undefined) {
    throw new Error('the API harness failed to start');
  }
  return harness;
};

type ApiResult = { status: number; body: unknown };

const call = async (
  user: TestUser | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult> => {
  const response = await fetch(`${requireHarness().baseUrl}${API_BASE_PATH}${path}`, {
    method,
    headers: {
      ...(user === null ? {} : { Authorization: `Bearer ${user.accessToken}` }),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text.length === 0 ? undefined : JSON.parse(text) };
};

const errorCode = (result: ApiResult): string => errorBodySchema.parse(result.body).error.code;

const insightsPath = (from: string, to: string, tz: string): string =>
  `${focusSessionPaths.insights}?from=${from}&to=${to}&tz=${encodeURIComponent(tz)}`;

const fetchInsights = async (
  user: TestUser,
  from: string,
  to: string,
  tz: string,
): Promise<FocusSessionInsightsResponse> => {
  const result = await call(user, 'GET', insightsPath(from, to, tz));
  expect(result.status).toBe(200);
  return focusSessionInsightsResponseSchema.parse(result.body);
};

type Seed = {
  readonly startedAt: string;
  readonly status?: 'completed' | 'abandoned' | 'in_progress';
  readonly focusedSeconds?: number;
  readonly taskId?: string;
  readonly roomId?: string;
};

const seedRoom = async (host: TestUser): Promise<string> => {
  const id = uuidv7();
  await requireHarness()
    .db.insert(rooms)
    .values({
      id,
      code: Array.from({ length: 6 }, () => 'ABCDEFGH'[Math.floor(Math.random() * 8)]).join(''),
      name: 'Insights room',
      hostId: host.userId,
      isPrivate: false,
    });
  return id;
};

const seed = async (user: TestUser, values: Seed): Promise<void> => {
  const status = values.status ?? 'completed';
  const plannedSeconds = 1_500;
  const focusedSeconds =
    status === 'completed' ? plannedSeconds : (values.focusedSeconds ?? plannedSeconds / 2);
  const startedAt = new Date(values.startedAt);
  await requireHarness()
    .db.insert(focusSessions)
    .values({
      id: uuidv7(),
      userId: user.userId,
      taskId: values.taskId ?? null,
      status,
      abandonReason: status === 'abandoned' ? 'stopped' : null,
      roomId: values.roomId ?? null,
      focusRunId: values.roomId === undefined ? null : uuidv7(),
      plannedSeconds,
      focusedSeconds,
      runningSince: status === 'in_progress' ? startedAt : null,
      startedAt,
      endedAt:
        status === 'in_progress' ? null : new Date(startedAt.getTime() + focusedSeconds * 1_000),
    });
};

const seedTask = async (user: TestUser, title: string, deleted = false): Promise<string> => {
  const id = uuidv7();
  await requireHarness()
    .db.insert(tasks)
    .values({ id, userId: user.userId, title, deletedAt: deleted ? new Date() : null });
  return id;
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
  await db.delete(focusSessions);
  await db.delete(rooms);
  await db.delete(authIdentities);
  await db.delete(authSessions);
  await db.delete(users);
  await redis.flushdb();
});

describe('GET /focus-sessions/insights', () => {
  it('requires authentication and validates the range like the summary', async () => {
    expect((await call(null, 'GET', insightsPath('2026-10-01', '2026-10-07', 'UTC'))).status).toBe(
      401,
    );
    const user = await signUpTestUser(requireHarness());
    for (const bad of [
      insightsPath('2026-10-07', '2026-10-01', 'UTC'),
      insightsPath('2026-01-01', '2027-01-02', 'UTC'),
      insightsPath('2026-10-01', '2026-10-07', 'PST'),
      `${focusSessionPaths.insights}?from=2026-10-01&to=2026-10-07`,
      `${insightsPath('2026-10-01', '2026-10-07', 'UTC')}&extra=1`,
    ]) {
      const result = await call(user, 'GET', bad);
      expect(result.status, bad).toBe(400);
      expect(errorCode(result)).toBe('VALIDATION_FAILED');
    }
    // 366 days is the largest accepted range.
    expect((await call(user, 'GET', insightsPath('2026-01-01', '2027-01-01', 'UTC'))).status).toBe(
      200,
    );
  });

  it('answers a full, zeroed picture for a user without sessions', async () => {
    const user = await signUpTestUser(requireHarness());
    const result = await fetchInsights(user, '2026-10-01', '2026-10-07', 'Europe/Berlin');
    expect(result.dailyGoalSeconds).toBe(DAILY_GOAL_SECONDS.default);
    expect(result.days).toHaveLength(7);
    expect(result.totals).toMatchObject({ sessionCount: 0, completionRate: null });
    expect(result.streak).toMatchObject({ current: 0, longest: 0, todayCompleted: false });
    expect(result.tasks).toEqual([]);
    expect(result.heatmap).toHaveLength(168);
    expect(result.comparison.previousFrom).toBe('2026-09-24');
    expect(result.comparison.previousTo).toBe('2026-09-30');
  });

  it('keeps users apart: another user sessions, tasks and goal never appear', async () => {
    const alice = await signUpTestUser(requireHarness(), 'alice');
    const bob = await signUpTestUser(requireHarness(), 'bob');
    const bobTask = await seedTask(bob, 'Bob secret');
    await seed(bob, { startedAt: '2026-10-05T10:00:00Z', taskId: bobTask });
    await requireHarness()
      .db.update(users)
      .set({ dailyGoalSeconds: 600 })
      .where(eq(users.id, bob.userId));
    const result = await fetchInsights(alice, '2026-10-01', '2026-10-07', 'UTC');
    expect(result.totals.sessionCount).toBe(0);
    expect(result.tasks).toEqual([]);
    expect(result.dailyGoalSeconds).toBe(DAILY_GOAL_SECONDS.default);
    expect(JSON.stringify(result)).not.toContain('Bob secret');
  });

  it('counts ended sessions only, on their local start date, with the goal and completion rate', async () => {
    const user = await signUpTestUser(requireHarness());
    // 2026-10-05T22:30Z is already 2026-10-06 in Berlin (CEST, +02:00).
    await seed(user, { startedAt: '2026-10-05T22:30:00Z' });
    await seed(user, {
      startedAt: '2026-10-05T08:00:00Z',
      status: 'abandoned',
      focusedSeconds: 600,
    });
    await seed(user, { startedAt: '2026-10-05T09:00:00Z', status: 'in_progress' });
    const berlin = await fetchInsights(user, '2026-10-05', '2026-10-06', 'Europe/Berlin');
    expect(berlin.days.map((d) => [d.date, d.sessionCount, d.totalFocusedSeconds])).toEqual([
      ['2026-10-05', 1, 600],
      ['2026-10-06', 1, 1_500],
    ]);
    expect(berlin.totals).toMatchObject({
      sessionCount: 2,
      completedCount: 1,
      abandonedCount: 1,
      completionRate: 0.5,
    });
    const utc = await fetchInsights(user, '2026-10-05', '2026-10-06', 'UTC');
    expect(utc.days.map((d) => d.sessionCount)).toEqual([2, 0]);
  });

  it('lets the user change the daily goal and reports per-day progress against it', async () => {
    const user = await signUpTestUser(requireHarness());
    await seed(user, { startedAt: '2026-10-05T10:00:00Z' });
    await seed(user, { startedAt: '2026-10-05T11:00:00Z' });

    const patch = await call(user, 'PATCH', mePaths.self, { dailyGoalSeconds: 3_000 });
    expect(patch.status).toBe(200);
    expect(meResponseSchema.parse(patch.body).user.dailyGoalSeconds).toBe(3_000);
    expect(
      meResponseSchema.parse((await call(user, 'GET', mePaths.self)).body).user.dailyGoalSeconds,
    ).toBe(3_000);

    const result = await fetchInsights(user, '2026-10-05', '2026-10-06', 'UTC');
    expect(result.dailyGoalSeconds).toBe(3_000);
    expect(result.days[0]).toMatchObject({ goalProgress: 1, goalMet: true });
    expect(result.days[1]).toMatchObject({ goalProgress: 0, goalMet: false });
    expect(result.goalDaysMet).toBe(1);
  });

  it('changes the display name, the avatar and the default session length (ST1–ST3)', async () => {
    const user = await signUpTestUser(requireHarness());
    const fresh = meResponseSchema.parse((await call(user, 'GET', mePaths.self)).body).user;
    expect(fresh).toMatchObject({ avatarPreset: null, defaultSessionSeconds: 1_500 });

    const patch = await call(user, 'PATCH', mePaths.self, {
      displayName: '  Ada  ',
      avatarPreset: 'sloth',
      defaultSessionSeconds: 3_000,
    });
    expect(patch.status).toBe(200);
    expect(meResponseSchema.parse(patch.body).user).toMatchObject({
      displayName: 'Ada',
      avatarPreset: 'sloth',
      defaultSessionSeconds: 3_000,
    });
    const back = await call(user, 'PATCH', mePaths.self, { avatarPreset: null });
    expect(meResponseSchema.parse(back.body).user.avatarPreset).toBeNull();
  });

  it('rejects an out-of-bounds, unknown or empty settings update', async () => {
    const user = await signUpTestUser(requireHarness());
    for (const body of [
      { dailyGoalSeconds: DAILY_GOAL_SECONDS.min - 1 },
      { dailyGoalSeconds: DAILY_GOAL_SECONDS.max + 1 },
      { dailyGoalSeconds: 1_800.5 },
      { dailyGoalSeconds: '3600' },
      // The email is not a setting (unknown keys are refused).
      { email: 'mallory@example.com' },
      { displayName: '   ' },
      { avatarPreset: 'dragon' },
      { defaultSessionSeconds: 59 },
      { defaultSessionSeconds: 1_530 },
      {},
    ]) {
      const result = await call(user, 'PATCH', mePaths.self, body);
      expect(result.status, JSON.stringify(body)).toBe(400);
      expect(errorCode(result)).toBe('VALIDATION_FAILED');
    }
    expect((await call(null, 'PATCH', mePaths.self, { dailyGoalSeconds: 3_600 })).status).toBe(401);
    // The bounds themselves are accepted.
    for (const value of [DAILY_GOAL_SECONDS.min, DAILY_GOAL_SECONDS.max]) {
      expect((await call(user, 'PATCH', mePaths.self, { dailyGoalSeconds: value })).status).toBe(
        200,
      );
    }
  });

  it('ranks tasks, flags deleted ones, keeps a no-task bucket and splits solo from room', async () => {
    const user = await signUpTestUser(requireHarness());
    const big = await seedTask(user, 'Write report');
    const gone = await seedTask(user, 'Old chore', true);
    const roomId = await seedRoom(user);
    await seed(user, { startedAt: '2026-10-05T08:00:00Z', taskId: big });
    await seed(user, { startedAt: '2026-10-05T09:00:00Z', taskId: big });
    await seed(user, {
      startedAt: '2026-10-05T10:00:00Z',
      taskId: gone,
      status: 'abandoned',
      focusedSeconds: 300,
    });
    await seed(user, { startedAt: '2026-10-05T11:00:00Z' });
    await seed(user, { startedAt: '2026-10-05T12:00:00Z', roomId, taskId: big });
    const result = await fetchInsights(user, '2026-10-05', '2026-10-05', 'UTC');
    expect(
      result.tasks.map((t) => [t.title, t.deleted, t.sessionCount, t.totalFocusedSeconds]),
    ).toEqual([
      ['Write report', false, 3, 4_500],
      ['Old chore', true, 1, 300],
    ]);
    expect(result.noTask).toEqual({
      sessionCount: 1,
      completedCount: 1,
      totalFocusedSeconds: 1_500,
    });
    expect(result.otherTasks.taskCount).toBe(0);
    expect(result.split.room).toEqual({
      sessionCount: 1,
      completedCount: 1,
      totalFocusedSeconds: 1_500,
    });
    expect(result.split.solo.sessionCount).toBe(4);
  });

  it('builds the hour heatmap in the user zone across a DST change', async () => {
    const user = await signUpTestUser(requireHarness());
    // New York, spring forward on 2025-03-09: 01:59 EST and 03:00 EDT, nothing at 02:xx.
    await seed(user, { startedAt: '2025-03-09T06:59:00Z' });
    await seed(user, { startedAt: '2025-03-09T07:00:00Z' });
    const result = await fetchInsights(user, '2025-03-09', '2025-03-09', 'America/New_York');
    expect(result.days[0]?.sessionCount).toBe(2);
    expect(
      result.heatmap.filter((c) => c.sessionCount > 0).map((c) => [c.weekday, c.hour]),
    ).toEqual([
      [6, 1],
      [6, 3],
    ]);
  });

  it('compares with the previous equal-length period', async () => {
    const user = await signUpTestUser(requireHarness());
    await seed(user, { startedAt: '2026-10-05T10:00:00Z' });
    await seed(user, { startedAt: '2026-10-06T10:00:00Z' });
    await seed(user, { startedAt: '2026-09-29T10:00:00Z' });
    const result = await fetchInsights(user, '2026-10-05', '2026-10-11', 'UTC');
    expect(result.comparison).toMatchObject({
      previousFrom: '2026-09-28',
      previousTo: '2026-10-04',
      previous: { completedCount: 1, totalFocusedSeconds: 1_500 },
      delta: { completedCount: 1, totalFocusedSeconds: 1_500, totalFocusedSecondsChange: 1 },
    });
  });
});

describe('streaks (A3), with an injected clock', () => {
  const insightsAt = async (user: TestUser, nowIso: string, tz: string, to: string) =>
    getFocusInsights({ db: requireHarness().db, now: () => Date.parse(nowIso) }, user.userId, {
      from: to,
      to,
      tz,
    });

  it('counts consecutive local days over all history, not only the range', async () => {
    const user = await signUpTestUser(requireHarness());
    for (const day of [
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
      '2026-09-20',
      '2026-09-21',
    ]) {
      await seed(user, { startedAt: `${day}T10:00:00Z` });
    }
    // An abandoned session does not make a streak day.
    await seed(user, { startedAt: '2026-09-22T10:00:00Z', status: 'abandoned' });
    const asOf = await insightsAt(user, '2026-09-22T12:00:00Z', 'UTC', '2026-09-22');
    expect(asOf.streak).toEqual({
      current: 2,
      longest: 4,
      today: '2026-09-22',
      todayCompleted: false,
    });
    const lapsed = await insightsAt(user, '2026-09-24T12:00:00Z', 'UTC', '2026-09-24');
    expect(lapsed.streak).toMatchObject({ current: 0, longest: 4 });
  });

  it('measures today and each session in the requested zone', async () => {
    const user = await signUpTestUser(requireHarness());
    // 23:30 local on 09-20 and 00:30 local on 09-21 in Los Angeles (PDT, -07:00) are two days.
    await seed(user, { startedAt: '2026-09-21T06:30:00Z' });
    await seed(user, { startedAt: '2026-09-21T07:30:00Z' });
    // "Now" is 2026-09-21T09:00Z: still 09-21 in Los Angeles (02:00), already 09-21 in UTC.
    const la = await insightsAt(user, '2026-09-21T09:00:00Z', 'America/Los_Angeles', '2026-09-21');
    expect(la.streak).toEqual({
      current: 2,
      longest: 2,
      today: '2026-09-21',
      todayCompleted: true,
    });
    // In UTC both sessions are on 09-21: one day.
    const utc = await insightsAt(user, '2026-09-21T09:00:00Z', 'UTC', '2026-09-21');
    expect(utc.streak).toMatchObject({ current: 1, longest: 1 });
  });

  it('keeps a streak across the DST change day', async () => {
    const user = await signUpTestUser(requireHarness());
    // New York: 03-08 22:00 EST, 03-09 (a 23-hour day) 12:00 EDT, 03-10 12:00 EDT.
    await seed(user, { startedAt: '2025-03-09T03:00:00Z' });
    await seed(user, { startedAt: '2025-03-09T16:00:00Z' });
    await seed(user, { startedAt: '2025-03-10T16:00:00Z' });
    const result = await insightsAt(user, '2025-03-10T20:00:00Z', 'America/New_York', '2025-03-10');
    expect(result.streak).toMatchObject({ current: 3, longest: 3, today: '2025-03-10' });
  });
});
