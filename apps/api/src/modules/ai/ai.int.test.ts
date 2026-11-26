import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  addCalendarDays,
  aiFirstStepInputSchema,
  aiJobResponseSchema,
  type AiJobView,
  aiWeeklyInputSchema,
  API_BASE_PATH,
  createCalendarDateFormatter,
  errorBodySchema,
  taskResponseSchema,
  weeklyReflectionResponseSchema,
} from '@focus-flow/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startTestHarness, stopTestHarness, type TestHarness } from '../../../test/harness.js';
import { signUpTestUser, type TestUser } from '../../../test/users.js';

// Wave 5 against the real API, worker and queue, with a fake AI service on a local port
// standing in for services/ai (AI1–AI6).

type Mode = 'ok' | 'declined' | 'down';
let mode: Mode = 'ok';
let delayMs = 0;
const received: { path: string; token: string | undefined; body: unknown }[] = [];

const readBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
};

const fakeAi: Server = createServer((req, res) => {
  void (async () => {
    const body = await readBody(req);
    const token = req.headers['x-internal-token'];
    received.push({
      path: req.url ?? '',
      token: typeof token === 'string' ? token : undefined,
      body,
    });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    res.setHeader('Content-Type', 'application/json');
    if (mode === 'down') {
      res.statusCode = 503;
      res.end(JSON.stringify({ code: 'unavailable', message: 'down' }));
      return;
    }
    if (mode === 'declined') {
      res.statusCode = 422;
      res.end(JSON.stringify({ code: 'declined', message: 'no' }));
      return;
    }
    const result =
      req.url === '/v1/first-step'
        ? {
            firstStep: 'Open the doc',
            steps: ['Open the doc', 'Write a line'],
            encouragement: 'Go.',
          }
        : { headline: 'A good week.', wins: ['You showed up.'], patterns: [], suggestion: 'More.' };
    res.end(JSON.stringify({ source: 'mock', result }));
  })();
});

let harness: TestHarness | undefined;
const requireHarness = (): TestHarness => {
  if (harness === undefined) {
    throw new Error('the API harness failed to start');
  }
  return harness;
};

type ApiResult = { status: number; body: unknown };

