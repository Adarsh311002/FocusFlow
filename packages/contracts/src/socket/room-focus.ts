import { z } from 'zod';

import { checkInOutcomeSchema } from '../http/focus-sessions';
import { TASK_TITLE_MAX_LENGTH } from '../http/tasks';
import { focusRunIdSchema, focusSessionIdSchema, roomIdSchema, userIdSchema } from '../ids';

// Room focus runs (Phase 8; docs/architecture/focus-timing-protocol.md, "Focus runs"). A run
// is one instance of a room's focus phase; its participants live in Redis. Opting in is
// always explicit (D11): being present never makes anyone a participant.

const participantsVersionSchema = z.number().int().nonnegative();

/** One person who opted into the current run. Instants are Redis TIME in milliseconds. */
export const roomFocusParticipantSchema = z.object({
  userId: userIdSchema,
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  optedInAtMs: z.number().int().nonnegative(),
  /** False while the person's last socket is gone and the 60 s grace runs (D19). */
  connected: z.boolean(),
  /** Set while disconnected: the instant the grace period started (Redis TIME). */
  disconnectedAtMs: z.number().int().nonnegative().nullable(),
  /**
   * RI2: what the person is working on, when they chose to share it (RI1) and the task is
   * still theirs and not deleted; otherwise `null`. Read from PostgreSQL, never Redis (RF14).
   */
  intention: z.string().min(1).max(TASK_TITLE_MAX_LENGTH).nullable(),
});
export type RoomFocusParticipant = z.infer<typeof roomFocusParticipantSchema>;

/**
 * RI3: `room:focus:check-in`, sent to `room:{roomId}` when a participant of one of the room's
 * runs checks in. Carries the outcome only; the note stays private. A hint for the "who
 * finished" view of the page, never stored by the room.
 */
export const roomFocusCheckInEventSchema = z.object({
  roomId: roomIdSchema,
  focusRunId: focusRunIdSchema,
  userId: userIdSchema,
  outcome: checkInOutcomeSchema,
});
export type RoomFocusCheckInEvent = z.infer<typeof roomFocusCheckInEventSchema>;

/** The caller's own participation in the current run, or `null`. */
export const roomFocusMeSchema = z.object({
  participation: z
    .object({ sessionId: focusSessionIdSchema, focusRunId: focusRunIdSchema })
    .nullable(),
});
export type RoomFocusMe = z.infer<typeof roomFocusMeSchema>;

/**
 * Part of the join snapshot and of `GET /rooms/:roomId/focus-participation`. `focusRunId`
 * is `null` outside a focus phase (a break) and the list is then empty.
 */
export const roomFocusSnapshotSchema = z.object({
  focusRunId: focusRunIdSchema.nullable(),
  participants: z.array(roomFocusParticipantSchema),
  /** See `roomFocusParticipantsEventSchema.participantsVersion`; 0 outside a focus phase. */
  participantsVersion: participantsVersionSchema,
  me: roomFocusMeSchema,
});
export type RoomFocusSnapshot = z.infer<typeof roomFocusSnapshotSchema>;

/**
 * Sent to `room:{roomId}` whenever the participant list of the current run changes, and
 * when the run itself changes (a new run starts with an empty list). A hint: clients replace
 * their list with it, and heal a missed event from the next join snapshot or REST read.
 */
export const roomFocusParticipantsEventSchema = z.object({
  roomId: roomIdSchema,
  focusRunId: focusRunIdSchema.nullable(),
  participants: z.array(roomFocusParticipantSchema),
  /**
   * Server-owned counter of the run's participant list: it starts at 0 with the run and grows
   * by one with every change to the list or to a field shown in it. It orders states of the
   * SAME `focusRunId` only (run ids are never reused); a join snapshot is authoritative and
   * may carry a lower number after a Redis loss. 0 when `focusRunId` is `null`.
   */
  participantsVersion: participantsVersionSchema,
});
export type RoomFocusParticipantsEvent = z.infer<typeof roomFocusParticipantsEventSchema>;
