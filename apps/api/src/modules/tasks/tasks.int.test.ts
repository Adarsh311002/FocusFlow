import {
  API_BASE_PATH,
  errorBodySchema,
  type TaskId,
  taskIdSchema,
  taskListResponseSchema,
  taskPath,
  taskPaths,
  taskResponseSchema,
  type TaskView,
} from '@focus-flow/contracts';
import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startTestHarness, stopTestHarness, type TestHarness } from '../../../test/harness.js';
import { signUpTestUser, type TestUser } from '../../../test/users.js';
import { authIdentities, authSessions, tasks, users } from '../../db/schema.js';
import { revokeAuthSession } from '../auth/queries.js';
import { markSessionRevoked } from '../auth/revocation.js';

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

const taskOf = (result: ApiResult): TaskView => taskResponseSchema.parse(result.body).task;

const createTask = async (user: TestUser, title: string): Promise<TaskView> => {
  const result = await call(user, 'POST', taskPaths.collection, { title });
  expect(result.status).toBe(201);
  return taskOf(result);
};

const list = async (user: TestUser, query = '') => {
  const result = await call(user, 'GET', `${taskPaths.collection}${query}`);
  expect(result.status).toBe(200);
  return taskListResponseSchema.parse(result.body);
};

const itemPath = (id: TaskId) => taskPath(taskPaths.item, id);
const completePath = (id: TaskId) => taskPath(taskPaths.complete, id);
const reopenPath = (id: TaskId) => taskPath(taskPaths.reopen, id);

const currentTaskIdOf = async (user: TestUser): Promise<string | null | undefined> => {
  const [row] = await requireHarness()
    .db.select({ currentTaskId: users.currentTaskId })
    .from(users)
    .where(eq(users.id, user.userId));
  return row?.currentTaskId;
};

/** Phase 2's PUT /me/current-task arrives in the next commit; until then set it directly. */
const setCurrentTaskInDb = async (user: TestUser, taskId: string | null): Promise<void> => {
  await requireHarness()
    .db.update(users)
    .set({ currentTaskId: taskId })
    .where(eq(users.id, user.userId));
};

