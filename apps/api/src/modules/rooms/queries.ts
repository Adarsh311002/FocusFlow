import { and, asc, desc, eq, sql } from 'drizzle-orm';

import type { Executor } from '../../db/client.js';
import { roomMembers, rooms, users } from '../../db/schema.js';

export type RoomRow = typeof rooms.$inferSelect;

export type MemberRow = {
  readonly userId: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly joinedAt: Date;
};

export type NewRoom = {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly hostId: string;
  readonly isPrivate: boolean;
  readonly focusSeconds: number;
  readonly shortBreakSeconds: number;
  readonly longBreakSeconds: number;
};

export const insertRoom = async (db: Executor, values: NewRoom): Promise<RoomRow> => {
  const [row] = await db.insert(rooms).values(values).returning();
  if (row === undefined) {
    throw new Error('insertRoom: insert returned no row');
  }
  return row;
};

export const findRoomById = async (db: Executor, roomId: string): Promise<RoomRow | undefined> => {
  const [row] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
  return row;
};

export const findRoomByCode = async (db: Executor, code: string): Promise<RoomRow | undefined> => {
  const [row] = await db.select().from(rooms).where(eq(rooms.code, code)).limit(1);
  return row;
};

/** The membership's join time, or `undefined` when the user is not a member. */
export const findMembershipJoinedAt = async (
  db: Executor,
  roomId: string,
  userId: string,
): Promise<Date | undefined> => {
  const [row] = await db
    .select({ joinedAt: roomMembers.joinedAt })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)))
    .limit(1);
  return row?.joinedAt;
};

/**
 * Adds the membership unless it exists. Returns the inserted row's join time, or
 * `undefined` when a row already existed (including one inserted by a concurrent call),
 * so exactly one caller sees "created".
 */
export const insertMembershipIfAbsent = async (
  db: Executor,
  roomId: string,
  userId: string,
): Promise<Date | undefined> => {
  const [row] = await db
    .insert(roomMembers)
    .values({ roomId, userId })
    .onConflictDoNothing({ target: [roomMembers.roomId, roomMembers.userId] })
    .returning({ joinedAt: roomMembers.joinedAt });
  return row?.joinedAt;
};

/** True when a row was deleted. */
export const deleteMembership = async (
  db: Executor,
  roomId: string,
  userId: string,
): Promise<boolean> => {
  const deleted = await db
    .delete(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)))
    .returning({ userId: roomMembers.userId });
  return deleted.length > 0;
};

/** The user's rooms, most recently joined first (`ix_room_members_user_id_joined_at`). */
export const listRoomsOfMember = (db: Executor, userId: string): Promise<RoomRow[]> =>
  db
    .select({ room: rooms })
    .from(roomMembers)
    .innerJoin(rooms, eq(rooms.id, roomMembers.roomId))
    .where(eq(roomMembers.userId, userId))
    .orderBy(desc(roomMembers.joinedAt), desc(rooms.id))
    .then((rows) => rows.map((row) => row.room));

export const listMembers = (db: Executor, roomId: string): Promise<MemberRow[]> =>
  db
    .select({
      userId: roomMembers.userId,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      joinedAt: roomMembers.joinedAt,
    })
    .from(roomMembers)
    .innerJoin(users, eq(users.id, roomMembers.userId))
    .where(eq(roomMembers.roomId, roomId))
    .orderBy(asc(roomMembers.joinedAt), asc(roomMembers.userId));

export const updateRoomSettings = async (
  db: Executor,
  roomId: string,
  values: {
    readonly focusSeconds?: number | undefined;
    readonly shortBreakSeconds?: number | undefined;
    readonly longBreakSeconds?: number | undefined;
  },
): Promise<RoomRow | undefined> => {
  const [row] = await db
    .update(rooms)
    .set({
      ...(values.focusSeconds === undefined ? {} : { focusSeconds: values.focusSeconds }),
      ...(values.shortBreakSeconds === undefined
        ? {}
        : { shortBreakSeconds: values.shortBreakSeconds }),
      ...(values.longBreakSeconds === undefined
        ? {}
        : { longBreakSeconds: values.longBreakSeconds }),
    })
    .where(eq(rooms.id, roomId))
    .returning();
  return row;
};

export const userExists = async (db: Executor, userId: string): Promise<boolean> => {
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row !== undefined;
};

export const findMember = async (
  db: Executor,
  roomId: string,
  userId: string,
): Promise<MemberRow | undefined> => {
  const [row] = await db
    .select({
      userId: roomMembers.userId,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      joinedAt: roomMembers.joinedAt,
    })
    .from(roomMembers)
    .innerJoin(users, eq(users.id, roomMembers.userId))
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)))
    .limit(1);
  return row;
};
