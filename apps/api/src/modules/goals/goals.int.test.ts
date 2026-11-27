import {
  API_BASE_PATH,
  errorBodySchema,
  goalListResponseSchema,
  goalPath,
  goalPaths,
  goalResponseSchema,
  TASK_STEPS_MAX,
  taskListResponseSchema,
  taskPath,
  taskPaths,
  taskResponseSchema,
  taskStepListResponseSchema,
  taskStepPath,
  taskStepResponseSchema,
} from '@focus-flow/contracts';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestHarness, stopTestHarness, type TestHarness } from '../../../test/harness.js';
import { signUpTestUser, type TestUser } from '../../../test/users.js';
import { focusSessions, taskSteps } from '../../db/schema.js';

// Goals (GL1–GL4), steps (SP1–SP3) and estimates (ES1–ES2) against the real API.

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

const codeOf = (result: ApiResult) => [
  result.status,
  errorBodySchema.parse(result.body).error.code,
];

const newGoal = async (
  user: TestUser,
  body: Record<string, unknown> = { title: 'Ship the beta' },
) => goalResponseSchema.parse((await call(user, 'POST', goalPaths.collection, body)).body).goal;

const newTask = async (user: TestUser, body: Record<string, unknown>) =>
  taskResponseSchema.parse((await call(user, 'POST', taskPaths.collection, body)).body).task;

const listGoals = async (user: TestUser, query = '') =>
  goalListResponseSchema.parse((await call(user, 'GET', `${goalPaths.collection}${query}`)).body)
    .goals;

beforeAll(async () => {
  harness = await startTestHarness();
}, 180_000);

afterAll(async () => {
  if (harness !== undefined) {
    await stopTestHarness(harness);
  }
}, 60_000);

describe('goals', () => {
  it('creates a goal and lists active ones first, then completed, archived only on request', async () => {
    const user = await signUpTestUser(requireHarness(), 'goal-setter');
    const created = await call(user, 'POST', goalPaths.collection, {
      title: '  Learn Spanish  ',
      why: '  For the trip  ',
      targetDate: '2027-03-01',
      color: 'sky',
    });
    expect(created.status).toBe(201);
    const spanish = goalResponseSchema.parse(created.body).goal;
    expect(spanish).toMatchObject({
      title: 'Learn Spanish',
      why: 'For the trip',
      targetDate: '2027-03-01',
      color: 'sky',
      status: 'active',
      endedAt: null,
      progress: { openTasks: 0, completedTasks: 0, focusedSeconds: 0 },
    });
    const beta = await newGoal(user);
    const old = await newGoal(user, { title: 'Old idea' });

    await call(user, 'PATCH', goalPath(spanish.id), { status: 'completed' });
    await call(user, 'PATCH', goalPath(old.id), { status: 'archived' });

    expect((await listGoals(user)).map((goal) => [goal.title, goal.status])).toEqual([
      ['Ship the beta', 'active'],
      ['Learn Spanish', 'completed'],
    ]);
    expect((await listGoals(user, '?archived=true')).map((goal) => goal.title)).toContain(
      'Old idea',
    );

    // Back to active, and fields cleared with null.
    const reopened = goalResponseSchema.parse(
      (await call(user, 'PATCH', goalPath(spanish.id), { status: 'active', why: null })).body,
    ).goal;
    expect(reopened).toMatchObject({ status: 'active', why: null, endedAt: null });
    expect(beta.color).toBe('leaf');
  });

  it('validates input and keeps goals per user', async () => {
    const h = requireHarness();
    const user = await signUpTestUser(h, 'validator');
    const other = await signUpTestUser(h, 'stranger');
    for (const body of [
      {},
      { title: '   ' },
      { title: 'x'.repeat(81) },
      { title: 'Ok', color: 'neon' },
      { title: 'Ok', userId: user.userId },
    ]) {
      const result = await call(user, 'POST', goalPaths.collection, body);
      expect(codeOf(result)).toEqual([400, 'VALIDATION_FAILED']);
    }
    const goal = await newGoal(user);
    expect(codeOf(await call(other, 'PATCH', goalPath(goal.id), { title: 'Mine' }))).toEqual([
      404,
      'GOAL_NOT_FOUND',
    ]);
    expect(codeOf(await call(user, 'PATCH', goalPath(uuidv7()), { title: 'x' }))).toEqual([
      404,
      'GOAL_NOT_FOUND',
    ]);
    expect(await listGoals(other)).toEqual([]);
  });

  it('takes tasks while active, filters them and counts their progress and focus', async () => {
    const h = requireHarness();
    const user = await signUpTestUser(h, 'achiever');
    const other = await signUpTestUser(h, 'outsider');
    const goal = await newGoal(user);
    const write = await newTask(user, { title: 'Write the post', goalId: goal.id });
    await newTask(user, { title: 'Unrelated' });
    const moved = await newTask(user, { title: 'Record the demo' });
    await call(user, 'PATCH', taskPath(taskPaths.item, moved.id), { goalId: goal.id });
    await call(user, 'POST', taskPath(taskPaths.complete, moved.id));
    const started = new Date('2026-11-20T08:00:00Z');
    await h.db.insert(focusSessions).values({
      id: uuidv7(),
      userId: user.userId,
      taskId: write.id,
      status: 'completed',
      plannedSeconds: 1_500,
      focusedSeconds: 1_500,
      startedAt: started,
      endedAt: new Date(started.getTime() + 1_500_000),
    });

    const [listed] = await listGoals(user);
    expect(listed?.progress).toEqual({ openTasks: 1, completedTasks: 1, focusedSeconds: 1_500 });
    const page = taskListResponseSchema.parse(
      (await call(user, 'GET', `${taskPaths.collection}?goalId=${goal.id}`)).body,
    );
    expect(page.tasks.map((task) => task.title)).toEqual(['Write the post']);

    // Another user's goal, or a finished one, takes no tasks.
    expect(
      codeOf(await call(other, 'POST', taskPaths.collection, { title: 'x', goalId: goal.id })),
    ).toEqual([404, 'GOAL_NOT_FOUND']);
    await call(user, 'PATCH', goalPath(goal.id), { status: 'completed' });
    expect(
      codeOf(await call(user, 'POST', taskPaths.collection, { title: 'y', goalId: goal.id })),
    ).toEqual([409, 'GOAL_NOT_ACTIVE']);
    // Detaching works whatever the goal's state.
    const detached = taskResponseSchema.parse(
      (await call(user, 'PATCH', taskPath(taskPaths.item, write.id), { goalId: null })).body,
    ).task;
    expect(detached.goalId).toBeNull();
  });
});

