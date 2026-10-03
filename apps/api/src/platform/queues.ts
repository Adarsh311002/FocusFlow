import { randomUUID } from 'node:crypto';

import {
  MAINTENANCE_QUEUE,
  RECONCILE_JOB,
  type ReconcileJob,
  reconcileJobSchema,
  type ReconcileTrigger,
} from '@focus-flow/contracts';
import { type Job, Queue, UnrecoverableError, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import type { AppConfig } from './config.js';

// BullMQ (I7, docs/architecture/redis-keys.md "Queues"). Queue keys live under
// `{REDIS_KEY_PREFIX}bull` (default `ff:bull`, P3), on connections without an ioredis
// keyPrefix (createRedisConnection 'bullmq'). Phase 3 has one queue, `maintenance`, whose
// only job is the reconciler; `focus-session` and `room-timer` arrive with their phases.

export const bullmqPrefix = (config: AppConfig): string => `${config.REDIS_KEY_PREFIX}bull`;

/** Job scheduler id (BullMQ reserves `:`). One schedule cluster-wide, however many instances. */
export const RECONCILE_SCHEDULER_ID = 'reconcile-every-interval';

export type MaintenanceQueue = Queue<ReconcileJob>;

export const createMaintenanceQueue = (connection: Redis, config: AppConfig): MaintenanceQueue =>
  new Queue<ReconcileJob>(MAINTENANCE_QUEUE, {
    connection,
    prefix: bullmqPrefix(config),
    defaultJobOptions: {
      // Every reconciler step is idempotent, so retrying a failed run is always safe.
      attempts: 3,
      backoff: { type: 'exponential', delay: 1_000 },
      // Redis runs with noeviction: finished jobs must not accumulate.
      removeOnComplete: 100,
      removeOnFail: 100,
    },
  });

const reconcilePayload = (trigger: ReconcileTrigger, correlationId: string): ReconcileJob => ({
  schemaVersion: 1,
  trigger,
  correlationId,
});

/** Idempotent: every instance may call it at startup and after Redis recovery. */
export const upsertReconcileSchedule = async (
  queue: MaintenanceQueue,
  config: AppConfig,
): Promise<void> => {
  await queue.upsertJobScheduler(
    RECONCILE_SCHEDULER_ID,
    { every: config.RECONCILER_INTERVAL_MS },
    { name: RECONCILE_JOB, data: reconcilePayload('schedule', RECONCILE_SCHEDULER_ID) },
  );
};

/**
 * A one-off reconcile run. `dedupeKey` makes repeats collapse into one job (for example
 * one startup run per instance, one recovery run per epoch).
 */
export const enqueueReconcile = async (
  queue: MaintenanceQueue,
  trigger: Exclude<ReconcileTrigger, 'schedule'>,
  dedupeKey: string,
): Promise<void> => {
  await queue.add(RECONCILE_JOB, reconcilePayload(trigger, randomUUID()), {
    jobId: `reconcile-${trigger}-${dedupeKey.replaceAll(':', '-')}`,
  });
};

export type ReconcileRunner = (job: ReconcileJob) => Promise<unknown>;

type WorkerDeps = {
  readonly connection: Redis;
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly reconcile: ReconcileRunner;
};

/**
 * The maintenance worker. Payloads are validated before anything runs: an unknown job or
 * schema version fails without retries (UnrecoverableError), so an old worker never
 * guesses at a newer payload.
 */
export const createMaintenanceWorker = ({
  connection,
  config,
  logger,
  reconcile,
}: WorkerDeps): Worker<ReconcileJob> => {
  const worker = new Worker<ReconcileJob>(
    MAINTENANCE_QUEUE,
    async (job: Job<ReconcileJob>) => {
      if (job.name !== RECONCILE_JOB) {
        throw new UnrecoverableError(`unknown maintenance job "${job.name}"`);
      }
      const parsed = reconcileJobSchema.safeParse(job.data);
      if (!parsed.success) {
        throw new UnrecoverableError('invalid reconcile payload');
      }
      return reconcile(parsed.data);
    },
    { connection, prefix: bullmqPrefix(config), concurrency: 1, autorun: false },
  );

  worker.on('failed', (job, error) => {
    logger.warn({ err: error, jobId: job?.id, jobName: job?.name }, 'Maintenance job failed');
  });
  // Without a listener an 'error' event would crash the process.
  worker.on('error', (error) => {
    logger.warn({ err: error }, 'Maintenance worker error');
  });

  return worker;
};
