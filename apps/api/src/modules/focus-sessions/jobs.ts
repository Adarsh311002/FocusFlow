import {
  FOCUS_SESSION_QUEUE,
  SOLO_END_JOB,
  SOLO_GRACE_JOB,
  type SoloEndJob,
  soloEndJobSchema,
  type SoloGraceJob,
  soloGraceJobSchema,
} from '@focus-flow/contracts';
import { DelayedError, type Job, Queue, UnrecoverableError, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import type { AppConfig } from '../../platform/config.js';
import { bullmqPrefix } from '../../platform/queues.js';
import type { FocusSessionScheduler, JobOutcome } from './lifecycle.js';

// The `focus-session` queue (docs/architecture/focus-timing-protocol.md, "Scheduled jobs";
// I7). Job ids are derived from what the job is about, so scheduling the same thing twice
// collapses into one job, and a job about an older stretch or disconnect does nothing when
// it runs. A job's delay is only a wake-up hint: the job re-checks the authoritative clocks
// (PostgreSQL for T_end, Redis TIME for the grace) and goes back to sleep if it ran early.

export type FocusSessionJob = SoloEndJob | SoloGraceJob;
export type FocusSessionQueue = Queue<FocusSessionJob>;

/** BullMQ reserves `:` in job ids; ids and instants never contain it. */
export const soloEndJobId = (sessionId: string, runningSinceMs: number, reconnectAtMs?: number) =>
  reconnectAtMs === undefined
    ? `solo-end-${sessionId}-${String(runningSinceMs)}`
    : `solo-end-${sessionId}-${String(runningSinceMs)}-r${String(reconnectAtMs)}`;

export const soloGraceJobId = (sessionId: string, disconnectedAtMs: number) =>
  `solo-grace-${sessionId}-${String(disconnectedAtMs)}`;

export const createFocusSessionQueue = (connection: Redis, config: AppConfig): FocusSessionQueue =>
  new Queue<FocusSessionJob>(FOCUS_SESSION_QUEUE, {
    connection,
    prefix: bullmqPrefix(config),
    defaultJobOptions: {
      // Every job is idempotent; a retry re-reads everything under the row lock.
      attempts: 8,
      backoff: { type: 'exponential', delay: 1_000 },
      // Redis runs with noeviction: finished jobs must not accumulate.
      removeOnComplete: 1_000,
      removeOnFail: 1_000,
    },
  });

type SchedulerDeps = {
  readonly queue: FocusSessionQueue;
  readonly graceMs: number;
  /** Redis TIME, ms: the clock the grace is measured on (E9). */
  readonly redisNowMs: () => Promise<number>;
  /** This host's clock, used only to turn an instant into a wake-up delay. */
  readonly hostNowMs?: () => number;
};

export const createFocusSessionScheduler = ({
  queue,
  graceMs,
  redisNowMs,
  hostNowMs = Date.now,
}: SchedulerDeps): FocusSessionScheduler => ({
  scheduleEnd: async ({ sessionId, userId, runningSinceMs, plannedEndMs, reconnectAtMs }) => {
    const payload = soloEndJobSchema.parse({ schemaVersion: 1, sessionId, userId, runningSinceMs });
    await queue.add(SOLO_END_JOB, payload, {
      jobId: soloEndJobId(sessionId, runningSinceMs, reconnectAtMs),
      delay: reconnectAtMs === undefined ? Math.max(0, plannedEndMs - hostNowMs()) : 0,
    });
  },
  scheduleGrace: async ({ sessionId, userId, disconnectedAtMs }) => {
    const payload = soloGraceJobSchema.parse({
      schemaVersion: 1,
      sessionId,
      userId,
      disconnectedAtMs,
    });
    const delay = Math.max(0, disconnectedAtMs + graceMs - (await redisNowMs()));
    await queue.add(SOLO_GRACE_JOB, payload, {
      jobId: soloGraceJobId(sessionId, disconnectedAtMs),
      delay,
    });
  },
});

export type FocusSessionProcessors = {
  readonly end: (job: SoloEndJob) => Promise<JobOutcome>;
  readonly grace: (job: SoloGraceJob) => Promise<JobOutcome>;
};

/** Validates and runs one job; an unknown job or payload fails once, without retries. */
export const processFocusSessionJob = async (
  processors: FocusSessionProcessors,
  name: string,
  data: unknown,
): Promise<JobOutcome> => {
  if (name === SOLO_END_JOB) {
    const parsed = soloEndJobSchema.safeParse(data);
    if (!parsed.success) {
      throw new UnrecoverableError('invalid solo-end payload');
    }
    return processors.end(parsed.data);
  }
  if (name === SOLO_GRACE_JOB) {
    const parsed = soloGraceJobSchema.safeParse(data);
    if (!parsed.success) {
      throw new UnrecoverableError('invalid solo-grace payload');
    }
    return processors.grace(parsed.data);
  }
  throw new UnrecoverableError(`unknown focus-session job "${name}"`);
};

type WorkerDeps = {
  readonly connection: Redis;
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly processors: FocusSessionProcessors;
  readonly hostNowMs?: () => number;
};

export const createFocusSessionWorker = ({
  connection,
  config,
  logger,
  processors,
  hostNowMs = Date.now,
}: WorkerDeps): Worker<FocusSessionJob> => {
  const worker = new Worker<FocusSessionJob>(
    FOCUS_SESSION_QUEUE,
    async (job: Job<FocusSessionJob>, token?: string) => {
      const outcome = await processFocusSessionJob(processors, job.name, job.data);
      if (outcome.kind === 'wake_later') {
        // Ran early: back to the delayed set, without spending an attempt.
        await job.moveToDelayed(hostNowMs() + outcome.delayMs, token);
        throw new DelayedError();
      }
      logger.debug({ jobId: job.id, jobName: job.name, outcome }, 'Focus session job finished');
      return outcome;
    },
    { connection, prefix: bullmqPrefix(config), concurrency: 5, autorun: false },
  );

  worker.on('failed', (job, error) => {
    logger.warn({ err: error, jobId: job?.id, jobName: job?.name }, 'Focus session job failed');
  });
  // Without a listener an 'error' event would crash the process.
  worker.on('error', (error) => {
    logger.warn({ err: error }, 'Focus session worker error');
  });

  return worker;
};
