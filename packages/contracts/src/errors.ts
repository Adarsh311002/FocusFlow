import { z } from 'zod';

/**
 * Closed union of error codes shared by REST responses and socket acknowledgements.
 * Phase 0 defines only the codes the foundation itself can produce; later phases add
 * their own (docs/architecture/contracts.md).
 */
export const errorCodes = ['VALIDATION_FAILED', 'NOT_FOUND', 'INTERNAL'] as const;

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
