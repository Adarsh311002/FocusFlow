import { and, eq, inArray } from 'drizzle-orm';

import type { Db } from '../../db/client.js';
import { roomMembers, rooms, users } from '../../db/schema.js';

// The few PostgreSQL reads the realtime side needs. Writes (rooms, memberships) belong to
// the REST module; the socket handlers only ever read.

export type RoomRow = typeof rooms.$inferSelect;

export const findRoom = async (db: Db, roomId: string): Promise<RoomRow | undefined> => {
  const [row] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
  return row;
};

export const isRoomMember = async (db: Db, roomId: string, userId: string): Promise<boolean> => {
  const rows = await db
    .select({ userId: roomMembers.userId })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)))
    .limit(1);
  return rows.length > 0;
};

/** The room, only when `userId` is a member of it (the host included). */
export const findRoomForMember = async (
  db: Db,
  roomId: string,
  userId: string,
): Promise<RoomRow | undefined> => {
  const [row] = await db
    .select({ room: rooms })
    .from(rooms)
    .innerJoin(roomMembers, and(eq(roomMembers.roomId, rooms.id), eq(roomMembers.userId, userId)))
    .where(eq(rooms.id, roomId))
    .limit(1);
  return row?.room;
};

export type UserProfileRow = {
  readonly id: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
};

export const findUserProfiles = async (
  db: Db,
  userIds: readonly string[],
): Promise<UserProfileRow[]> =>
  userIds.length === 0
    ? []
    : db
        .select({ id: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl })
        .from(users)
        .where(inArray(users.id, [...userIds]));

/**
 * Which of the given (room, user) pairs are still memberships: one query (the rooms and
 * users are matched as sets, then the pairs filtered), used by the heartbeat sync (F1).
 */
export const findMemberPairs = async (
  db: Db,
  pairs: readonly { readonly roomId: string; readonly userId: string }[],
): Promise<Set<string>> => {
  if (pairs.length === 0) {
    return new Set();
  }
  const rows = await db
    .select({ roomId: roomMembers.roomId, userId: roomMembers.userId })
    .from(roomMembers)
    .where(
      and(
        inArray(roomMembers.roomId, [...new Set(pairs.map(({ roomId }) => roomId))]),
        inArray(roomMembers.userId, [...new Set(pairs.map(({ userId }) => userId))]),
      ),
    );
  return new Set(rows.map(({ roomId, userId }) => `${roomId}:${userId}`));
};
