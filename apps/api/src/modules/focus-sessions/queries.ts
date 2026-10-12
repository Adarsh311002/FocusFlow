import { and, asc, eq, gt, isNotNull, lte, sql } from 'drizzle-orm';

import type { Executor, Tx } from '../../db/client.js';
import { focusSessions, tasks } from '../../db/schema.js';

export type FocusSessionRow = typeof focusSessions.$inferSelect;

/** The task a session references, read for its view (soft-deleted tasks included, D38). */
export type SessionTaskRow = {
  readonly id: string;
  readonly title: string;
  readonly deletedAt: Date | null;
};

// Every query is scoped by BOTH the session id and the owning user id, so another user's
// session is indistinguishable from one that does not exist (docs/api/rest.md,
// "Ownership"). Timestamps are written at millisecond precision so a value read back into
// JavaScript compares exactly (docs/architecture/focus-timing-protocol.md, "Clocks").

const ownedBy = (userId: string, sessionId: string) =>
  and(eq(focusSessions.id, sessionId), eq(focusSessions.userId, userId));

/**
 * The PostgreSQL clock for all session arithmetic (E9), truncated to milliseconds.
 * `clock_timestamp()`, not `now()`: `now()` is fixed when the transaction began, so a
 * request that then waited for the session's row lock would compute with an instant from
 * before the change it waited for (for example a `running_since` set by a concurrent
 * resume). Called after the lock is held, this is never earlier than anything committed
 * before it.
 */
export const databaseNowMs = async (tx: Executor): Promise<number> => {
  const result = await tx.execute<{ now: Date | string }>(
    sql`SELECT date_trunc('milliseconds', clock_timestamp()) AS now`,
  );
  const value = result.rows[0]?.now;
  if (value === undefined) {
    throw new Error('databaseNowMs: no row');
  }
  return new Date(value).getTime();
};

export type NewRunningSession = {
  readonly id: string;
  readonly userId: string;
  readonly taskId: string | null;
  readonly plannedSeconds: number;
  readonly startedAtMs: number;
};

/** A new running session: `running_since = started_at`, nothing focused yet. */
export const insertRunningSession = async (
  tx: Tx,
  values: NewRunningSession,
): Promise<FocusSessionRow> => {
  const startedAt = new Date(values.startedAtMs);
  const [row] = await tx
    .insert(focusSessions)
    .values({
      id: values.id,
      userId: values.userId,
      taskId: values.taskId,
      status: 'in_progress',
      plannedSeconds: values.plannedSeconds,
      focusedSeconds: 0,
      runningSince: startedAt,
      startedAt,
    })
    .returning();
  if (row === undefined) {
    throw new Error('insertRunningSession: insert returned no row');
  }
  return row;
};

/** The session row, locked `FOR UPDATE` for the rest of the transaction (no join, so no task lock). */
export const lockOwnedSession = async (
  tx: Tx,
  userId: string,
  sessionId: string,
): Promise<FocusSessionRow | undefined> => {
  const [row] = await tx
    .select()
    .from(focusSessions)
    .where(ownedBy(userId, sessionId))
    .limit(1)
    .for('update');
  return row;
};

export const findOwnedSession = async (
  db: Executor,
  userId: string,
  sessionId: string,
): Promise<FocusSessionRow | undefined> => {
  const [row] = await db.select().from(focusSessions).where(ownedBy(userId, sessionId)).limit(1);
  return row;
};

/** The user's in-progress session, if any (served by the partial unique index). */
export const findInProgressSession = async (
  db: Executor,
  userId: string,
): Promise<FocusSessionRow | undefined> => {
  const [row] = await db
    .select()
    .from(focusSessions)
    .where(and(eq(focusSessions.userId, userId), eq(focusSessions.status, 'in_progress')))
    .limit(1);
  return row;
};

export type SessionChanges = Pick<
  FocusSessionRow,
  'status' | 'abandonReason' | 'focusedSeconds' | 'runningSince' | 'endedAt'
>;

/** Writes a transition. The row is already locked by `lockOwnedSession`. */
export const saveSession = async (
  tx: Tx,
  sessionId: string,
  changes: SessionChanges,
): Promise<FocusSessionRow> => {
  const [row] = await tx
    .update(focusSessions)
    .set(changes)
    .where(eq(focusSessions.id, sessionId))
    .returning();
  if (row === undefined) {
    throw new Error('saveSession: update returned no row');
  }
  return row;
};

/** The referenced task for a session's view; soft-deleted tasks are still returned (D38). */
export const findSessionTask = async (
  db: Executor,
  userId: string,
  taskId: string,
): Promise<SessionTaskRow | undefined> => {
  const [row] = await db
    .select({ id: tasks.id, title: tasks.title, deletedAt: tasks.deletedAt })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)))
    .limit(1);
  return row;
};

/** The keys the reconciler sweeps by: the locked transaction re-reads everything else. */
export type SessionKey = { readonly id: string; readonly userId: string };

/**
 * One keyset page of in-progress sessions, ordered by user (one in-progress session per
 * user, so `user_id` is a unique cursor), served by `uq_focus_sessions_user_id_in_progress`.
 * `running` keeps only running ones; `startedBeforeMs` keeps only those started at or
 * before that instant (E2's stale threshold, computed by the caller from PostgreSQL time).
 * Nothing is locked: the caller locks each session and re-checks it.
 */
export const listInProgressSessionKeys = async (
  db: Executor,
  page: {
    readonly afterUserId: string | null;
    readonly limit: number;
    readonly running?: boolean;
    readonly startedBeforeMs?: number;
  },
): Promise<SessionKey[]> =>
  db
    .select({ id: focusSessions.id, userId: focusSessions.userId })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.status, 'in_progress'),
        page.afterUserId === null ? undefined : gt(focusSessions.userId, page.afterUserId),
        page.running === true ? isNotNull(focusSessions.runningSince) : undefined,
        page.startedBeforeMs === undefined
          ? undefined
          : lte(focusSessions.startedAt, new Date(page.startedBeforeMs)),
      ),
    )
    .orderBy(asc(focusSessions.userId))
    .limit(page.limit);

/**
 * The session row locked `FOR UPDATE SKIP LOCKED`: `undefined` when it is gone or another
 * transaction (a request, a job, another sweep) holds it — that one is deciding it now.
 */
export const lockOwnedSessionSkipLocked = async (
  tx: Tx,
  userId: string,
  sessionId: string,
): Promise<FocusSessionRow | undefined> => {
  const [row] = await tx
    .select()
    .from(focusSessions)
    .where(ownedBy(userId, sessionId))
    .limit(1)
    .for('update', { skipLocked: true });
  return row;
};

/** Bounds every statement of the caller's transaction (`SET LOCAL`: this transaction only). */
export const limitStatementTime = async (tx: Tx, ms: number): Promise<void> => {
  await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${String(Math.trunc(ms))}`));
};
