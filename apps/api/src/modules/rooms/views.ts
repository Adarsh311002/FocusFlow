import type {
  RoomMembershipView,
  RoomMemberView,
  RoomPreview,
  RoomTimerSettings,
  RoomView,
} from '@focus-flow/contracts';
import { roomCodeSchema, roomIdSchema, userIdSchema } from '@focus-flow/contracts';

import type { MemberRow, RoomRow } from './queries.js';

// Rows to contract views. Persistence types never leave this module; ids and codes are
// re-branded through the contract schemas, so a malformed stored value is a server bug.

export const toTimerSettings = (row: RoomRow): RoomTimerSettings => ({
  focusSeconds: row.focusSeconds,
  shortBreakSeconds: row.shortBreakSeconds,
  longBreakSeconds: row.longBreakSeconds,
});

export const toRoomPreview = (row: RoomRow): RoomPreview => ({
  id: roomIdSchema.parse(row.id),
  code: roomCodeSchema.parse(row.code),
  name: row.name,
  isPrivate: row.isPrivate,
});

export const toRoomView = (row: RoomRow): RoomView => ({
  ...toRoomPreview(row),
  hostId: userIdSchema.parse(row.hostId),
  timerSettings: toTimerSettings(row),
  createdAt: row.createdAt.toISOString(),
});

export const toMemberView = (row: MemberRow, hostId: string): RoomMemberView => ({
  userId: userIdSchema.parse(row.userId),
  displayName: row.displayName,
  avatarUrl: row.avatarUrl,
  joinedAt: row.joinedAt.toISOString(),
  isHost: row.userId === hostId,
});

export const toMembershipView = (
  roomId: string,
  userId: string,
  joinedAt: Date,
): RoomMembershipView => ({
  roomId: roomIdSchema.parse(roomId),
  userId: userIdSchema.parse(userId),
  joinedAt: joinedAt.toISOString(),
});
