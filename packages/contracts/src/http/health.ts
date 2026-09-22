import { z } from 'zod';

/**
 * Health checks are split (decision P2):
 * - liveness  GET /api/v1/healthz : the process is running; never checks dependencies.
 * - readiness GET /api/v1/readyz  : required dependencies are reachable; 503 when not.
 */
export const livenessResponseSchema = z.object({
  status: z.literal('ok'),
});
export type LivenessResponse = z.infer<typeof livenessResponseSchema>;

export const dependencyStatusSchema = z.enum(['ok', 'unavailable']);
export type DependencyStatus = z.infer<typeof dependencyStatusSchema>;

export const readinessChecksSchema = z.object({
  postgres: dependencyStatusSchema,
  redis: dependencyStatusSchema,
});
export type ReadinessChecks = z.infer<typeof readinessChecksSchema>;

export const readinessResponseSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  checks: readinessChecksSchema,
});
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