const call = async (user: TestUser, method: string, path: string, body?: unknown) => {
  const response = await fetch(`${requireHarness().baseUrl}${API_BASE_PATH}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${user.accessToken}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.length === 0 ? undefined : JSON.parse(text),
  };
};

const codeOf = (result: ApiResult) => [
  result.status,
  errorBodySchema.parse(result.body).error.code,
];

const createTask = async (user: TestUser, title: string) =>
  taskResponseSchema.parse((await call(user, 'POST', '/tasks', { title })).body).task;

/** Polls the job until the worker has finished it. */
const settled = async (user: TestUser, jobId: string, timeoutMs = 30_000): Promise<AiJobView> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { job } = aiJobResponseSchema.parse((await call(user, 'GET', `/ai/jobs/${jobId}`)).body);
    if (job.status === 'succeeded' || job.status === 'failed') {
      return job;
    }
    if (Date.now() > deadline) {
      throw new Error(`job ${jobId} still ${job.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
};

beforeAll(async () => {
  await new Promise<void>((resolve) => fakeAi.listen(0, '127.0.0.1', resolve));
  const { port } = fakeAi.address() as AddressInfo;
  harness = await startTestHarness({
    AI_SERVICE_URL: `http://127.0.0.1:${String(port)}`,
    AI_INTERNAL_TOKEN: 'int-test-internal-token',
  });
}, 180_000);

afterAll(async () => {
  if (harness !== undefined) {
    await stopTestHarness(harness);
  }
  await new Promise((resolve) => fakeAi.close(resolve));
}, 60_000);

beforeEach(() => {
  mode = 'ok';
  delayMs = 0;
  received.length = 0;
});

describe('help me start', () => {
  it('queues a job, sends the task context with the token, and stores the answer', async () => {
    const h = requireHarness();
    const ada = await signUpTestUser(h, 'ada-ai');
    const task = await createTask(ada, 'Write the report');
    await call(ada, 'POST', `/tasks/${task.id}/steps`, { title: 'Collect numbers' });

    delayMs = 400;
    const first = await call(ada, 'POST', '/ai/first-step', { taskId: task.id });
    expect(first.status).toBe(202);
    const { job } = aiJobResponseSchema.parse(first.body);
    expect(job).toMatchObject({ kind: 'first_step', status: 'queued', taskId: task.id });

    // AI3: asking again while it runs answers the same job.
    const again = await call(ada, 'POST', '/ai/first-step', { taskId: task.id });
    expect(again.status).toBe(200);
    expect(aiJobResponseSchema.parse(again.body).job.id).toBe(job.id);
    // …and a request about another task waits its turn.
    const other = await createTask(ada, 'Another one');
    expect(codeOf(await call(ada, 'POST', '/ai/first-step', { taskId: other.id }))).toEqual([
      409,
      'AI_JOB_BUSY',
    ]);

    const done = await settled(ada, job.id);
    expect(done).toMatchObject({
      status: 'succeeded',
      source: 'mock',
      failure: null,
      result: { firstStep: 'Open the doc' },
    });
    expect(received).toHaveLength(1);
    expect(received[0]?.path).toBe('/v1/first-step');
    expect(received[0]?.token).toBe('int-test-internal-token');
    const input = aiFirstStepInputSchema.parse(received[0]?.body);
    expect(input.task).toMatchObject({ title: 'Write the report', sessionsSpent: 0 });
    expect(input.task.steps).toEqual([{ title: 'Collect numbers', done: false }]);
  });

  it('is owner-scoped and needs an open task', async () => {
    const h = requireHarness();
    const ben = await signUpTestUser(h, 'ben-ai');
    const cleo = await signUpTestUser(h, 'cleo-ai');
    const task = await createTask(ben, 'Ben task');
    expect(codeOf(await call(cleo, 'POST', '/ai/first-step', { taskId: task.id }))).toEqual([
      404,
      'TASK_NOT_FOUND',
    ]);
    const { job } = aiJobResponseSchema.parse(
      (await call(ben, 'POST', '/ai/first-step', { taskId: task.id })).body,
    );
    expect(codeOf(await call(cleo, 'GET', `/ai/jobs/${job.id}`))).toEqual([
      404,
      'AI_JOB_NOT_FOUND',
    ]);
    await settled(ben, job.id);

    await call(ben, 'POST', `/tasks/${task.id}/complete`);
    expect(codeOf(await call(ben, 'POST', '/ai/first-step', { taskId: task.id }))).toEqual([
      409,
      'TASK_NOT_OPEN',
    ]);
    expect(
      codeOf(await call(ben, 'POST', '/ai/first-step', { taskId: task.id, extra: true })),
    ).toEqual([400, 'VALIDATION_FAILED']);
  });

  it('records a decline at once, and gives up on an unreachable service after the retries', async () => {
    const h = requireHarness();
    const dan = await signUpTestUser(h, 'dan-ai');
    const task = await createTask(dan, 'Hard thing');

    mode = 'declined';
    const declined = aiJobResponseSchema.parse(
      (await call(dan, 'POST', '/ai/first-step', { taskId: task.id })).body,
    ).job;
    expect(await settled(dan, declined.id)).toMatchObject({
      status: 'failed',
      failure: 'declined',
      result: null,
    });
    expect(received).toHaveLength(1);

    received.length = 0;
    mode = 'down';
    const down = aiJobResponseSchema.parse(
      (await call(dan, 'POST', '/ai/first-step', { taskId: task.id })).body,
    ).job;
    expect(await settled(dan, down.id, 45_000)).toMatchObject({
      status: 'failed',
      failure: 'unavailable',
    });
    expect(received).toHaveLength(3);
  }, 60_000);
});

describe('weekly reflection', () => {
  it('reflects on this week, keeps it for the week, and refuses a week not yet begun', async () => {
    const h = requireHarness();
    const eve = await signUpTestUser(h, 'eve-ai');
    const today = createCalendarDateFormatter('UTC')(Date.now());
    const weekday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
    const week = addCalendarDays(today, -weekday);

    expect(
      codeOf(
        await call(eve, 'POST', '/ai/weekly-reflection', {
          week: addCalendarDays(week, 7),
          tz: 'UTC',
        }),
      ),
    ).toEqual([400, 'VALIDATION_FAILED']);
    expect(
      weeklyReflectionResponseSchema.parse(
        (await call(eve, 'GET', `/ai/weekly-reflection?week=${week}`)).body,
      ).job,
    ).toBeNull();

    const created = await call(eve, 'POST', '/ai/weekly-reflection', { week, tz: 'UTC' });
    expect(created.status).toBe(202);
    const { job } = aiJobResponseSchema.parse(created.body);
    const done = await settled(eve, job.id);
    expect(done).toMatchObject({ status: 'succeeded', kind: 'weekly_reflection', weekStart: week });

    const input = aiWeeklyInputSchema.parse(received[0]?.body);
    expect(input.weekStart).toBe(week);
    expect(input.days.map((day) => day.date)[0]).toBe(week);
    expect(input.totals.focusedSeconds).toBe(0);

    const stored = weeklyReflectionResponseSchema.parse(
      (await call(eve, 'GET', `/ai/weekly-reflection?week=${week}`)).body,
    ).job;
    expect(stored?.id).toBe(job.id);
    expect(stored?.result).toMatchObject({ headline: 'A good week.' });
  });
});
