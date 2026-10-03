import { z } from 'zod';

import { errorCodeSchema } from '../errors';

/**
 * Every client → server event is answered through its acknowledgement, never with a
 * separate event (docs/api/socket-events.md): `{ ok: true, …result }` or
 * `{ ok: false, error: { code, message } }`. The error codes are the same closed union
 * REST uses.
 */
export const ackErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: errorCodeSchema, message: z.string() }),
});
export type AckError = z.infer<typeof ackErrorSchema>;

export type Ack<T extends object> = ({ ok: true } & T) | AckError;