beforeAll(async () => {
  harness = await startTestHarness();
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

describe('task lifecycle', () => {
  it('creates a task with a trimmed title and returns it as open', async () => {
    const user = await signUpTestUser(requireHarness());

    const task = await createTask(user, '  Write the report  ');

    expect(task).toMatchObject({ title: 'Write the report', status: 'open' });
    expect(task).not.toHaveProperty('completedAt');
    expect(task).not.toHaveProperty('userId');
    expect(task).not.toHaveProperty('deletedAt');
  });

  it('gets a task by id', async () => {
    const user = await signUpTestUser(requireHarness());
    const task = await createTask(user, 'Read chapter 3');

    const result = await call(user, 'GET', itemPath(task.id));

    expect(result.status).toBe(200);
    expect(taskOf(result)).toEqual(task);
  });

  it('renames an open task and a completed task', async () => {
    const user = await signUpTestUser(requireHarness());
    const open = await createTask(user, 'Old name');
    const done = await createTask(user, 'Done task');
    await call(user, 'POST', completePath(done.id));

    const renamedOpen = await call(user, 'PATCH', itemPath(open.id), { title: ' New name ' });
    const renamedDone = await call(user, 'PATCH', itemPath(done.id), { title: 'Still done' });

    expect(renamedOpen.status).toBe(200);
    expect(taskOf(renamedOpen)).toMatchObject({ title: 'New name', status: 'open' });
    expect(renamedDone.status).toBe(200);
    expect(taskOf(renamedDone)).toMatchObject({ title: 'Still done', status: 'completed' });
  });

  it('completes a task, and completing it again keeps the original completion time', async () => {
    const user = await signUpTestUser(requireHarness());
    const task = await createTask(user, 'Finish me');

    const first = taskOf(await call(user, 'POST', completePath(task.id)));
    const second = await call(user, 'POST', completePath(task.id));

    expect(first.status).toBe('completed');
    expect(second.status).toBe(200);
    expect(taskOf(second)).toEqual(first);
  });

  it('reopens a completed task, and reopening an open task is a no-op', async () => {
    const user = await signUpTestUser(requireHarness());
    const task = await createTask(user, 'Back to it');
    await call(user, 'POST', completePath(task.id));

    const reopened = await call(user, 'POST', reopenPath(task.id));
    const again = await call(user, 'POST', reopenPath(task.id));

    expect(reopened.status).toBe(200);
    expect(taskOf(reopened).status).toBe('open');
    expect(taskOf(reopened)).not.toHaveProperty('completedAt');
    expect(again.status).toBe(200);
    expect(taskOf(again)).toEqual(taskOf(reopened));
  });
});

describe('soft delete (D38)', () => {
  it('returns 204, keeps the row, and repeating the delete is 204 again', async () => {
    const user = await signUpTestUser(requireHarness());
    const task = await createTask(user, 'Delete me');

    const first = await call(user, 'DELETE', itemPath(task.id));
    const second = await call(user, 'DELETE', itemPath(task.id));

    expect(first.status).toBe(204);
    expect(first.body).toBeUndefined();
    expect(second.status).toBe(204);
    const [row] = await requireHarness().db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row?.deletedAt).toBeInstanceOf(Date);
  });

  it('hides a deleted task from every normal read and write', async () => {
    const user = await signUpTestUser(requireHarness());
    const task = await createTask(user, 'Gone');
    await call(user, 'POST', completePath(task.id));
    const openSibling = await createTask(user, 'Still here');
    await call(user, 'DELETE', itemPath(task.id));

    for (const result of [
      await call(user, 'GET', itemPath(task.id)),
      await call(user, 'PATCH', itemPath(task.id), { title: 'Renamed' }),
      await call(user, 'POST', completePath(task.id)),
      await call(user, 'POST', reopenPath(task.id)),
    ]) {
      expect(result.status).toBe(404);
      expect(errorCode(result)).toBe('TASK_NOT_FOUND');
    }
    expect((await list(user, '?status=open')).tasks.map((t) => t.id)).toEqual([openSibling.id]);
    expect((await list(user, '?status=completed')).tasks).toEqual([]);
  });
});

describe('current task clearing (D38, D43)', () => {
  it('completing the current task clears it; reopening does not restore it', async () => {
    const user = await signUpTestUser(requireHarness());
    const task = await createTask(user, 'Current');
    await setCurrentTaskInDb(user, task.id);

    await call(user, 'POST', completePath(task.id));
    expect(await currentTaskIdOf(user)).toBeNull();

    await call(user, 'POST', reopenPath(task.id));
    expect(await currentTaskIdOf(user)).toBeNull();
  });

  it('deleting the current task clears it', async () => {
    const user = await signUpTestUser(requireHarness());
    const task = await createTask(user, 'Current');
    await setCurrentTaskInDb(user, task.id);

    await call(user, 'DELETE', itemPath(task.id));

    expect(await currentTaskIdOf(user)).toBeNull();
  });

  it('completing or deleting a different task leaves the current task alone', async () => {
    const user = await signUpTestUser(requireHarness());
    const current = await createTask(user, 'Current');
    const other = await createTask(user, 'Other');
    const third = await createTask(user, 'Third');
    await setCurrentTaskInDb(user, current.id);

    await call(user, 'POST', completePath(other.id));
    await call(user, 'DELETE', itemPath(third.id));

    expect(await currentTaskIdOf(user)).toBe(current.id);
  });
});

describe('listing and pagination', () => {
  it('lists open tasks newest first by default, and completed tasks separately', async () => {
    const user = await signUpTestUser(requireHarness());
    const first = await createTask(user, 'first');
    const second = await createTask(user, 'second');
    const third = await createTask(user, 'third');
    await call(user, 'POST', completePath(second.id));

    const open = await list(user);
    const completed = await list(user, '?status=completed');

    expect(open.tasks.map((t) => t.id)).toEqual([third.id, first.id]);
    expect(open.nextCursor).toBeNull();
    expect(completed.tasks.map((t) => t.id)).toEqual([second.id]);
  });

  it('pages through tasks with limit and nextCursor without gaps or repeats', async () => {
    const user = await signUpTestUser(requireHarness());
    const created: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      created.push((await createTask(user, `task ${String(i)}`)).id);
    }

    const page1 = await list(user, '?limit=2');
    const page2 = await list(user, `?limit=2&cursor=${String(page1.nextCursor)}`);
    const page3 = await list(user, `?limit=2&cursor=${String(page2.nextCursor)}`);

    expect(page1.tasks.map((t) => t.id)).toEqual([created[4], created[3]]);
    expect(page2.tasks.map((t) => t.id)).toEqual([created[2], created[1]]);
    expect(page3.tasks.map((t) => t.id)).toEqual([created[0]]);
    expect(page1.nextCursor).not.toBeNull();
    expect(page3.nextCursor).toBeNull();
  });

  it('returns a null cursor when the last page is exactly full', async () => {
    const user = await signUpTestUser(requireHarness());
    await createTask(user, 'a');
    await createTask(user, 'b');

    expect((await list(user, '?limit=2')).nextCursor).toBeNull();
  });

  it('returns an empty list for a user without tasks', async () => {
    const user = await signUpTestUser(requireHarness());

    expect(await list(user)).toEqual({ tasks: [], nextCursor: null });
  });
});

