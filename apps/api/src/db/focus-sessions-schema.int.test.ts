import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startTestHarness, stopTestHarness, type TestHarness } from '../../test/harness.js';
import { authIdentities, authSessions, focusSessions, tasks, users } from './schema.js';

// Database-level guarantees of the Phase 4B schema (migration 0002_create_focus_sessions),
// checked against the real PostgreSQL 18 with the committed migrations applied. Rules
// that need the clock, presence or task state (open / not deleted at start, E3) belong to
// the focus-session service and are tested there.

const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';

let harness: TestHarness | undefined;

const db = () => {
  if (harness === undefined) {
    throw new Error('the API harness failed to start');
  }
  return harness.db;
};

/** The PostgreSQL error code of a rejected query, plus the violated constraint's name. */
const pgError = async (
  query: Promise<unknown>,
): Promise<{ code: string; constraint?: string } | undefined> => {
  try {
    await query;
  } catch (error) {
    let current: unknown = error;
    while (typeof current === 'object' && current !== null) {
      if ('code' in current && typeof current.code === 'string') {
        const constraint =
          'constraint' in current && typeof current.constraint === 'string'
            ? current.constraint
            : undefined;
        return constraint === undefined
          ? { code: current.code }
          : { code: current.code, constraint };
      }
      current = 'cause' in current ? current.cause : undefined;
    }
    return { code: 'unknown-error' };
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

const insertTask = async (userId: string): Promise<string> => {
  const id = uuidv7();
  await db().insert(tasks).values({ id, userId, title: 'A task' });
  return id;
};

const STARTED = new Date('2026-10-07T10:00:00.000Z');
const LATER = new Date('2026-10-07T10:25:00.000Z');
const EARLIER = new Date('2026-10-07T09:00:00.000Z');

type SessionInsert = typeof focusSessions.$inferInsert;

/** A valid running session; tests override single fields to probe one constraint. */
const running = (userId: string, overrides: Partial<SessionInsert> = {}): SessionInsert => ({
  id: uuidv7(),
  userId,
  status: 'in_progress',
  plannedSeconds: 1_500,
  focusedSeconds: 0,
  runningSince: STARTED,
  startedAt: STARTED,
  ...overrides,
});

const completed = (userId: string, overrides: Partial<SessionInsert> = {}): SessionInsert =>
  running(userId, {
    status: 'completed',
    focusedSeconds: 1_500,
    runningSince: null,
    endedAt: LATER,
    ...overrides,
  });

const abandoned = (userId: string, overrides: Partial<SessionInsert> = {}): SessionInsert =>
  running(userId, {
    status: 'abandoned',
    abandonReason: 'stopped',
    focusedSeconds: 300,
    runningSince: null,
    endedAt: LATER,
    ...overrides,
  });

const insert = (values: SessionInsert) => db().insert(focusSessions).values(values);

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

describe('focus_sessions: valid rows', () => {
  it('accepts a running, a paused, a completed and each solo abandoned session', async () => {
    const userId = await insertUser();
    await insert(running(userId));
    for (const reason of ['stopped', 'grace_expired', 'expired']) {
      await insert(abandoned(userId, { abandonReason: reason }));
    }
    await insert(completed(userId));
    const otherUser = await insertUser();
    await insert(running(otherUser, { runningSince: null, focusedSeconds: 300 }));

    const rows = await db().select().from(focusSessions);
    expect(rows).toHaveLength(6);
  });

  it('defaults focused_seconds to 0 and sets created_at/updated_at', async () => {
    const userId = await insertUser();
    const { id, status, plannedSeconds, runningSince, startedAt } = running(userId);
    await insert({ id, userId, status, plannedSeconds, runningSince, startedAt });
    const [row] = await db().select().from(focusSessions).where(eq(focusSessions.userId, userId));
    expect(row?.focusedSeconds).toBe(0);
    expect(row?.createdAt).toBeInstanceOf(Date);
    expect(row?.updatedAt).toBeInstanceOf(Date);
  });

  it('has exactly the approved columns: no room fields in Phase 4B (E4)', async () => {
    const result = await db().execute<{ column_name: string }>(
      sql`SELECT column_name FROM information_schema.columns
          WHERE table_name = 'focus_sessions' ORDER BY ordinal_position`,
    );
    expect(result.rows.map((row) => row.column_name)).toEqual([
      'id',
      'user_id',
      'task_id',
      'status',
      'abandon_reason',
      'planned_seconds',
      'focused_seconds',
      'running_since',
      'started_at',
      'ended_at',
      'created_at',
      'updated_at',
    ]);
  });
});

describe('focus_sessions: CHECK constraints', () => {
  const cases: [string, (userId: string) => SessionInsert, string][] = [
    [
      // Ended fields set, so only the status rule is broken.
      'an unknown status',
      (u) => running(u, { status: 'paused', runningSince: null, endedAt: LATER }),
      'ck_focus_sessions_status',
    ],
    [
      'a room-only abandon reason (E5)',
      (u) => abandoned(u, { abandonReason: 'timer_lost' }),
      'ck_focus_sessions_abandon_reason',
    ],
    [
      'a planned duration under 60 s (E1)',
      (u) => running(u, { plannedSeconds: 59 }),
      'ck_focus_sessions_planned_seconds',
    ],
    [
      'a planned duration over 14,400 s (E1)',
      (u) => running(u, { plannedSeconds: 14_401 }),
      'ck_focus_sessions_planned_seconds',
    ],
    [
      'negative focused seconds',
      (u) => running(u, { focusedSeconds: -1 }),
      'ck_focus_sessions_focused_seconds',
    ],
    [
      'focused seconds above the plan',
      (u) => running(u, { focusedSeconds: 1_501 }),
      'ck_focus_sessions_focused_seconds',
    ],
    [
      'an in-progress session with an end time',
      (u) => running(u, { endedAt: LATER }),
      'ck_focus_sessions_ended_at',
    ],
    [
      'a completed session without an end time',
      (u) => completed(u, { endedAt: null }),
      'ck_focus_sessions_ended_at',
    ],
    [
      'an abandoned session without a reason',
      (u) => abandoned(u, { abandonReason: null }),
      'ck_focus_sessions_abandon_reason_presence',
    ],
    [
      'a completed session with an abandon reason',
      (u) => completed(u, { abandonReason: 'stopped' }),
      'ck_focus_sessions_abandon_reason_presence',
    ],
    [
      'an ended session still running',
      (u) => abandoned(u, { runningSince: LATER }),
      'ck_focus_sessions_running_since',
    ],
    [
      'an end before the start',
      (u) => abandoned(u, { endedAt: EARLIER }),
      'ck_focus_sessions_ended_after_started',
    ],
    [
      'a running stretch before the start (E15)',
      (u) => running(u, { runningSince: EARLIER }),
      'ck_focus_sessions_running_since_after_started',
    ],
    [
      'a completed session with less than the plan (E15)',
      (u) => completed(u, { focusedSeconds: 1_499 }),
      'ck_focus_sessions_completed_focused',
    ],
  ];

  it.each(cases)('rejects %s', async (_label, build, constraint) => {
    const userId = await insertUser();
    expect(await pgError(insert(build(userId)))).toEqual({ code: CHECK_VIOLATION, constraint });
  });
});

describe('focus_sessions: one in-progress session per user', () => {
  it('rejects a second in-progress session for the same user', async () => {
    const userId = await insertUser();
    await insert(running(userId));
    expect(await pgError(insert(running(userId, { runningSince: null })))).toEqual({
      code: UNIQUE_VIOLATION,
      constraint: 'uq_focus_sessions_user_id_in_progress',
    });
  });

  it('allows any number of ended sessions next to the in-progress one, and other users', async () => {
    const userId = await insertUser();
    await insert(running(userId));
    await insert(completed(userId));
    await insert(completed(userId));
    await insert(abandoned(userId));
    await insert(running(await insertUser()));
  });

  it('allows a new in-progress session once the previous one has ended', async () => {
    const userId = await insertUser();
    const first = running(userId);
    await insert(first);
    await db()
      .update(focusSessions)
      .set({ status: 'abandoned', abandonReason: 'stopped', runningSince: null, endedAt: LATER })
      .where(eq(focusSessions.id, first.id));
    await insert(running(userId));
  });
});

describe('focus_sessions: references', () => {
  it('accepts the user’s own task, and a session without a task', async () => {
    const userId = await insertUser();
    const taskId = await insertTask(userId);
    await insert(completed(userId, { taskId }));
    await insert(running(userId, { taskId: null }));
  });

  it('rejects another user’s task (composite foreign key)', async () => {
    const owner = await insertUser();
    const taskId = await insertTask(owner);
    const other = await insertUser();
    expect(await pgError(insert(running(other, { taskId })))).toEqual({
      code: FOREIGN_KEY_VIOLATION,
      constraint: 'fk_focus_sessions_task_id',
    });
  });

  it('rejects a user or task that does not exist', async () => {
    expect((await pgError(insert(running(uuidv7()))))?.code).toBe(FOREIGN_KEY_VIOLATION);
    const userId = await insertUser();
    expect((await pgError(insert(running(userId, { taskId: uuidv7() }))))?.code).toBe(
      FOREIGN_KEY_VIOLATION,
    );
  });

  it('keeps the link to a soft-deleted task for history (D38)', async () => {
    const userId = await insertUser();
    const taskId = await insertTask(userId);
    const session = completed(userId, { taskId });
    await insert(session);
    await db().update(tasks).set({ deletedAt: LATER }).where(eq(tasks.id, taskId));

    const [row] = await db().select().from(focusSessions).where(eq(focusSessions.id, session.id));
    expect(row?.taskId).toBe(taskId);
  });

  it('has no ON DELETE action on the task: a referenced task row cannot be hard-deleted (P1)', async () => {
    const userId = await insertUser();
    const taskId = await insertTask(userId);
    await insert(completed(userId, { taskId }));
    expect(await pgError(db().delete(tasks).where(eq(tasks.id, taskId)))).toEqual({
      code: FOREIGN_KEY_VIOLATION,
      constraint: 'fk_focus_sessions_task_id',
    });
  });

  it('deleting a user removes their sessions and tasks together', async () => {
    const userId = await insertUser();
    const taskId = await insertTask(userId);
    await insert(running(userId, { taskId }));
    await insert(completed(userId, { taskId }));

    await db().delete(users).where(eq(users.id, userId));

    expect(await db().select().from(focusSessions).where(eq(focusSessions.userId, userId))).toEqual(
      [],
    );
    expect(await db().select().from(tasks).where(eq(tasks.userId, userId))).toEqual([]);
  });
});

describe('focus_sessions: indexes', () => {
  it('has the partial unique index and the history index, as approved', async () => {
    const result = await db().execute<{ indexname: string; indexdef: string }>(
      sql`SELECT indexname, indexdef FROM pg_indexes
          WHERE tablename = 'focus_sessions' ORDER BY indexname`,
    );
    expect(result.rows.map((row) => row.indexname)).toEqual([
      'ix_focus_sessions_user_id_started_at',
      'pk_focus_sessions',
      'uq_focus_sessions_user_id_in_progress',
    ]);
    const byName = new Map(result.rows.map((row) => [row.indexname, row.indexdef]));
    expect(byName.get('uq_focus_sessions_user_id_in_progress')).toMatch(
      /UNIQUE INDEX .* \(user_id\) WHERE \(status = 'in_progress'::text\)/,
    );
    // Drizzle spells out NULLS LAST; started_at is NOT NULL, so it changes nothing.
    expect(byName.get('ix_focus_sessions_user_id_started_at')).toMatch(
      /\(user_id, started_at DESC( NULLS LAST)?\)/,
    );
  });
});
