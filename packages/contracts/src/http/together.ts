import { z } from 'zod';

import { calendarDateSchema, timeZoneSchema } from '../dates';
import { roomIdSchema, userIdSchema } from '../ids';
import { avatarPresetSchema } from './user';

// Focusing with others (Wave 4, docs/decisions/decision-log.md): focus buddies (BD1–BD5),
// scheduled room sessions (SC1–SC4) and the room's weekly recap (RR1–RR3). Inbound schemas
// are strict.

// ---- Buddies -------------------------------------------------------------------------

/** BD1: a buddy code is 8 characters from the room-code alphabet (no 0/O, 1/I/L). */
export const BUDDY_CODE_LENGTH = 8;
export const BUDDIES_MAX = 50;

export const buddyCodeSchema = z
  .string()
  .trim()
  .transform((code) => code.toUpperCase().replace(/\s+/g, ''))
  .pipe(z.string().regex(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/));

/** BD2: what a buddy shares: never tasks, notes or check-ins. */
export const buddyViewSchema = z.object({
  userId: userIdSchema,
  displayName: z.string().min(1).max(50),
  avatarPreset: avatarPresetSchema.nullable(),
  /** A session of theirs is in progress right now. */
  focusingNow: z.boolean(),
  currentStreak: z.number().int().nonnegative(),
  /** Focus over the last 7 days (ended sessions), seconds. */
  weekFocusedSeconds: z.number().int().nonnegative(),
});
export type BuddyView = z.infer<typeof buddyViewSchema>;

export const buddyRequestViewSchema = z.object({
  userId: userIdSchema,
  displayName: z.string().min(1).max(50),
  avatarPreset: avatarPresetSchema.nullable(),
  requestedAt: z.iso.datetime(),
});
export type BuddyRequestView = z.infer<typeof buddyRequestViewSchema>;

/** `GET /buddies?tz=`. */
export const buddiesResponseSchema = z.object({
  /** Your own code, for others to enter. */
  code: z.string().length(BUDDY_CODE_LENGTH),
  buddies: z.array(buddyViewSchema),
  /** Requests waiting for your answer. */
  incoming: z.array(buddyRequestViewSchema),
  /** Requests you sent that are not answered yet. */
  outgoing: z.array(buddyRequestViewSchema),
});
export type BuddiesResponse = z.infer<typeof buddiesResponseSchema>;

export const buddiesQuerySchema = z.strictObject({ tz: timeZoneSchema });
export const buddyRequestSchema = z.strictObject({ code: buddyCodeSchema });
export const buddyParamsSchema = z.strictObject({ userId: userIdSchema });

/** `POST /buddies`: a request sent, or (when they had already asked you) a buddy made. */
export const buddyRequestResponseSchema = z.object({
  status: z.enum(['requested', 'buddies']),
});

/** BD4: `buddy:nudge` to the nudged user's tabs. */
export const buddyNudgeEventSchema = z.object({
  fromUserId: userIdSchema,
  displayName: z.string().min(1).max(50),
});
export type BuddyNudgeEvent = z.infer<typeof buddyNudgeEventSchema>;

// ---- Scheduled room sessions --------------------------------------------------------------

export const ROOM_SCHEDULES_MAX = 20;
export const ROOM_SCHEDULE_TITLE_MAX_LENGTH = 60;

export const roomScheduleViewSchema = z.object({
  id: z.uuid(),
  roomId: roomIdSchema,
  title: z.string().min(1).max(ROOM_SCHEDULE_TITLE_MAX_LENGTH),
  /** The first (or only) start. */
  startsAt: z.iso.datetime(),
  durationMinutes: z.number().int().min(5).max(240),
  repeatsWeekly: z.boolean(),
  /** SC2: the next start that has not ended yet; `null` for a one-off that is over. */
  nextStartsAt: z.iso.datetime().nullable(),
});
export type RoomScheduleView = z.infer<typeof roomScheduleViewSchema>;

export const roomSchedulesResponseSchema = z.object({
  schedules: z.array(roomScheduleViewSchema).max(ROOM_SCHEDULES_MAX),
});

export const createRoomScheduleRequestSchema = z.strictObject({
  title: z.string().trim().min(1).max(ROOM_SCHEDULE_TITLE_MAX_LENGTH),
  /** An instant with an offset; must be in the future. */
  startsAt: z.iso.datetime({ offset: true }),
  durationMinutes: z.number().int().min(5).max(240),
  repeatsWeekly: z.boolean().default(false),
});
export type CreateRoomScheduleRequest = z.input<typeof createRoomScheduleRequestSchema>;

export const roomScheduleParamsSchema = z.strictObject({
  roomId: roomIdSchema,
  scheduleId: z.uuid(),
});

export const roomScheduleResponseSchema = z.object({ schedule: roomScheduleViewSchema });

/** SC3: `GET /me/upcoming-sessions`: the next 24 hours across every room the user is in. */
export const upcomingSessionSchema = z.object({
  scheduleId: z.uuid(),
  roomId: roomIdSchema,
  roomName: z.string().min(1),
  title: z.string().min(1),
  startsAt: z.iso.datetime(),
  durationMinutes: z.number().int(),
});
export type UpcomingSession = z.infer<typeof upcomingSessionSchema>;
export const upcomingSessionsResponseSchema = z.object({
  sessions: z.array(upcomingSessionSchema),
});

// ---- Room recap ------------------------------------------------------------------------

/** RR1: `GET /rooms/:roomId/recap?tz=`: the last 7 local days (today included). */
export const roomRecapResponseSchema = z.object({
  from: calendarDateSchema,
  to: calendarDateSchema,
  totals: z.object({
    focusedSeconds: z.number().int().nonnegative(),
    completedSessions: z.number().int().nonnegative(),
    intentionsDone: z.number().int().nonnegative(),
  }),
  /** RR2: consecutive local days, up to today, with a completed session in this room. */
  roomStreak: z.number().int().nonnegative(),
  /** Who focused here, most focused time first (current members only). */
  people: z.array(
    z.object({
      userId: userIdSchema,
      displayName: z.string().min(1).max(50),
      avatarPreset: avatarPresetSchema.nullable(),
      focusedSeconds: z.number().int().nonnegative(),
      completedSessions: z.number().int().nonnegative(),
    }),
  ),
});
export type RoomRecapResponse = z.infer<typeof roomRecapResponseSchema>;

export const roomRecapQuerySchema = z.strictObject({ tz: timeZoneSchema });