describe('estimates and sessions spent (ES1, ES2)', () => {
  it('stores an estimate and counts completed and real stopped sessions only', async () => {
    const h = requireHarness();
    const user = await signUpTestUser(h, 'estimator');
    const task = await newTask(user, { title: 'Refactor', estimatedSessions: 3 });
    expect(task).toMatchObject({ estimatedSessions: 3, sessionsSpent: 0 });
    const at = (hour: number) => new Date(`2026-11-20T${String(hour).padStart(2, '0')}:00:00Z`);
    for (const [hour, status, focused] of [
      [8, 'completed', 1_500],
      [9, 'abandoned', 900],
      [10, 'abandoned', 120],
    ] as const) {
      await h.db.insert(focusSessions).values({
        id: uuidv7(),
        userId: user.userId,
        taskId: task.id,
        status,
        abandonReason: status === 'abandoned' ? 'stopped' : null,
        plannedSeconds: 1_500,
        focusedSeconds: focused,
        startedAt: at(hour),
        endedAt: new Date(at(hour).getTime() + focused * 1_000),
      });
    }
    const read = taskResponseSchema.parse(
      (await call(user, 'GET', taskPath(taskPaths.item, task.id))).body,
    ).task;
    expect(read).toMatchObject({ estimatedSessions: 3, sessionsSpent: 2 });

    const cleared = taskResponseSchema.parse(
      (await call(user, 'PATCH', taskPath(taskPaths.item, task.id), { estimatedSessions: null }))
        .body,
    ).task;
    expect(cleared.estimatedSessions).toBeNull();
    const refused = await call(user, 'PATCH', taskPath(taskPaths.item, task.id), {
      estimatedSessions: 21,
    });
    expect(codeOf(refused)).toEqual([400, 'VALIDATION_FAILED']);
  });
});

describe('steps (SP1–SP3)', () => {
  it('adds, ticks, renames and removes steps, and counts them on the task', async () => {
    const h = requireHarness();
    const user = await signUpTestUser(h, 'stepper');
    const other = await signUpTestUser(h, 'peeker');
    const task = await newTask(user, { title: 'Launch' });
    const add = (title: string) => call(user, 'POST', taskStepPath(task.id), { title });

    const first = taskStepResponseSchema.parse((await add('  Draft the email  ')).body).step;
    expect(first).toMatchObject({ title: 'Draft the email', done: false });
    const second = taskStepResponseSchema.parse((await add('Pick a date')).body).step;

    const ticked = await call(user, 'PATCH', taskStepPath(task.id, first.id), { done: true });
    expect(taskStepResponseSchema.parse(ticked.body).step.done).toBe(true);
    await call(user, 'PATCH', taskStepPath(task.id, second.id), { title: 'Pick a Tuesday' });

    const listed = taskStepListResponseSchema.parse(
      (await call(user, 'GET', taskStepPath(task.id))).body,
    );
    expect(listed.steps.map((step) => [step.title, step.done])).toEqual([
      ['Draft the email', true],
      ['Pick a Tuesday', false],
    ]);
    const counted = taskResponseSchema.parse(
      (await call(user, 'GET', taskPath(taskPaths.item, task.id))).body,
    ).task;
    expect(counted.steps).toEqual({ total: 2, done: 1 });

    expect((await call(user, 'DELETE', taskStepPath(task.id, second.id))).status).toBe(204);
    expect(codeOf(await call(user, 'DELETE', taskStepPath(task.id, second.id)))).toEqual([
      404,
      'NOT_FOUND',
    ]);
    expect(codeOf(await call(other, 'GET', taskStepPath(task.id)))).toEqual([
      404,
      'TASK_NOT_FOUND',
    ]);
    expect(codeOf(await call(other, 'POST', taskStepPath(task.id), { title: 'x' }))).toEqual([
      404,
      'TASK_NOT_FOUND',
    ]);
  });

  it('refuses one more than TASK_STEPS_MAX with 409 STEPS_FULL', async () => {
    const h = requireHarness();
    const user = await signUpTestUser(h, 'listmaker');
    const task = await newTask(user, { title: 'Big one' });
    await h.db.insert(taskSteps).values(
      Array.from({ length: TASK_STEPS_MAX }, (_, index) => ({
        id: uuidv7(),
        taskId: task.id,
        userId: user.userId,
        title: `Step ${String(index)}`,
      })),
    );
    expect(codeOf(await call(user, 'POST', taskStepPath(task.id), { title: 'More' }))).toEqual([
      409,
      'STEPS_FULL',
    ]);
  });
});