describe('validation', () => {
  it.each([
    ['an empty title', { title: '' }],
    ['a whitespace-only title', { title: '   ' }],
    ['a 201-character title', { title: 'a'.repeat(201) }],
    ['a client-supplied userId', { title: 'x', userId: uuidv7() }],
    ['a missing title', {}],
  ])('rejects creating a task with %s', async (_label, body) => {
    const user = await signUpTestUser(requireHarness());

    const result = await call(user, 'POST', taskPaths.collection, body);

    expect(result.status).toBe(400);
    expect(errorCode(result)).toBe('VALIDATION_FAILED');
  });

  it('rejects renaming with an invalid title or unknown keys', async () => {
    const user = await signUpTestUser(requireHarness());
    const task = await createTask(user, 'Task');

    const empty = await call(user, 'PATCH', itemPath(task.id), { title: ' ' });
    const extra = await call(user, 'PATCH', itemPath(task.id), { title: 'x', status: 'completed' });

    expect(empty.status).toBe(400);
    expect(extra.status).toBe(400);
  });

  it('rejects a malformed task id with 400', async () => {
    const user = await signUpTestUser(requireHarness());

    const result = await call(user, 'GET', `${taskPaths.collection}/not-a-uuid`);

    expect(result.status).toBe(400);
    expect(errorCode(result)).toBe('VALIDATION_FAILED');
  });

  it.each([
    ['limit=0'],
    ['limit=101'],
    ['limit=abc'],
    ['status=deleted'],
    ['cursor=not-a-cursor'],
    ['userId=someone'],
  ])('rejects the list query %s with 400', async (query) => {
    const user = await signUpTestUser(requireHarness());

    const result = await call(user, 'GET', `${taskPaths.collection}?${query}`);

    expect(result.status).toBe(400);
    expect(errorCode(result)).toBe('VALIDATION_FAILED');
  });

  it('returns TASK_NOT_FOUND for a well-formed id that does not exist', async () => {
    const user = await signUpTestUser(requireHarness());

    const result = await call(user, 'GET', itemPath(taskIdSchema.parse(uuidv7())));

    expect(result.status).toBe(404);
    expect(errorCode(result)).toBe('TASK_NOT_FOUND');
  });
});

