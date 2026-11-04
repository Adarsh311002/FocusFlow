import { z } from 'zod';

/**
 * Closed union of error codes shared by REST responses and socket acknowledgements.
 * Phase 0 defines only the codes the foundation itself can produce; later phases add
 * their own (docs/architecture/contracts.md).
 */
export const errorCodes = [
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'INTERNAL',
  // Auth (Phase 1, docs/architecture/auth.md)
  'EMAIL_TAKEN',
  'INVALID_CREDENTIALS',
  'UNAUTHENTICATED',
  'SESSION_INVALID',
  'SESSION_REVOKED',
  // Tasks (Phase 2, docs/api/rest.md)
  'TASK_NOT_FOUND',
  'TASK_NOT_OPEN',
  // Focus sessions (Phase 4B, docs/api/rest.md)
  'SESSION_IN_PROGRESS',
  'NOT_CONNECTED',
  // Rooms (Phase 6, docs/api/rest.md and docs/api/socket-events.md)
  'ROOM_NOT_FOUND',
  'NOT_A_MEMBER',
  'NOT_JOINED',
  'NOT_HOST',
  'HOST_CANNOT_LEAVE',
  'CANNOT_REMOVE_HOST',
  'KNOCK_REQUIRED',
  'KNOCK_EXPIRED',
  'NOT_PRIVATE',
  'ALREADY_MEMBER',
  'HOST_OFFLINE',
  'ROOM_FULL',
  'RATE_LIMITED',
  // Room timer (Phase 7, docs/api/socket-events.md)
  'VERSION_CONFLICT',
  'INVALID_TRANSITION',
] as const;

export const errorCodeSchema = z.enum(errorCodes);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const errorBodySchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorBody = z.infer<typeof errorBodySchema>;
