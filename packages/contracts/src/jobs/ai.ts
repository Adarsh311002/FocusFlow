import { z } from 'zod';

// The `ai` queue (Wave 5, AI3). A job carries only the `ai_jobs` row id: the worker reads the
// row, builds the context from PostgreSQL and writes the outcome back to the row.

export const AI_QUEUE = 'ai';
export const AI_RUN_JOB = 'ai-run';

export const aiRunJobSchema = z.strictObject({
  schemaVersion: z.literal(1),
  jobId: z.uuid(),
});
export type AiRunJob = z.infer<typeof aiRunJobSchema>;

/** BullMQ job ids may not contain `:`. */
export const aiRunJobId = (jobId: string): string => `ai_${jobId}`;
