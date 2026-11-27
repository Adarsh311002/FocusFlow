import {
  addCalendarDays,
  type CreateRoomScheduleRequest,
  ROOM_SCHEDULES_MAX,
  type RoomRecapResponse,
  roomRecapResponseSchema,
  type RoomScheduleView,
  roomScheduleViewSchema,
  type UpcomingSession,
  upcomingSessionSchema,
} from '@focus-flow/contracts';
import { and, asc, count, eq, gte, inArray, isNotNull, ne, or } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import type { Db, Executor } from '../../db/client.js';
import { focusSessions, roomMembers, rooms, roomSchedules, users } from '../../db/schema.js';
import { AppError } from '../../platform/http/errors.js';
import { computeStreak, createLocalMomentFormatter } from '../focus-sessions/insights.js';

// Scheduled room sessions (SC1–SC3) and the room's weekly recap (RR1–RR2). Members only,
// with the rooms' own answers: a non-member or unknown room is 404 ROOM_NOT_FOUND (M4),
// a member who is not the host gets 403 NOT_HOST for host-only writes.

export type RoomsTogetherDeps = { readonly db: Db; readonly nowMs?: () => number };

const WEEK_MS = 7 * 86_400_000;

const roomNotFound = () => new AppError('ROOM_NOT_FOUND', 404, 'Room not found.');

/** The room's host id, when the user is its host or a member; otherwise 404. */
const requireMember = async (db: Executor, userId: string, roomId: string): Promise<string> => {
  const [room] = await db
    .select({ hostId: rooms.hostId })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1);
  if (room === undefined) {
    throw roomNotFound();
  }
  if (room.hostId === userId) {
    return room.hostId;
  }
  const [member] = await db
    .select({ userId: roomMembers.userId })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)))
    .limit(1);
  if (member === undefined) {
    throw roomNotFound();
  }
  return room.hostId;
};

type ScheduleRow = typeof roomSchedules.$inferSelect;

/** SC2: the next start whose session has not ended by `nowMs`; weekly ones repeat. */
export const nextStartOf = (row: ScheduleRow, nowMs: number): number | null => {
  const start = row.startsAt.getTime();
  const length = row.durationMinutes * 60_000;
  if (start + length > nowMs) {
    return start;
  }
  if (!row.repeatsWeekly) {
    return null;
  }
  const weeks = Math.ceil((nowMs - length - start) / WEEK_MS);
  const next = start + weeks * WEEK_MS;
  return next + length > nowMs ? next : next + WEEK_MS;
};

const toScheduleView = (row: ScheduleRow, nowMs: number): RoomScheduleView => {
  const next = nextStartOf(row, nowMs);
  return roomScheduleViewSchema.parse({
    id: row.id,
    roomId: row.roomId,
    title: row.title,
    startsAt: row.startsAt.toISOString(),
    durationMinutes: row.durationMinutes,
    repeatsWeekly: row.repeatsWeekly,
    nextStartsAt: next === null ? null : new Date(next).toISOString(),
  });
};

/** Upcoming first; finished one-offs last. */
export const listSchedules = async (
  deps: RoomsTogetherDeps,
  userId: string,
  roomId: string,
): Promise<RoomScheduleView[]> => {
  await requireMember(deps.db, userId, roomId);
  const nowMs = (deps.nowMs ?? Date.now)();
  const rows = await deps.db
    .select()
    .from(roomSchedules)
    .where(eq(roomSchedules.roomId, roomId))
    .orderBy(asc(roomSchedules.startsAt));
  return rows
    .map((row) => toScheduleView(row, nowMs))
    .sort(
      (a, b) =>
        (a.nextStartsAt === null ? Infinity : Date.parse(a.nextStartsAt)) -
        (b.nextStartsAt === null ? Infinity : Date.parse(b.nextStartsAt)),
    );
};

/** SC2: host only; the start must be in the future; at most ROOM_SCHEDULES_MAX per room. */
export const createSchedule = (
  deps: RoomsTogetherDeps,
  userId: string,
  roomId: string,
  input: Required<Pick<CreateRoomScheduleRequest, 'title' | 'startsAt' | 'durationMinutes'>> & {
    readonly repeatsWeekly: boolean;
  },
): Promise<RoomScheduleView> =>
  deps.db.transaction(async (tx) => {
    const hostId = await requireMember(tx, userId, roomId);
    if (hostId !== userId) {
      throw new AppError('NOT_HOST', 403, 'Only the host can schedule sessions.');
    }
    const nowMs = (deps.nowMs ?? Date.now)();
    const startsAt = new Date(input.startsAt);
    if (startsAt.getTime() <= nowMs) {
      throw new AppError('VALIDATION_FAILED', 400, 'Schedule a time in the future.');
    }
    await tx.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, roomId)).for('update');
    const [held] = await tx
      .select({ total: count() })
      .from(roomSchedules)
      .where(eq(roomSchedules.roomId, roomId));
    if ((held?.total ?? 0) >= ROOM_SCHEDULES_MAX) {
      throw new AppError('SCHEDULES_FULL', 409, 'A room can hold 20 scheduled sessions.');
    }
    const [row] = await tx
      .insert(roomSchedules)
      .values({
        id: uuidv7(),
        roomId,
        createdBy: userId,
        title: input.title,
        startsAt,
        durationMinutes: input.durationMinutes,
        repeatsWeekly: input.repeatsWeekly,
      })
      .returning();
    if (row === undefined) {
      throw new Error('createSchedule: insert returned no row');
    }
    return toScheduleView(row, nowMs);
  });

