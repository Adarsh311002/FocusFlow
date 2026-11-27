import {
  AI_QUEUE,
  AI_RUN_JOB,
  type AiRunJob,
  aiRunJobId,
  aiRunJobSchema,
} from '@focus-flow/contracts';
import { type Job, Queue, UnrecoverableError, Worker } from 'bullmq';
import type { Redis } from 'ioredis';

import type { AppConfig } from '../../platform/config.js';
import { bullmqPrefix } from '../../platform/queues.js';
import { type EnsurableQueue, ensureJob } from '../focus-sessions/jobs.js';
import { AiRetryLater, type AiRunDeps, markAiJobFailed, runAiJob } from './service.js';

// The `ai` queue (AI3): one job per `ai_jobs` row, id `ai_{rowId}`, ensured with the E20
// semantics. The row, not the job, is the record; a job only wakes the worker.

export type AiQueue = Queue<AiRunJob>;

const ATTEMPTS = 3;

export const createAiQueue = (connection: Redis, config: AppConfig): AiQueue =>
  new Queue<AiRunJob>(AI_QUEUE, {
    connection,
    prefix: bullmqPrefix(config),
    defaultJobOptions: {
      attempts: ATTEMPTS,
      backoff: { type: 'exponential', delay: 3_000 },
      removeOnComplete: 1_000,
      removeOnFail: 1_000,
    },
  });

export type AiSchedulableQueue = EnsurableQueue & {
  readonly add: (name: string, data: AiRunJob, options: { jobId: string }) => Promise<unknown>;
};

export const createAiScheduler =
  (queue: AiSchedulableQueue) =>
  (jobId: string): Promise<unknown> => {
    const payload = aiRunJobSchema.parse({ schemaVersion: 1, jobId });
    const id = aiRunJobId(jobId);
    return ensureJob(queue, id, () => queue.add(AI_RUN_JOB, payload, { jobId: id }));
  };

/** Validates and runs one job; a final failure of any kind fails the row (never stuck). */
export const processAiJob = async (
  deps: AiRunDeps,
  job: Pick<Job<AiRunJob>, 'name' | 'data' | 'attemptsMade' | 'opts'>,
): Promise<string> => {
  if (job.name !== AI_RUN_JOB) {
    throw new UnrecoverableError(`unknown ai job "${job.name}"`);
  }
  const parsed = aiRunJobSchema.safeParse(job.data);
  if (!parsed.success) {
    throw new UnrecoverableError('invalid ai job payload');
  }
  const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
  try {
    return await runAiJob(deps, parsed.data.jobId, finalAttempt);
  } catch (error) {
    if (finalAttempt) {
      await markAiJobFailed(deps, parsed.data.jobId, 'unavailable').catch(() => undefined);
    }
    throw error;
  }
};

type WorkerDeps = AiRunDeps & { readonly connection: Redis; readonly config: AppConfig };

export const createAiWorker = ({ connection, config, ...deps }: WorkerDeps): Worker<AiRunJob> => {
  const worker = new Worker<AiRunJob>(AI_QUEUE, (job) => processAiJob(deps, job), {
    connection,
    prefix: bullmqPrefix(config),
    // Each job mostly waits on the model; a few at once keep latency low.
    concurrency: 4,
    autorun: false,
  });
  worker.on('failed', (job, error) => {
    const level = error instanceof AiRetryLater ? 'info' : 'warn';
    deps.logger[level]({ err: error, jobId: job?.id }, 'AI job attempt failed');
  });
  worker.on('error', (error) => {
    deps.logger.warn({ err: error }, 'AI worker error');
  });
  return worker;
};
