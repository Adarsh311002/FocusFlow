import {
  API_BASE_PATH,
  errorBodySchema,
  taskPath,
  taskPaths,
  taskResponseSchema,
  weeklyPrioritiesResponseSchema,
  weeklyPriorityPaths,
} from '@focus-flow/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestHarness, stopTestHarness, type TestHarness } from '../../../test/harness.js';
import { signUpTestUser, type TestUser } from '../../../test/users.js';

// Weekly priorities (WR1–WR3) against the real API and PostgreSQL.

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
  const headers: Record<string, string> = {};
  if (user !== null) {
    headers.Authorization = `Bearer ${user.accessToken}`;
  }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(`${requireHarness().baseUrl}${API_BASE_PATH}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text.length === 0 ? undefined : JSON.parse(text) };
};

const errorCode = (result: ApiResult): string => errorBodySchema.parse(result.body).error.code;

const MONDAY = '2026-11-23';

const createTask = async (user: TestUser, title: string) =>
  taskResponseSchema.parse((await call(user, 'POST', taskPaths.collection, { title })).body).task;

const setWeek = (user: TestUser, taskIds: string[], week = MONDAY) =>
  call(user, 'PUT', weeklyPriorityPaths.collection, { week, taskIds });

const getWeek = async (user: TestUser, week = MONDAY) =>
  weeklyPrioritiesResponseSchema.parse(
    (await call(user, 'GET', `${weeklyPriorityPaths.collection}?week=${week}`)).body,
  );

beforeAll(async () => {
  harness = await startTestHarness();
}, 180_000);

afterAll(async () => {
  if (harness !== undefined) {
    await stopTestHarness(harness);
  }
}, 60_000);

describe('weekly priorities', () => {
  it('sets and replaces the week’s top three, in order', async () => {
    const user = await signUpTestUser(requireHarness(), 'planner');
    const [a, b, c] = await Promise.all(['Ship', 'Write', 'Rest'].map((t) => createTask(user, t)));
    if (a === undefined || b === undefined || c === undefined) {
      throw new Error('tasks missing');
    }
    expect((await getWeek(user)).priorities).toEqual([]);

    const saved = await setWeek(user, [b.id, a.id, c.id]);
    expect(saved.status).toBe(200);
    expect(
      weeklyPrioritiesResponseSchema
        .parse(saved.body)
        .priorities.map((p) => [p.position, p.task.title]),
    ).toEqual([
      [1, 'Write'],
      [2, 'Ship'],
      [3, 'Rest'],
    ]);

    await setWeek(user, [c.id]);
    expect((await getWeek(user)).priorities.map((p) => p.task.title)).toEqual(['Rest']);
    // Another week is separate.
    expect((await getWeek(user, '2026-11-30')).priorities).toEqual([]);
  });

  it('validates the week and the list', async () => {
    const user = await signUpTestUser(requireHarness(), 'strict');
    const task = await createTask(user, 'Once');
    for (const body of [
      { week: '2026-11-24', taskIds: [] },
      { week: MONDAY, taskIds: [task.id, task.id] },
      { week: MONDAY, taskIds: [task.id, task.id, task.id, task.id] },
      { week: MONDAY, taskIds: [], userId: user.userId },
    ]) {
      const result = await call(user, 'PUT', weeklyPriorityPaths.collection, body);
      expect([result.status, errorCode(result)]).toEqual([400, 'VALIDATION_FAILED']);
    }
    const tuesday = await call(user, 'GET', `${weeklyPriorityPaths.collection}?week=2026-11-24`);
    expect(tuesday.status).toBe(400);
  });

  it('accepts only the caller’s own, live, open tasks; keeps a listed task once completed', async () => {
    const h = requireHarness();
    const user = await signUpTestUser(h, 'owner');
    const other = await signUpTestUser(h, 'other');
    const mine = await createTask(user, 'Mine');
    const theirs = await createTask(other, 'Theirs');

    const foreign = await setWeek(user, [theirs.id]);
    expect([foreign.status, errorCode(foreign)]).toEqual([404, 'TASK_NOT_FOUND']);

    const done = await createTask(user, 'Already done');
    await call(user, 'POST', taskPath(taskPaths.complete, done.id));
    const closed = await setWeek(user, [done.id]);
    expect([closed.status, errorCode(closed)]).toEqual([409, 'TASK_NOT_OPEN']);

    await setWeek(user, [mine.id]);
    await call(user, 'POST', taskPath(taskPaths.complete, mine.id));
    expect((await getWeek(user)).priorities.map((p) => p.task.status)).toEqual(['completed']);
    // Re-saving a list that still holds the now-completed task is fine.
    expect((await setWeek(user, [mine.id])).status).toBe(200);

    // A deleted task drops out of the list.
    await call(user, 'DELETE', taskPath(taskPaths.item, mine.id));
    expect((await getWeek(user)).priorities).toEqual([]);
    expect(await getWeek(other)).toMatchObject({ priorities: [] });
  });
});
