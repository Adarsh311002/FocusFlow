import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startTestHarness, stopTestHarness, type TestHarness } from '../../test/harness.js';
import { authIdentities, authSessions, tasks, users } from './schema.js';

// Database-level guarantees of the Phase 2 schema (migration 0001_create_tasks), checked
// against the real PostgreSQL 18 with the committed migrations applied. The rules the
// database cannot enforce alone (open / not deleted) are covered by the task service tests.

const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';

let harness: TestHarness | undefined;

const db = () => {
  if (harness === undefined) {
    throw new Error('the API harness failed to start');
  }
  return harness.db;
};

/** The PostgreSQL error code of a rejected query (Drizzle wraps the driver error in `cause`). */
const pgErrorCode = async (query: Promise<unknown>): Promise<string | undefined> => {
  try {
    await query;
  } catch (error) {
    let current: unknown = error;
    while (typeof current === 'object' && current !== null) {
      if ('code' in current && typeof current.code === 'string') {
        return current.code;
      }
      current = 'cause' in current ? current.cause : undefined;
    }
    return 'unknown-error';
  }
  return undefined;
};

const insertUser = async (): Promise<string> => {
  const id = uuidv7();
  await db()
    .insert(users)
    .values({
      id,
      email: `user-${id}@example.com`,
      displayName: 'User',
      passwordHash: 'not-a-real-hash',
      emailVerifiedAt: null,
    });
  return id;
};

const insertTask = async (userId: string, title = 'A task'): Promise<string> => {
  const id = uuidv7();
  await db().insert(tasks).values({ id, userId, title });
  return id;
};

const setCurrentTask = (userId: string, taskId: string | null) =>
  db().update(users).set({ currentTaskId: taskId }).where(eq(users.id, userId));

beforeAll(async () => {
  harness = await startTestHarness();
}, 120_000);

afterAll(async () => {
  if (harness !== undefined) {
    await stopTestHarness(harness);
  }
}, 60_000);

beforeEach(async () => {
  await db().delete(authIdentities);
  await db().delete(authSessions);
  await db().delete(users);
});

describe('tasks table', () => {
  it('enforces the 1-200 character title length', async () => {
    const userId = await insertUser();

    expect(await pgErrorCode(insertTask(userId, ''))).toBe(CHECK_VIOLATION);
    expect(await pgErrorCode(insertTask(userId, 'a'.repeat(201)))).toBe(CHECK_VIOLATION);
    expect(await pgErrorCode(insertTask(userId, 'a'.repeat(200)))).toBeUndefined();
  });

  it('rejects a task for a user that does not exist', async () => {
    expect(await pgErrorCode(insertTask(uuidv7()))).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('keeps a soft-deleted task row', async () => {
    const userId = await insertUser();
    const taskId = await insertTask(userId);

    await db().update(tasks).set({ deletedAt: new Date() }).where(eq(tasks.id, taskId));

    const [row] = await db().select().from(tasks).where(eq(tasks.id, taskId));
    expect(row?.deletedAt).toBeInstanceOf(Date);
  });
});

describe('users.current_task_id', () => {
  it('accepts one of the same user’s own tasks and NULL', async () => {
    const userId = await insertUser();
    const taskId = await insertTask(userId);

    expect(await pgErrorCode(setCurrentTask(userId, taskId))).toBeUndefined();
    expect(await pgErrorCode(setCurrentTask(userId, null))).toBeUndefined();
  });

  it('rejects another user’s task (composite foreign key)', async () => {
    const owner = await insertUser();
    const other = await insertUser();
    const othersTask = await insertTask(other);

    expect(await pgErrorCode(setCurrentTask(owner, othersTask))).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('rejects a task id that does not exist', async () => {
    const userId = await insertUser();

    expect(await pgErrorCode(setCurrentTask(userId, uuidv7()))).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('has no ON DELETE action: a task row that is still current cannot be hard-deleted (P1)', async () => {
    const userId = await insertUser();
    const taskId = await insertTask(userId);
    await setCurrentTask(userId, taskId);

    expect(await pgErrorCode(db().delete(tasks).where(eq(tasks.id, taskId)))).toBe(
      FOREIGN_KEY_VIOLATION,
    );
    const [user] = await db().select().from(users).where(eq(users.id, userId));
    expect(user?.currentTaskId).toBe(taskId);
  });

  it('deleting a user whose current task is set cascades to the tasks cleanly', async () => {
    const userId = await insertUser();
    const current = await insertTask(userId, 'current');
    await insertTask(userId, 'another');
    const deleted = await insertTask(userId, 'soft-deleted');
    await db().update(tasks).set({ deletedAt: new Date() }).where(eq(tasks.id, deleted));
    await setCurrentTask(userId, current);

    const bystander = await insertUser();
    const bystanderTask = await insertTask(bystander);
    await setCurrentTask(bystander, bystanderTask);

    expect(await pgErrorCode(db().delete(users).where(eq(users.id, userId)))).toBeUndefined();

    expect(await db().select().from(tasks).where(eq(tasks.userId, userId))).toEqual([]);
    const [survivor] = await db().select().from(users).where(eq(users.id, bystander));
    expect(survivor?.currentTaskId).toBe(bystanderTask);
    expect(await db().select().from(tasks).where(eq(tasks.userId, bystander))).toHaveLength(1);
  });
});
