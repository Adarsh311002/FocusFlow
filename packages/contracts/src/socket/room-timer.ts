import { z } from 'zod';

import { roomIdSchema } from '../ids';

// The shared room timer (Phase 7; docs/architecture/focus-timing-protocol.md, "Room timer";
// docs/api/socket-events.md). The server owns the state; every instant is Redis TIME in
// epoch milliseconds. Clients only display it: they never decide that a phase has ended.

export const timerPhaseSchema = z.enum(['focus', 'short_break', 'long_break']);
export type TimerPhase = z.infer<typeof timerPhaseSchema>;

export const timerStatusSchema = z.enum(['idle', 'running', 'paused']);
export type TimerStatus = z.infer<typeof timerStatusSchema>;

const nonNegativeInt = z.number().int().nonnegative();

/**
 * The timer as clients see it. `version` is bumped on every accepted change; clients ignore
 * a state older than the one they hold, except that a join snapshot replaces everything (RT2).
 * Remaining time: `running` → `endsAtMs − now`; otherwise `durationMs − elapsedBeforeMs`.
 */
export const timerViewSchema = z.object({
  roomId: roomIdSchema,
  phase: timerPhaseSchema,
  status: timerStatusSchema,
  /** Length of this phase, fixed from the room's settings when the phase was created (D16). */
  durationMs: nonNegativeInt,
  /** Time elapsed before the current running stretch. */
  elapsedBeforeMs: nonNegativeInt,
  /** Running only: when the current stretch began (Redis TIME). */
  segmentStartedAtMs: nonNegativeInt.nullable(),
  /** Running only: when the phase reaches zero. */
  endsAtMs: nonNegativeInt.nullable(),
  version: nonNegativeInt,
});
export type TimerView = z.infer<typeof timerViewSchema>;

// ---- Commands (host only) -------------------------------------------------------------

export const timerCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('start') }),
  z.strictObject({ type: z.literal('pause') }),
  z.strictObject({ type: z.literal('resume') }),
  z.strictObject({ type: z.literal('reset'), expectedVersion: nonNegativeInt }),
  z.strictObject({
    type: z.literal('setPhase'),
    phase: timerPhaseSchema,
    expectedVersion: nonNegativeInt,
  }),
]);
export type TimerCommand = z.infer<typeof timerCommandSchema>;

/** `room:timer:command`. The host is the caller; identity comes from the handshake. */
export const roomTimerCommandRequestSchema = z.strictObject({
  roomId: roomIdSchema,
  command: timerCommandSchema,
});
export type RoomTimerCommandRequest = z.infer<typeof roomTimerCommandRequestSchema>;

/** The acknowledgement of an accepted command (also a repeated pause or resume: a no-op). */
export const roomTimerCommandResultSchema = z.object({
  timer: timerViewSchema,
  serverNowMs: nonNegativeInt,
});
export type RoomTimerCommandResult = z.infer<typeof roomTimerCommandResultSchema>;

/**
 * Carried in `error.details` of a `VERSION_CONFLICT` or `INVALID_TRANSITION` acknowledgement
 * so a stale client can catch up without another round trip (RT6).
 */
export const roomTimerRejectionDetailsSchema = z.object({
  timer: timerViewSchema,
  serverNowMs: nonNegativeInt,
});
export type RoomTimerRejectionDetails = z.infer<typeof roomTimerRejectionDetailsSchema>;

// ---- Server → client ------------------------------------------------------------------

/** Sent to `room:{roomId}` after every committed change (command or automatic phase end). */
export const roomTimerStateEventSchema = z.object({
  roomId: roomIdSchema,
  timer: timerViewSchema,
  serverNowMs: nonNegativeInt,
});
export type RoomTimerStateEvent = z.infer<typeof roomTimerStateEventSchema>;
