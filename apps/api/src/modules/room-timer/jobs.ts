import {
  PHASE_END_JOB,
  type PhaseEndJob,
  phaseEndJobId,
  phaseEndJobSchema,
  ROOM_TIMER_QUEUE,
} from '@focus-flow/contracts';
import { DelayedError, type Job, Queue, UnrecoverableError, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import type { AppConfig } from '../../platform/config.js';
import { bullmqPrefix } from '../../platform/queues.js';
import { type EnsurableQueue, ensureJob, type EnsureOutcome } from '../focus-sessions/jobs.js';
import type { PhaseEndOutcome, RoomTimerService } from './types.js';

// The `room-timer` queue (docs/architecture/focus-timing-protocol.md, "Reaching zero" and
// "Scheduled jobs"; RT4). One delayed job per running timer version, id
// `phase-end_{roomId}_{version}`. The job is a wake-up hint only: it never trusts its
// payload, it asks the service to re-read the timer and decide (a job whose version is no
// longer current does nothing). Scheduling ENSURES the job with the same semantics as the
// focus-session queue (E20): an absent job is added, a pending one is left alone, a retained
// finished one is re-run with its attempts reset.

export type RoomTimerQueue = Queue<PhaseEndJob>;

export const createRoomTimerQueue = (connection: Redis, config: AppConfig): RoomTimerQueue =>
  new Queue<PhaseEndJob>(ROOM_TIMER_QUEUE, {
    connection,
    prefix: bullmqPrefix(config),
    defaultJobOptions: {
      // The phase end is idempotent: a retry re-reads the timer and re-evaluates.
      attempts: 5,
      backoff: { type: 'exponential', delay: 1_000 },
      // Redis runs with noeviction: finished jobs must not accumulate.
      removeOnComplete: 1_000,
      removeOnFail: 1_000,
    },
  });

/** The queue operations the scheduler needs (a fake in unit tests). */
export type SchedulableQueue = EnsurableQueue & {
  readonly add: (
    name: string,
    data: PhaseEndJob,
    options: { jobId: string; delay: number },
  ) => Promise<unknown>;
};

export type RoomTimerScheduler = {
  /**
   * Makes sure the phase-end job of `version` will run at `endsAtMs`. `nowMs` is the Redis
   * TIME the change was computed at; the delay is only a wake-up hint (the job re-checks
   * the authoritative clock and goes back to sleep if it ran early).
   */
  readonly ensurePhaseEnd: (
    roomId: string,
    version: number,
    endsAtMs: number,
    nowMs: number,
  ) => Promise<EnsureOutcome>;
};

export const createRoomTimerScheduler = (queue: SchedulableQueue): RoomTimerScheduler => ({
  ensurePhaseEnd: async (roomId, version, endsAtMs, nowMs) => {
    const payload = phaseEndJobSchema.parse({ schemaVersion: 1, roomId, version });
    const jobId = phaseEndJobId(roomId, version);
    return ensureJob(queue, jobId, () =>
      queue.add(PHASE_END_JOB, payload, { jobId, delay: Math.max(0, endsAtMs - nowMs) }),
    );
  },
});

/** Validates and runs one job; an unknown job or payload fails once, without retries. */
export const processRoomTimerJob = async (
  service: Pick<RoomTimerService, 'completePhase'>,
  name: string,
  data: unknown,
): Promise<PhaseEndOutcome> => {
  if (name !== PHASE_END_JOB) {
    throw new UnrecoverableError(`unknown room-timer job "${name}"`);
  }
  const parsed = phaseEndJobSchema.safeParse(data);
  if (!parsed.success) {
    throw new UnrecoverableError('invalid phase-end payload');
  }
  return service.completePhase(parsed.data.roomId, parsed.data.version);
};

type WorkerDeps = {
  readonly connection: Redis;
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly service: Pick<RoomTimerService, 'completePhase'>;
  /** This host's clock, used only to turn a delay into a BullMQ wake-up instant. */
  readonly hostNowMs?: () => number;
};

export const createRoomTimerWorker = ({
  connection,
  config,
  logger,
  service,
  hostNowMs = Date.now,
}: WorkerDeps): Worker<PhaseEndJob> => {
  const worker = new Worker<PhaseEndJob>(
    ROOM_TIMER_QUEUE,
    async (job: Job<PhaseEndJob>, token?: string) => {
      const outcome = await processRoomTimerJob(service, job.name, job.data);
      if (outcome.result === 'early') {
        // Ran early: back to the delayed set for the remaining time, without spending an
        // attempt. The job keeps its id, so it is the same job that runs again.
        await job.moveToDelayed(hostNowMs() + Math.max(1, outcome.delayMs), token);
        throw new DelayedError();
      }
      logger.debug(
        {
          jobId: job.id,
          roomId: job.data.roomId,
          version: job.data.version,
          result: outcome.result,
        },
        'Room timer job finished',
      );
      return outcome.result;
    },
    { connection, prefix: bullmqPrefix(config), concurrency: 5, autorun: false },
  );

  worker.on('failed', (job, error) => {
    logger.warn({ err: error, jobId: job?.id, jobName: job?.name }, 'Room timer job failed');
  });
  // Without a listener an 'error' event would crash the process.
  worker.on('error', (error) => {
    logger.warn({ err: error }, 'Room timer worker error');
  });

  return worker;
};
