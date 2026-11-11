import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startTestHarness, stopTestHarness, type TestHarness } from '../../test/harness.js';
import {
  authIdentities,
  authSessions,
  focusSessions,
  roomMembers,
  rooms,
  tasks,
  users,
} from './schema.js';

// Database-level guarantees of the Phase 4B schema (migration 0002_create_focus_sessions)
// and the Phase 8 room columns (0004_add_room_focus_sessions, RF1), checked against the
// real PostgreSQL 18 with the committed migrations applied. Rules that need the clock,
// presence or task state (open / not deleted at start, E3) belong to the focus-session
// service and are tested there.

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

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
let roomSeq = 0;
const insertRoom = async (hostId: string): Promise<string> => {
  const id = uuidv7();
  const code = `TEST${CODE_ALPHABET[Math.floor(roomSeq / 31) % 31] ?? 'A'}${CODE_ALPHABET[roomSeq % 31] ?? 'A'}`;
  roomSeq += 1;
  await db().insert(rooms).values({ id, code, name: 'Room', hostId, isPrivate: false });
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
  // Rooms restrict deleting their host (and sessions their room), so clear them first.
  await db().delete(focusSessions);
  await db().delete(roomMembers);
  await db().delete(rooms);
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

  it('has exactly the approved columns, the room fields added by Phase 8 (RF1)', async () => {
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
      'room_id',
      'focus_run_id',
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
      'an unknown abandon reason',
      (u) => abandoned(u, { abandonReason: 'gave_up' }),
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
      'ix_focus_sessions_room_run_in_progress',
      'ix_focus_sessions_user_id_started_at',
      'pk_focus_sessions',
      'uq_focus_sessions_user_id_in_progress',
    ]);
    const byName = new Map(result.rows.map((row) => [row.indexname, row.indexdef]));
    expect(byName.get('ix_focus_sessions_room_run_in_progress')).toMatch(
      /\(room_id, focus_run_id\) WHERE \(status = 'in_progress'::text\)/,
    );
    expect(byName.get('uq_focus_sessions_user_id_in_progress')).toMatch(
      /UNIQUE INDEX .* \(user_id\) WHERE \(status = 'in_progress'::text\)/,
    );
    // Drizzle spells out NULLS LAST; started_at is NOT NULL, so it changes nothing.
    expect(byName.get('ix_focus_sessions_user_id_started_at')).toMatch(
      /\(user_id, started_at DESC( NULLS LAST)?\)/,
    );
  });
});

describe('focus_sessions: room sessions (RF1)', () => {
  /** A valid in-progress room session: the room timer owns the clock, so no running_since. */
  const inRoom = (
    userId: string,
    roomId: string,
    overrides: Partial<SessionInsert> = {},
  ): SessionInsert =>
    running(userId, { runningSince: null, roomId, focusRunId: uuidv7(), ...overrides });

  it('accepts a room session in every state and each room abandon reason', async () => {
    const userId = await insertUser();
    const roomId = await insertRoom(userId);
    await insert(inRoom(userId, roomId));
    await insert(completed(userId, { roomId, focusRunId: uuidv7() }));
    const reasons = [
      'opted_out',
      'left_room',
      'removed',
      'reset',
      'phase_changed',
      'grace_expired',
      'timer_lost',
    ];
    for (const reason of reasons) {
      await insert(abandoned(userId, { roomId, focusRunId: uuidv7(), abandonReason: reason }));
    }
    const rows = await db().select().from(focusSessions).where(eq(focusSessions.roomId, roomId));
    expect(rows).toHaveLength(2 + reasons.length);
  });

  it('still accepts a solo row inserted exactly as before, with both room columns NULL', async () => {
    const userId = await insertUser();
    const session = running(userId);
    await insert(session);
    const [row] = await db().select().from(focusSessions).where(eq(focusSessions.id, session.id));
    expect(row?.roomId).toBeNull();
    expect(row?.focusRunId).toBeNull();
  });

  const cases: [string, (userId: string, roomId: string) => SessionInsert, string][] = [
    [
      'a room without a run',
      (u, r) => inRoom(u, r, { focusRunId: null }),
      'ck_focus_sessions_room_run',
    ],
    [
      'a run without a room',
      (u) => running(u, { runningSince: null, focusRunId: uuidv7() }),
      'ck_focus_sessions_room_run',
    ],
    [
      'running_since on a room session',
      (u, r) => inRoom(u, r, { runningSince: STARTED }),
      'ck_focus_sessions_running_since_solo',
    ],
  ];

  it.each(cases)('rejects %s', async (_label, build, constraint) => {
    const userId = await insertUser();
    const roomId = await insertRoom(userId);
    expect(await pgError(insert(build(userId, roomId)))).toEqual({
      code: CHECK_VIOLATION,
      constraint,
    });
  });

  it('rejects a missing room, and a referenced room cannot be deleted (no ON DELETE action)', async () => {
    const userId = await insertUser();
    expect(await pgError(insert(inRoom(userId, uuidv7())))).toEqual({
      code: FOREIGN_KEY_VIOLATION,
      constraint: 'fk_focus_sessions_room_id',
    });
    const roomId = await insertRoom(userId);
    await insert(completed(userId, { roomId, focusRunId: uuidv7() }));
    expect(await pgError(db().delete(rooms).where(eq(rooms.id, roomId)))).toEqual({
      code: FOREIGN_KEY_VIOLATION,
      constraint: 'fk_focus_sessions_room_id',
    });
  });

  it('keeps one in-progress session per user across solo and room sessions', async () => {
    const userId = await insertUser();
    const roomId = await insertRoom(userId);
    await insert(running(userId));
    expect(await pgError(insert(inRoom(userId, roomId)))).toEqual({
      code: UNIQUE_VIOLATION,
      constraint: 'uq_focus_sessions_user_id_in_progress',
    });

    const other = await insertUser();
    await insert(inRoom(other, roomId));
    expect(await pgError(insert(running(other)))).toEqual({
      code: UNIQUE_VIOLATION,
      constraint: 'uq_focus_sessions_user_id_in_progress',
    });
  });

  it('lets many users share a room and a run', async () => {
    const host = await insertUser();
    const roomId = await insertRoom(host);
    const focusRunId = uuidv7();
    await insert(inRoom(host, roomId, { focusRunId }));
    await insert(inRoom(await insertUser(), roomId, { focusRunId }));
    await insert(inRoom(await insertUser(), roomId, { focusRunId }));
  });
});
