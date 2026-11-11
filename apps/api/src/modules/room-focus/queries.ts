import { and, desc, eq, inArray } from 'drizzle-orm';

import type { Executor, Tx } from '../../db/client.js';
import { focusSessions, roomMembers, rooms, users } from '../../db/schema.js';
import type { FocusSessionRow } from '../focus-sessions/queries.js';

// PostgreSQL access of room focus sessions (Phase 8; RF1, RF4, RF6). Every query that
// changes a session first locks it (`FOR UPDATE`) and only touches rows still `in_progress`.
// The solo queries (`modules/focus-sessions/queries.ts`) stay untouched: a room session is a
// `focus_sessions` row with `room_id` and `focus_run_id`, so `findSessionTask`, `saveSession`
// and `databaseNowMs` are shared.

export type NewRoomSession = {
  readonly id: string;
  readonly userId: string;
  readonly taskId: string | null;
  readonly roomId: string;
  readonly focusRunId: string;
  readonly plannedSeconds: number;
  readonly startedAtMs: number;
};

/** A room session: `running_since` stays NULL (the room timer owns the clock, RF1). */
export const insertRoomSession = async (
  tx: Tx,
  values: NewRoomSession,
): Promise<FocusSessionRow> => {
  const [row] = await tx
    .insert(focusSessions)
    .values({
      id: values.id,
      userId: values.userId,
      taskId: values.taskId,
      status: 'in_progress',
      plannedSeconds: values.plannedSeconds,
      focusedSeconds: 0,
      roomId: values.roomId,
      focusRunId: values.focusRunId,
      runningSince: null,
      startedAt: new Date(values.startedAtMs),
    })
    .returning();
  if (row === undefined) {
    throw new Error('insertRoomSession: insert returned no row');
  }
  return row;
};

/** The user's in-progress session in this room, if any (the partial unique index allows one). */
export const findInProgressRoomSession = async (
  db: Executor,
  userId: string,
  roomId: string,
): Promise<FocusSessionRow | undefined> => {
  const [row] = await db
    .select()
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.userId, userId),
        eq(focusSessions.roomId, roomId),
        eq(focusSessions.status, 'in_progress'),
      ),
    )
    .limit(1);
  return row;
};

/** The user's most recent session in this room, ended or not (an opt-out repeat answers it). */
export const findLatestRoomSession = async (
  db: Executor,
  userId: string,
  roomId: string,
): Promise<FocusSessionRow | undefined> => {
  const [row] = await db
    .select()
    .from(focusSessions)
    .where(and(eq(focusSessions.userId, userId), eq(focusSessions.roomId, roomId)))
    .orderBy(desc(focusSessions.startedAt), desc(focusSessions.id))
    .limit(1);
  return row;
};

/** Any in-progress session of the user (solo or room): the global one-session rule. */
export const findAnyInProgressSession = async (
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

/** The session row locked `FOR UPDATE`; `undefined` when it is gone. */
export const lockRoomSession = async (
  tx: Tx,
  sessionId: string,
): Promise<FocusSessionRow | undefined> => {
  const [row] = await tx
    .select()
    .from(focusSessions)
    .where(eq(focusSessions.id, sessionId))
    .limit(1)
    .for('update');
  return row;
};

/** The session row locked `FOR UPDATE SKIP LOCKED`; `undefined` when gone or held by another transaction. */
export const lockRoomSessionSkipLocked = async (
  tx: Tx,
  sessionId: string,
): Promise<FocusSessionRow | undefined> => {
  const [row] = await tx
    .select()
    .from(focusSessions)
    .where(eq(focusSessions.id, sessionId))
    .limit(1)
    .for('update', { skipLocked: true });
  return row;
};

/** In-progress room sessions of one run (the settlement reads their planned seconds). */
export const listRunSessions = (
  db: Executor,
  roomId: string,
  focusRunId: string,
): Promise<FocusSessionRow[]> =>
  db
    .select()
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.roomId, roomId),
        eq(focusSessions.focusRunId, focusRunId),
        eq(focusSessions.status, 'in_progress'),
      ),
    );

/**
 * Deletes a session that never joined its run (RUN_CHANGED, RF4). Only an `in_progress`
 * session of this room and run: a session that ended meanwhile keeps its row.
 */
export const deleteUnjoinedRoomSession = async (
  db: Executor,
  sessionId: string,
  roomId: string,
  focusRunId: string,
): Promise<boolean> => {
  const deleted = await db
    .delete(focusSessions)
    .where(
      and(
        eq(focusSessions.id, sessionId),
        eq(focusSessions.roomId, roomId),
        eq(focusSessions.focusRunId, focusRunId),
        eq(focusSessions.status, 'in_progress'),
      ),
    )
    .returning({ id: focusSessions.id });
  return deleted.length > 0;
};

/** Whether the room exists and `userId` is a member of it (the host always is). */
export const isMemberOfRoom = async (
  db: Executor,
  roomId: string,
  userId: string,
): Promise<boolean> => {
  const [room] = await db
    .select({ hostId: rooms.hostId })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1);
  if (room === undefined) {
    return false;
  }
  if (room.hostId === userId) {
    return true;
  }
  const [row] = await db
    .select({ userId: roomMembers.userId })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)))
    .limit(1);
  return row !== undefined;
};

export type ProfileRow = {
  readonly id: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
};

export const findProfiles = async (
  db: Executor,
  userIds: readonly string[],
): Promise<ProfileRow[]> => {
  if (userIds.length === 0) {
    return [];
  }
  return db
    .select({ id: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl })
    .from(users)
    .where(inArray(users.id, [...userIds]));
};

/**
 * Locks the user's membership of the room `FOR SHARE` for the rest of the transaction (the
 * host's own membership is the room row), so a concurrent leave or removal - which deletes
 * the membership row - waits until the opt-in has committed and then abandons its session
 * (RF8, Rev I M2). `false` when the room or the membership is gone.
 */
export const lockMembershipForShare = async (
  tx: Tx,
  roomId: string,
  userId: string,
): Promise<boolean> => {
  const [room] = await tx
    .select({ hostId: rooms.hostId })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1)
    .for('share');
  if (room === undefined) {
    return false;
  }
  if (room.hostId === userId) {
    return true;
  }
  const [member] = await tx
    .select({ userId: roomMembers.userId })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)))
    .limit(1)
    .for('share');
  return member !== undefined;
};

export const findRoomSessionById = async (
  db: Executor,
  sessionId: string,
): Promise<FocusSessionRow | undefined> => {
  const [row] = await db
    .select()
    .from(focusSessions)
    .where(eq(focusSessions.id, sessionId))
    .limit(1);
  return row;
};

/** The user's in-progress session in the room, locked FOR UPDATE (a departure found late). */
export const findInProgressRoomSessionForUpdate = async (
  tx: Tx,
  userId: string,
  roomId: string,
): Promise<FocusSessionRow | undefined> => {
  const [row] = await tx
    .select()
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.userId, userId),
        eq(focusSessions.roomId, roomId),
        eq(focusSessions.status, 'in_progress'),
      ),
    )
    .limit(1)
    .for('update');
  return row;
};