/** SC2: host only; an unknown schedule of the room is 404 NOT_FOUND. */
export const deleteSchedule = async (
  deps: RoomsTogetherDeps,
  userId: string,
  roomId: string,
  scheduleId: string,
): Promise<void> => {
  const hostId = await requireMember(deps.db, userId, roomId);
  if (hostId !== userId) {
    throw new AppError('NOT_HOST', 403, 'Only the host can remove scheduled sessions.');
  }
  const removed = await deps.db
    .delete(roomSchedules)
    .where(and(eq(roomSchedules.id, scheduleId), eq(roomSchedules.roomId, roomId)))
    .returning({ id: roomSchedules.id });
  if (removed.length === 0) {
    throw new AppError('NOT_FOUND', 404, 'Scheduled session not found.');
  }
};

/** SC3: what starts (or is under way) in the next 24 hours, across the user's rooms. */
export const upcomingSessions = async (
  deps: RoomsTogetherDeps,
  userId: string,
): Promise<UpcomingSession[]> => {
  const memberOf = await deps.db
    .select({ roomId: roomMembers.roomId })
    .from(roomMembers)
    .where(eq(roomMembers.userId, userId));
  const hosted = await deps.db
    .select({ roomId: rooms.id })
    .from(rooms)
    .where(eq(rooms.hostId, userId));
  const roomIds = [...new Set([...memberOf, ...hosted].map((row) => row.roomId))];
  if (roomIds.length === 0) {
    return [];
  }
  const nowMs = (deps.nowMs ?? Date.now)();
  const rows = await deps.db
    .select({ schedule: roomSchedules, roomName: rooms.name })
    .from(roomSchedules)
    .innerJoin(rooms, eq(rooms.id, roomSchedules.roomId))
    .where(inArray(roomSchedules.roomId, roomIds));
  return rows
    .flatMap(({ schedule, roomName }) => {
      const next = nextStartOf(schedule, nowMs);
      return next === null || next > nowMs + 86_400_000
        ? []
        : [
            upcomingSessionSchema.parse({
              scheduleId: schedule.id,
              roomId: schedule.roomId,
              roomName,
              title: schedule.title,
              startsAt: new Date(next).toISOString(),
              durationMinutes: schedule.durationMinutes,
            }),
          ];
    })
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
};

/** RR1–RR2: the room's last 7 local days, and its streak, for current members. */
export const roomRecap = async (
  deps: RoomsTogetherDeps,
  userId: string,
  roomId: string,
  tz: string,
): Promise<RoomRecapResponse> => {
  const hostId = await requireMember(deps.db, userId, roomId);
  const nowMs = (deps.nowMs ?? Date.now)();
  const localDate = (ms: number) => createLocalMomentFormatter(tz)(ms).date;
  const today = localDate(nowMs);
  const from = addCalendarDays(today, -6);
  const members = await deps.db
    .select({ userId: roomMembers.userId })
    .from(roomMembers)
    .where(eq(roomMembers.roomId, roomId));
  const memberIds = [...new Set([hostId, ...members.map((row) => row.userId)])];
  // A year of the room's ended sessions covers the streak; the week is filtered below.
  const sessions = await deps.db
    .select({
      userId: focusSessions.userId,
      startedAt: focusSessions.startedAt,
      status: focusSessions.status,
      focusedSeconds: focusSessions.focusedSeconds,
      outcome: focusSessions.checkInOutcome,
    })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.roomId, roomId),
        ne(focusSessions.status, 'in_progress'),
        isNotNull(focusSessions.endedAt),
        gte(focusSessions.startedAt, new Date(nowMs - 400 * 86_400_000)),
      ),
    );
  const week = sessions.filter((row) => localDate(row.startedAt.getTime()) >= from);
  const profiles = await deps.db
    .select({ id: users.id, displayName: users.displayName, avatarPreset: users.avatarPreset })
    .from(users)
    .where(or(inArray(users.id, memberIds)));
  const people = profiles
    .map((person) => {
      const theirs = week.filter((row) => row.userId === person.id);
      return {
        userId: person.id,
        displayName: person.displayName,
        avatarPreset: person.avatarPreset,
        focusedSeconds: theirs.reduce((sum, row) => sum + row.focusedSeconds, 0),
        completedSessions: theirs.filter((row) => row.status === 'completed').length,
      };
    })
    .filter((person) => person.focusedSeconds > 0)
    .sort(
      (a, b) => b.focusedSeconds - a.focusedSeconds || a.displayName.localeCompare(b.displayName),
    );
  const completedDays = new Set(
    sessions
      .filter((row) => row.status === 'completed')
      .map((row) => localDate(row.startedAt.getTime())),
  );
  return roomRecapResponseSchema.parse({
    from,
    to: today,
    totals: {
      focusedSeconds: week.reduce((sum, row) => sum + row.focusedSeconds, 0),
      completedSessions: week.filter((row) => row.status === 'completed').length,
      intentionsDone: week.filter((row) => row.outcome === 'done').length,
    },
    roomStreak: computeStreak(completedDays, today).current,
    people,
  });
};
