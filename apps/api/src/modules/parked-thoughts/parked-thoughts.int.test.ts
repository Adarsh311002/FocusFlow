import {
  API_BASE_PATH,
  errorBodySchema,
  focusSessionPaths,
  focusSessionResponseSchema,
  listParkedThoughtsResponseSchema,
  PARKED_THOUGHTS_MAX,
  parkedThoughtPath,
  parkedThoughtPaths,
  parkedThoughtResponseSchema,
  parkedThoughtToTaskResponseSchema,
  taskPaths,
} from '@focus-flow/contracts';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { startTestHarness, stopTestHarness, type TestHarness } from '../../../test/harness.js';
import { closeAllSockets, connectSocket } from '../../../test/sockets.js';
import { signUpTestUser, type TestUser } from '../../../test/users.js';
import { parkedThoughts } from '../../db/schema.js';

// Parked thoughts (PT1–PT4) against the real API and PostgreSQL.

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

const park = (user: TestUser, body: unknown) =>
  call(user, 'POST', parkedThoughtPaths.collection, body);

const list = async (user: TestUser) =>
  listParkedThoughtsResponseSchema.parse(
    (await call(user, 'GET', parkedThoughtPaths.collection)).body,
  ).thoughts;

beforeAll(async () => {
  harness = await startTestHarness(
    { INSTANCE_HEARTBEAT_MS: '200', INSTANCE_TTL_MS: '2000' },
    { epochAgeMs: 7 * 86_400_000 },
  );
}, 180_000);

afterEach(() => {
  closeAllSockets();
});

afterAll(async () => {
  closeAllSockets();
  if (harness !== undefined) {
    await stopTestHarness(harness);
  }
}, 60_000);

describe('parked thoughts', () => {
  it('parks a trimmed thought, lists it newest first and keeps users apart', async () => {
    const h = requireHarness();
    const user = await signUpTestUser(h, 'parker');
    const other = await signUpTestUser(h, 'other');

    const first = await park(user, { body: '  Email Ravi  ' });
    expect(first.status).toBe(201);
    expect(parkedThoughtResponseSchema.parse(first.body).thought).toMatchObject({
      body: 'Email Ravi',
      sessionId: null,
    });
    await park(user, { body: 'Buy coffee' });

    expect((await list(user)).map((thought) => thought.body)).toEqual(['Buy coffee', 'Email Ravi']);
    expect(await list(other)).toEqual([]);
  });

  it('validates the body and refuses unknown keys', async () => {
    const user = await signUpTestUser(requireHarness(), 'invalid');
    for (const body of [
      {},
      { body: '   ' },
      { body: 'x'.repeat(201) },
      { body: 'a', userId: 'x' },
    ]) {
      const result = await park(user, body);
      expect([result.status, errorCode(result)]).toEqual([400, 'VALIDATION_FAILED']);
    }
    expect((await call(null, 'GET', parkedThoughtPaths.collection)).status).toBe(401);
  });

  it('links a thought to the user’s own session only', async () => {
    const h = requireHarness();
    const user = await signUpTestUser(h, 'focused');
    const other = await signUpTestUser(h, 'stranger');
    await connectSocket(h.baseUrl, user.accessToken);
    for (let tries = 0; !(await h.runtime.presence.isUserOnline(user.userId)); tries += 1) {
      if (tries > 100) {
        throw new Error('the user never came online');
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const session = focusSessionResponseSchema.parse(
      (await call(user, 'POST', focusSessionPaths.collection, { plannedSeconds: 1_500 })).body,
    ).session;

    const linked = await park(user, { body: 'Mid-session idea', sessionId: session.id });
    expect(parkedThoughtResponseSchema.parse(linked.body).thought.sessionId).toBe(session.id);

    const foreign = await park(other, { body: 'Not mine', sessionId: session.id });
    expect([foreign.status, errorCode(foreign)]).toEqual([404, 'NOT_FOUND']);
  });

  it('turns a thought into an open task and removes it; a retry is 404', async () => {
    const user = await signUpTestUser(requireHarness(), 'converter');
    const thought = parkedThoughtResponseSchema.parse(
      (await park(user, { body: 'Draft the FAQ' })).body,
    ).thought;

    const converted = await call(
      user,
      'POST',
      parkedThoughtPath(parkedThoughtPaths.toTask, thought.id),
    );
    expect(converted.status).toBe(201);
    expect(parkedThoughtToTaskResponseSchema.parse(converted.body).task).toMatchObject({
      title: 'Draft the FAQ',
      status: 'open',
    });
    expect(await list(user)).toEqual([]);
    const tasks = (await call(user, 'GET', taskPaths.collection)).body as {
      tasks: { title: string }[];
    };
    expect(tasks.tasks.map((task) => task.title)).toEqual(['Draft the FAQ']);

    const retry = await call(
      user,
      'POST',
      parkedThoughtPath(parkedThoughtPaths.toTask, thought.id),
    );
    expect([retry.status, errorCode(retry)]).toEqual([404, 'NOT_FOUND']);
  });

  it('lets a thought go; another user’s or an unknown one is 404', async () => {
    const h = requireHarness();
    const user = await signUpTestUser(h, 'letter-go');
    const other = await signUpTestUser(h, 'snoop');
    const thought = parkedThoughtResponseSchema.parse(
      (await park(user, { body: 'Check the oven' })).body,
    ).thought;

    for (const [who, id] of [
      [other, thought.id],
      [user, uuidv7()],
    ] as const) {
      const result = await call(who, 'DELETE', parkedThoughtPath(parkedThoughtPaths.item, id));
      expect([result.status, errorCode(result)]).toEqual([404, 'NOT_FOUND']);
    }
    expect(
      (await call(user, 'DELETE', parkedThoughtPath(parkedThoughtPaths.item, thought.id))).status,
    ).toBe(204);
    expect(await list(user)).toEqual([]);
  });

  it('refuses one more than PARKED_THOUGHTS_MAX with 409 THOUGHTS_FULL', async () => {
    const h = requireHarness();
    const user = await signUpTestUser(h, 'hoarder');
    await h.db.insert(parkedThoughts).values(
      Array.from({ length: PARKED_THOUGHTS_MAX }, (_, index) => ({
        id: uuidv7(),
        userId: user.userId,
        body: `Thought ${String(index)}`,
      })),
    );
    const result = await park(user, { body: 'One too many' });
    expect([result.status, errorCode(result)]).toEqual([409, 'THOUGHTS_FULL']);
  });
});
