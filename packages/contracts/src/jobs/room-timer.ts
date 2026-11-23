import { z } from 'zod';

import { roomIdSchema } from '../ids';

// The `room-timer` queue (docs/architecture/focus-timing-protocol.md, "Reaching zero";
// Phase 7). A job carries IDs and the timer version it was scheduled for, never timer
// state: it re-reads the timer, and a job whose version is no longer current does nothing.

export const ROOM_TIMER_QUEUE = 'room-timer';

/** Move a running room timer to its next phase when it reaches zero. */
export const PHASE_END_JOB = 'phase-end';

export const phaseEndJobSchema = z.strictObject({
  schemaVersion: z.literal(1),
  roomId: roomIdSchema,
  /** The timer version whose end this job is for. */
  version: z.number().int().nonnegative(),
});
export type PhaseEndJob = z.infer<typeof phaseEndJobSchema>;

/** BullMQ job ids may not contain `:`; room ids are UUIDs, so this is safe (RT4). */
export const phaseEndJobId = (roomId: string, version: number): string =>
  `phase-end_${roomId}_${String(version)}`;
