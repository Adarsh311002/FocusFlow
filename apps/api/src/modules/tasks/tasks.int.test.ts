import {
  API_BASE_PATH,
  errorBodySchema,
  mePaths,
  meResponseSchema,
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

import { beginHeldTransaction, trackSettled, waitUntilBlockedBy } from '../../../test/db-locks.js';
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

const putCurrentTask = (user: TestUser, taskId: string | null): Promise<ApiResult> =>
  call(user, 'PUT', mePaths.currentTask, { taskId });

const makeCurrent = async (user: TestUser, taskId: TaskId): Promise<void> => {
  const result = await putCurrentTask(user, taskId);
  expect(result.status).toBe(200);
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
    await makeCurrent(user, task.id);

    await call(user, 'POST', completePath(task.id));
    expect(await currentTaskIdOf(user)).toBeNull();

    await call(user, 'POST', reopenPath(task.id));
    expect(await currentTaskIdOf(user)).toBeNull();
  });

  it('deleting the current task clears it', async () => {
    const user = await signUpTestUser(requireHarness());
    const task = await createTask(user, 'Current');
    await makeCurrent(user, task.id);

    await call(user, 'DELETE', itemPath(task.id));

    expect(await currentTaskIdOf(user)).toBeNull();
  });

  it('completing or deleting a different task leaves the current task alone', async () => {
    const user = await signUpTestUser(requireHarness());
    const current = await createTask(user, 'Current');
    const other = await createTask(user, 'Other');
    const third = await createTask(user, 'Third');
    await makeCurrent(user, current.id);

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

const meOf = async (user: TestUser) => {
  const result = await call(user, 'GET', mePaths.self);
  expect(result.status).toBe(200);
  return meResponseSchema.parse(result.body).user;
};

describe('PUT /me/current-task (D3, D43)', () => {
  it('starts with no current task', async () => {
    const user = await signUpTestUser(requireHarness());

    expect((await meOf(user)).currentTaskId).toBeNull();
  });

  it('sets an open task as current and returns the updated user', async () => {
    const user = await signUpTestUser(requireHarness());
    const task = await createTask(user, 'Focus on this');

    const result = await putCurrentTask(user, task.id);

    expect(result.status).toBe(200);
    expect(meResponseSchema.parse(result.body).user.currentTaskId).toBe(task.id);
    expect((await meOf(user)).currentTaskId).toBe(task.id);
  });

  it('is repeatable, switches between tasks, and clears with null', async () => {
    const user = await signUpTestUser(requireHarness());
    const first = await createTask(user, 'first');
    const second = await createTask(user, 'second');

    await makeCurrent(user, first.id);
    await makeCurrent(user, first.id);
    expect((await meOf(user)).currentTaskId).toBe(first.id);

    await makeCurrent(user, second.id);
    expect((await meOf(user)).currentTaskId).toBe(second.id);

    const cleared = await putCurrentTask(user, null);
    expect(cleared.status).toBe(200);
    expect(meResponseSchema.parse(cleared.body).user.currentTaskId).toBeNull();
    expect((await putCurrentTask(user, null)).status).toBe(200);
  });

  it('rejects a completed task with 409 TASK_NOT_OPEN and keeps the previous choice', async () => {
    const user = await signUpTestUser(requireHarness());
    const current = await createTask(user, 'current');
    const done = await createTask(user, 'done');
    await makeCurrent(user, current.id);
    await call(user, 'POST', completePath(done.id));

    const result = await putCurrentTask(user, done.id);

    expect(result.status).toBe(409);
    expect(errorCode(result)).toBe('TASK_NOT_OPEN');
    expect((await meOf(user)).currentTaskId).toBe(current.id);
  });

  it('answers TASK_NOT_FOUND alike for a deleted, a nonexistent and another user’s task', async () => {
    const user = await signUpTestUser(requireHarness(), 'owner');
    const other = await signUpTestUser(requireHarness(), 'other');
    const deleted = await createTask(user, 'deleted');
    await call(user, 'DELETE', itemPath(deleted.id));
    const othersTask = await createTask(other, 'not yours');

    const results = [
      await putCurrentTask(user, deleted.id),
      await putCurrentTask(user, uuidv7()),
      await putCurrentTask(user, othersTask.id),
    ];

    for (const result of results) {
      expect(result.status).toBe(404);
      expect(errorCode(result)).toBe('TASK_NOT_FOUND');
    }
    expect(results[0]?.body).toEqual(results[1]?.body);
    expect(results[1]?.body).toEqual(results[2]?.body);
    expect((await meOf(user)).currentTaskId).toBeNull();
    expect((await meOf(other)).currentTaskId).toBeNull();
  });

  it('validates the body strictly', async () => {
    const user = await signUpTestUser(requireHarness());
    const task = await createTask(user, 'task');

    for (const body of [{}, { taskId: 'nope' }, { taskId: task.id, userId: user.userId }]) {
      const result = await call(user, 'PUT', mePaths.currentTask, body);
      expect(result.status).toBe(400);
      expect(errorCode(result)).toBe('VALIDATION_FAILED');
    }
  });

  it('requires authentication', async () => {
    const result = await call(null, 'PUT', mePaths.currentTask, { taskId: null });

    expect(result.status).toBe(401);
    expect(errorCode(result)).toBe('UNAUTHENTICATED');
  });
});

describe('current task under concurrency', () => {
  // Each round races "make this task current" against "complete" (or "delete") of the
  // same task. Whichever wins, the invariant must hold afterwards: the current task is
  // never a completed or deleted task. Neither request may fail with a server error.
  // This is a probabilistic smoke test over real HTTP; the deterministic proof that the
  // locking order is what guarantees this is in "current task locking (deterministic)".
  const ROUNDS = 25;

  const assertCurrentIsOpenOrNull = async (user: TestUser): Promise<void> => {
    const currentTaskId = (await meOf(user)).currentTaskId;
    if (currentTaskId === null) {
      return;
    }
    const [row] = await requireHarness().db.select().from(tasks).where(eq(tasks.id, currentTaskId));
    expect(row?.completedAt).toBeNull();
    expect(row?.deletedAt).toBeNull();
  };

  it('set-current racing complete never leaves a completed task current', async () => {
    const user = await signUpTestUser(requireHarness());

    for (let round = 0; round < ROUNDS; round += 1) {
      const task = await createTask(user, `race ${String(round)}`);

      const [setResult, completeResult] = await Promise.all([
        putCurrentTask(user, task.id),
        call(user, 'POST', completePath(task.id)),
      ]);

      expect(completeResult.status).toBe(200);
      expect([200, 409]).toContain(setResult.status);
      expect((await meOf(user)).currentTaskId).toBeNull();
      await assertCurrentIsOpenOrNull(user);
    }
  });

  it('set-current racing delete never leaves a deleted task current', async () => {
    const user = await signUpTestUser(requireHarness());

    for (let round = 0; round < ROUNDS; round += 1) {
      const task = await createTask(user, `race ${String(round)}`);

      const [setResult, deleteResult] = await Promise.all([
        putCurrentTask(user, task.id),
        call(user, 'DELETE', itemPath(task.id)),
      ]);

      expect(deleteResult.status).toBe(204);
      expect([200, 404]).toContain(setResult.status);
      expect((await meOf(user)).currentTaskId).toBeNull();
      await assertCurrentIsOpenOrNull(user);
    }
  });
});

// Deterministic versions of the races above. A transaction on its own connection takes
// the row lock the competing operation would take, the real endpoint is then called, and
// PostgreSQL itself (pg_blocking_pids) must report that request as blocked by that
// transaction before it commits. Each test therefore proves the ordering, not just the
// final invariant.
describe('current task locking (deterministic)', () => {
  const currentTaskInDb = async (user: TestUser): Promise<string | null | undefined> => {
    const [row] = await requireHarness()
      .db.select({ currentTaskId: users.currentTaskId })
      .from(users)
      .where(eq(users.id, user.userId));
    return row?.currentTaskId;
  };

  it.each([
    ['complete', 'completed_at', 409, 'TASK_NOT_OPEN'],
    ['delete', 'deleted_at', 404, 'TASK_NOT_FOUND'],
  ] as const)(
    'PUT /me/current-task waits for an uncommitted %s, then sees the committed state',
    async (_label, column, expectedStatus, expectedCode) => {
      const h = requireHarness();
      const user = await signUpTestUser(h);
      const task = await createTask(user, 'locked by a concurrent change');

      // The competing complete/delete, mid-transaction: the task row is updated (and so
      // row-locked) but not committed yet.
      const holder = await beginHeldTransaction(h.pool);
      try {
        await holder.client.query(`UPDATE tasks SET ${column} = now() WHERE id = $1`, [task.id]);

        const put = trackSettled(putCurrentTask(user, task.id));

        // set-current's FOR SHARE read must queue behind the uncommitted update. Without
        // the lock it would read the old (open) row, succeed, and never appear here.
        await waitUntilBlockedBy(h.pool, holder.pid);
        expect(put.state.settled).toBe(false);

        await holder.commit();
        const result = await put.done;

        // After the commit, the locking read returns the committed row and rejects it.
        expect(result.status).toBe(expectedStatus);
        expect(errorCode(result)).toBe(expectedCode);
        expect(await currentTaskInDb(user)).toBeNull();
      } finally {
        await holder.rollback();
      }
    },
  );

  it.each([
    ['complete', (user: TestUser, id: TaskId) => call(user, 'POST', completePath(id)), 200],
    ['delete', (user: TestUser, id: TaskId) => call(user, 'DELETE', itemPath(id)), 204],
  ] as const)(
    '%s waits for an uncommitted set-current, then clears the committed choice (D43, D38)',
    async (_label, runOperation, expectedStatus) => {
      const h = requireHarness();
      const user = await signUpTestUser(h);
      const task = await createTask(user, 'about to become current');

      // A concurrent set-current, mid-transaction, doing exactly what setCurrentTask
      // does: lock the task FOR SHARE, then point the user at it; not committed yet.
      const holder = await beginHeldTransaction(h.pool);
      try {
        await holder.client.query('SELECT id FROM tasks WHERE id = $1 AND user_id = $2 FOR SHARE', [
          task.id,
          user.userId,
        ]);
        await holder.client.query('UPDATE users SET current_task_id = $1 WHERE id = $2', [
          task.id,
          user.userId,
        ]);

        const operation = trackSettled(runOperation(user, task.id));

        // The task-row update must queue behind the share lock...
        await waitUntilBlockedBy(h.pool, holder.pid);
        expect(operation.state.settled).toBe(false);

        await holder.commit();
        const result = await operation.done;

        // ...so its conditional clear runs after set-current committed, sees the new
        // current task, and clears it.
        expect(result.status).toBe(expectedStatus);
        expect(await currentTaskInDb(user)).toBeNull();
      } finally {
        await holder.rollback();
      }
    },
  );

  it('counterfactual: the same interleaving WITHOUT the row lock leaves a completed task current', async () => {
    // This is what setCurrentTask would do with a plain read instead of FOR SHARE. It is
    // the interleaving of the previous test, minus the lock, and it breaks the invariant,
    // which is why the service locks the task row first.
    const h = requireHarness();
    const user = await signUpTestUser(h);
    const task = await createTask(user, 'unlocked read');

    const holder = await beginHeldTransaction(h.pool);
    try {
      // 1. "Set current" reads the task without a lock: it looks open.
      const read = await holder.client.query<{ completed_at: Date | null }>(
        'SELECT completed_at FROM tasks WHERE id = $1 AND user_id = $2',
        [task.id, user.userId],
      );
      expect(read.rows[0]?.completed_at).toBeNull();

      // 2. A complete runs in between. Nothing blocks it, and there is nothing to clear
      //    yet because the user does not point at the task.
      const completed = await call(user, 'POST', completePath(task.id));
      expect(completed.status).toBe(200);

      // 3. "Set current" writes based on its stale read and commits.
      await holder.client.query('UPDATE users SET current_task_id = $1 WHERE id = $2', [
        task.id,
        user.userId,
      ]);
      await holder.commit();

      // The current task is now a completed task: exactly what the FOR SHARE lock in
      // setCurrentTask (proven by the tests above) prevents.
      expect(await currentTaskInDb(user)).toBe(task.id);
      const [row] = await h.db.select().from(tasks).where(eq(tasks.id, task.id));
      expect(row?.completedAt).not.toBeNull();
    } finally {
      await holder.rollback();
    }
  });
});
