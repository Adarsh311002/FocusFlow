import { z } from 'zod';

import type { AuthSessionId, UserId } from '../ids';
import { type Ack, ackErrorSchema } from './ack';

// Typed Socket.IO events (docs/architecture/contracts.md, "Typed Socket.IO"). Phase 3 is
// infrastructure only: the one client event is the clock sync, and the server sends no
// product events yet (per-user events arrive with Phase 4). Names are `area:action`;
// payloads never carry identity; units are in the names (`…Ms`, `…AtMs`).

/** `time:sync` request: the client's send time, echoed back so it can measure the round trip. */
export const timeSyncRequestSchema = z.strictObject({
  clientSentAtMs: z.number().int().nonnegative(),
});
export type TimeSyncRequest = z.infer<typeof timeSyncRequestSchema>;

/** `time:sync` result: the server's authoritative time (Redis `TIME`), epoch milliseconds. */
export const timeSyncResultSchema = z.object({
  serverNowMs: z.number().int().nonnegative(),
});
export type TimeSyncResult = z.infer<typeof timeSyncResultSchema>;

/** The full `time:sync` acknowledgement, success or error (for client-side validation). */
export const timeSyncAckSchema = z.discriminatedUnion('ok', [
  timeSyncResultSchema.extend({ ok: z.literal(true) }),
  ackErrorSchema,
]);

export type ClientToServerEvents = {
  'time:sync': (request: TimeSyncRequest, ack: (response: Ack<TimeSyncResult>) => void) => void;
};

/**
 * No server → client product events in Phase 3. `Record<string, never>` rather than `{}`:
 * any event name type-checks, but its arguments are `never`, so nothing can be emitted.
 */
export type ServerToClientEvents = Record<string, never>;

export type InterServerEvents = Record<string, never>;

/**
 * Set only by the server's handshake middleware from the verified access token (F7).
 * Handlers read identity from here, never from payloads.
 */
export type SocketData = {
  userId: UserId;
  sid: AuthSessionId;
  displayName: string;
  avatarUrl: string | null;
  /** When the access token used for this connection expires; the server disconnects then. */
  tokenExpiresAtMs: number;
  /** Rooms joined through `room:join` (Phase 6); empty until then. */
  joinedRooms: string[];
};
