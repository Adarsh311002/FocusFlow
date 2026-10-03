import { z } from 'zod';

// Queue job payloads carry IDs and options, never bulk data, and a `schemaVersion` so a
// worker can refuse a payload it does not understand (docs/architecture/contracts.md,
// "Future: Node ↔ Python contracts").

export const MAINTENANCE_QUEUE = 'maintenance';
export const RECONCILE_JOB = 'reconcile';

/** Why a reconcile run was queued; logged with the run. */
export const reconcileTriggerSchema = z.enum(['schedule', 'startup', 'recovery']);
export type ReconcileTrigger = z.infer<typeof reconcileTriggerSchema>;

export const reconcileJobSchema = z.strictObject({
  schemaVersion: z.literal(1),
  trigger: reconcileTriggerSchema,
  correlationId: z.string().min(1).max(100),
});
export type ReconcileJob = z.infer<typeof reconcileJobSchema>;
