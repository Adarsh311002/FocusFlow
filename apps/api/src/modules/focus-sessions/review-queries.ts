import { and, desc, eq, gte, lt, ne, sql } from 'drizzle-orm';

import type { Executor } from '../../db/client.js';
import { focusSessions, tasks } from '../../db/schema.js';
import type { FocusSessionRow, SessionTaskRow } from './queries.js';

// Review reads (Phase 5, V1–V8). Every query is scoped by the requesting user; another
// user's sessions and tasks cannot appear, and a cursor naming another user's session
// resolves to nothing.

export type HistoryRow = {
  readonly session: FocusSessionRow;
  /** `null` when the session has no task. Soft-deleted tasks are included (D38). */
  readonly task: SessionTaskRow | null;
};

export type HistoryFilter = {
  /** `started_at >= from` */
  readonly fromMs: number | undefined;
  /** `started_at < to` */
  readonly toMs: number | undefined;
  /** Only sessions after this one in the order; already checked to be the user's own. */
  readonly afterSessionId: string | undefined;
  readonly limit: number;
};

/** Whether `sessionId` is one of the user's sessions (a cursor's anchor). */
export const ownSessionExists = async (
  db: Executor,
  userId: string,
  sessionId: string,
): Promise<boolean> => {
  const [row] = await db
    .select({ id: focusSessions.id })
    .from(focusSessions)
    .where(and(eq(focusSessions.id, sessionId), eq(focusSessions.userId, userId)))
    .limit(1);
  return row !== undefined;
};

/**
 * One page of the user's sessions, newest-started first, ties broken by id (V2), served by
 * `ix_focus_sessions_user_id_started_at`. The task comes from the same query (no N+1),
 * joined on both its id and the owner so no other user's task title can appear. The
 * keyset condition compares against the anchor's stored values inside PostgreSQL, so no
 * timestamp passes through JavaScript.
 */
export const listOwnSessions = async (
  db: Executor,
  userId: string,
  filter: HistoryFilter,
): Promise<HistoryRow[]> =>
  db
    .select({
      session: focusSessions,
      task: { id: tasks.id, title: tasks.title, deletedAt: tasks.deletedAt },
    })
    .from(focusSessions)
    .leftJoin(
      tasks,
      and(eq(tasks.id, focusSessions.taskId), eq(tasks.userId, focusSessions.userId)),
    )
    .where(
      and(
        eq(focusSessions.userId, userId),
        filter.fromMs === undefined
          ? undefined
          : gte(focusSessions.startedAt, new Date(filter.fromMs)),
        filter.toMs === undefined ? undefined : lt(focusSessions.startedAt, new Date(filter.toMs)),
        filter.afterSessionId === undefined
          ? undefined
          : sql`(${focusSessions.startedAt}, ${focusSessions.id}) < (
              SELECT anchor.started_at, anchor.id FROM focus_sessions AS anchor
              WHERE anchor.id = ${filter.afterSessionId} AND anchor.user_id = ${userId})`,
      ),
    )
    .orderBy(desc(focusSessions.startedAt), desc(focusSessions.id))
    .limit(filter.limit);

/** Ended sessions that started in one UTC minute: the summary's unit of aggregation (V7). */
export type SummaryMinute = {
  readonly minuteStartMs: number;
  readonly completedCount: number;
  readonly completedFocusedSeconds: number;
  readonly totalFocusedSeconds: number;
};

/**
 * The user's ended sessions with `started_at` in `[fromMs, toMs)`, summed per UTC minute
 * of `started_at`. PostgreSQL never sees the time zone: the caller maps each minute to its
 * calendar date with `Intl` (V5, V7). Every UTC offset since 1972 is a whole number of
 * minutes, so a minute never straddles a local midnight. A handful of zones had sub-minute
 * offsets before that (Africa/Monrovia was −00:44:30 until 1972-01-07), where a bucket
 * could fall on the wrong side of a local midnight; `started_at` is always written from the
 * server clock, so no such row can be created through the API. In-progress sessions are
 * excluded (V6).
 */
export const sumEndedSessionsByMinute = async (
  db: Executor,
  userId: string,
  range: { readonly fromMs: number; readonly toMs: number },
): Promise<SummaryMinute[]> => {
  const minute = sql`date_bin('1 minute', ${focusSessions.startedAt}, TIMESTAMPTZ '2000-01-01 00:00:00+00')`;
  return db
    .select({
      minuteStartMs: minute.mapWith((value: Date | string) => new Date(value).getTime()),
      completedCount: sql`count(*) FILTER (WHERE ${focusSessions.status} = 'completed')`.mapWith(
        Number,
      ),
      completedFocusedSeconds:
        sql`coalesce(sum(${focusSessions.focusedSeconds}) FILTER (WHERE ${focusSessions.status} = 'completed'), 0)`.mapWith(
          Number,
        ),
      totalFocusedSeconds: sql`coalesce(sum(${focusSessions.focusedSeconds}), 0)`.mapWith(Number),
    })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.userId, userId),
        ne(focusSessions.status, 'in_progress'),
        gte(focusSessions.startedAt, new Date(range.fromMs)),
        lt(focusSessions.startedAt, new Date(range.toMs)),
      ),
    )
    .groupBy(minute);
};