describe('authentication', () => {
  it('requires an access token on every task route', async () => {
    const id = taskIdSchema.parse(uuidv7());
    for (const [method, path] of [
      ['GET', taskPaths.collection],
      ['POST', taskPaths.collection],
      ['GET', itemPath(id)],
      ['PATCH', itemPath(id)],
      ['DELETE', itemPath(id)],
      ['POST', completePath(id)],
      ['POST', reopenPath(id)],
    ] as const) {
      const result = await call(null, method, path, method === 'GET' ? undefined : { title: 'x' });
      expect(result.status, `${method} ${path}`).toBe(401);
      expect(errorCode(result)).toBe('UNAUTHENTICATED');
    }
  });

  it('rejects the access token of a revoked session', async () => {
    const h = requireHarness();
    const user = await signUpTestUser(h);
    const [session] = await h.db
      .select({ id: authSessions.id })
      .from(authSessions)
      .where(eq(authSessions.userId, user.userId));
    if (session === undefined) {
      throw new Error('signup created no auth session');
    }
    await revokeAuthSession(h.db, session.id);
    await markSessionRevoked(h.redis, session.id, 60, h.authDeps.logger);

    const result = await call(user, 'GET', taskPaths.collection);

    expect(result.status).toBe(401);
    expect(errorCode(result)).toBe('SESSION_REVOKED');
  });
});

describe('isolation between users', () => {
  it('treats another user’s task exactly like a nonexistent one and never changes it', async () => {
    const owner = await signUpTestUser(requireHarness(), 'owner');
    const intruder = await signUpTestUser(requireHarness(), 'intruder');
    const task = await createTask(owner, 'Private plans');
    const done = await createTask(owner, 'Private done');
    await call(owner, 'POST', completePath(done.id));
    const before = await requireHarness()
      .db.select()
      .from(tasks)
      .where(eq(tasks.userId, owner.userId));

    for (const result of [
      await call(intruder, 'GET', itemPath(task.id)),
      await call(intruder, 'PATCH', itemPath(task.id), { title: 'Hijacked' }),
      await call(intruder, 'POST', completePath(task.id)),
      await call(intruder, 'POST', reopenPath(done.id)),
      await call(intruder, 'DELETE', itemPath(task.id)),
    ]) {
      expect(result.status).toBe(404);
      expect(errorCode(result)).toBe('TASK_NOT_FOUND');
    }

    const after = await requireHarness()
      .db.select()
      .from(tasks)
      .where(eq(tasks.userId, owner.userId));
    expect(after).toEqual(before);
  });

  it('gives the same answer for another user’s deleted task as for a nonexistent one', async () => {
    const owner = await signUpTestUser(requireHarness(), 'owner');
    const intruder = await signUpTestUser(requireHarness(), 'intruder');
    const task = await createTask(owner, 'Deleted by owner');
    await call(owner, 'DELETE', itemPath(task.id));

    const othersDeleted = await call(intruder, 'DELETE', itemPath(task.id));
    const nonexistent = await call(intruder, 'DELETE', itemPath(taskIdSchema.parse(uuidv7())));

    expect(othersDeleted).toEqual(nonexistent);
    expect(othersDeleted.status).toBe(404);
  });

  it('lists only the caller’s own tasks', async () => {
    const alice = await signUpTestUser(requireHarness(), 'alice');
    const bob = await signUpTestUser(requireHarness(), 'bob');
    const alicesTask = await createTask(alice, 'Alice task');
    await createTask(bob, 'Bob task');

    expect((await list(alice)).tasks.map((t) => t.id)).toEqual([alicesTask.id]);
  });

  it('assigns new tasks to the authenticated user, never to another', async () => {
    const alice = await signUpTestUser(requireHarness(), 'alice');
    const task = await createTask(alice, 'Mine');

    const [row] = await requireHarness().db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row?.userId).toBe(alice.userId);
  });
});
