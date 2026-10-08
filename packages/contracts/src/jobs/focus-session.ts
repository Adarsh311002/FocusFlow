import { z } from 'zod';

import { focusSessionIdSchema, userIdSchema } from '../ids';

// The `focus-session` queue (docs/architecture/focus-timing-protocol.md, "Scheduled jobs";
// Phase 4B). Payloads carry IDs and the instant the job is about, never session state: a
// job always re-reads the session under its row lock, and an outdated job does nothing.

export const FOCUS_SESSION_QUEUE = 'focus-session';

/** Decide a running solo session at its planned end (`T_end`). */
export const SOLO_END_JOB = 'solo-end';

/** Settle a running solo session's reconnect grace. */
export const SOLO_GRACE_JOB = 'solo-grace';

const instantMs = z.number().int().nonnegative();

/** Keyed by `running_since`: a pause or resume makes the job outdated. */
export const soloEndJobSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sessionId: focusSessionIdSchema,
  userId: userIdSchema,
  /** The running stretch this job belongs to (PostgreSQL clock, ms). */
  runningSinceMs: instantMs,
});
export type SoloEndJob = z.infer<typeof soloEndJobSchema>;

/** Keyed by the disconnect: it settles only while the marker still holds exactly this one. */
export const soloGraceJobSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sessionId: focusSessionIdSchema,
  userId: userIdSchema,
  /** The marker's disconnect instant (Redis TIME, ms). */
  disconnectedAtMs: instantMs,
});
export type SoloGraceJob = z.infer<typeof soloGraceJobSchema>;
