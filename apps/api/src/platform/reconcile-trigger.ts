import { randomUUID } from 'node:crypto';

import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import type { Reconciler } from '../modules/reconciler/reconciler.js';
import type { AppConfig } from './config.js';
import { ensureReconcileSchedule, type MaintenanceQueue } from './queues.js';
import { redisTimeMs } from './redis.js';
import { redisKeys } from './redis-keys.js';

// The process-owned reconcile trigger (E23; docs/architecture/focus-timing-protocol.md,
// "Reconciler"). The repeating BullMQ schedule lives in Redis, so a FLUSHALL deletes it and
// nothing stored in Redis can bring it back. Every worker-running process therefore keeps a
// timer of its own, every RECONCILER_INTERVAL_MS:
//   - Redis reachable: re-register the schedule if it is missing, and if no reconcile run
//     has finished for 3 × RECONCILER_INTERVAL_MS (the liveness record is missing or older),
//     run the reconciler directly in this process;
//   - Redis unreachable: run the PostgreSQL-only stale cleanup (step 6, E22).
// A tick never overlaps the previous one, and the reconciler is single-flight per process,
// so this adds at most one direct run per process per interval — and only while scheduled
// runs are not happening. Overlapping runs across processes are safe (SKIP LOCKED).

/** E23: scheduled runs count as stopped after this many intervals without a finished run. */
export const RECONCILE_LIVENESS_FACTOR = 3;

/** E23: how long without a finished run before a worker process reconciles directly. */
export const reconcileOverdueAfterMs = (intervalMs: number): number =>
  RECONCILE_LIVENESS_FACTOR * intervalMs;

/** E23: whether reconcile runs have stopped happening, by Redis TIME. */
export const isReconcileOverdue = (
  lastFinishedMs: number | undefined,
  nowMs: number,
  intervalMs: number,
): boolean =>
  lastFinishedMs === undefined || nowMs - lastFinishedMs >= reconcileOverdueAfterMs(intervalMs);

const parseInstant = (raw: string | null): number | undefined => {
  if (raw === null || !/^\d{1,16}$/.test(raw)) {
    return undefined;
  }
  return Number(raw);
};

export type TickOutcome =
  | { readonly kind: 'busy' }
  | { readonly kind: 'redis_unavailable'; readonly staleCleanupRan: boolean }
  | {
      readonly kind: 'checked';
      readonly schedule: 'present' | 'repaired' | 'unknown';
      readonly ranDirectly: boolean;
    };

type TriggerDeps = {
  readonly redis: Redis;
  readonly queue: MaintenanceQueue;
  readonly config: AppConfig;
  readonly reconciler: Pick<Reconciler, 'runIfIdle' | 'runStaleCleanup'>;
  readonly logger: Logger;
  readonly instanceId: string;
};

export const createReconcileTrigger = ({
  redis,
  queue,
  config,
  reconciler,
  logger,
  instanceId,
}: TriggerDeps) => {
  const intervalMs = config.RECONCILER_INTERVAL_MS;
  let timer: NodeJS.Timeout | undefined;
  let ticking: Promise<TickOutcome> | undefined;

  const check = async (): Promise<TickOutcome> => {
    let nowMs: number;
    try {
      nowMs = await redisTimeMs(redis);
    } catch {
      logger.warn({ instanceId }, 'Redis is unreachable; running the stale-session cleanup only');
      const summary = await reconciler.runStaleCleanup();
      return { kind: 'redis_unavailable', staleCleanupRan: summary !== undefined };
    }

    let schedule: 'present' | 'repaired' | 'unknown' = 'unknown';
    try {
      schedule = await ensureReconcileSchedule(queue, config);
      if (schedule === 'repaired') {
        logger.warn({ instanceId }, 'The reconcile schedule was missing; re-registered it');
      }
    } catch (error) {
      logger.warn({ err: error, instanceId }, 'Could not check the reconcile schedule');
    }

    const lastFinishedMs = parseInstant(await redis.get(redisKeys.reconcileLastFinished));
    if (!isReconcileOverdue(lastFinishedMs, nowMs, intervalMs)) {
      return { kind: 'checked', schedule, ranDirectly: false };
    }
    logger.warn(
      { instanceId, lastFinishedMs, nowMs },
      'No reconcile run has finished recently; reconciling directly',
    );
    const summary = await reconciler.runIfIdle({
      schemaVersion: 1,
      trigger: 'recovery',
      correlationId: `watchdog-${instanceId}-${randomUUID()}`,
    });
    return { kind: 'checked', schedule, ranDirectly: summary !== undefined };
  };

  /** One check; a tick while the previous one is still running does nothing. */
  const tick = async (): Promise<TickOutcome> => {
    if (ticking !== undefined) {
      return { kind: 'busy' };
    }
    ticking = check().finally(() => {
      ticking = undefined;
    });
    return ticking;
  };

  return {
    tick,
    start: (): void => {
      timer ??= setInterval(() => {
        tick().catch((error: unknown) => {
          logger.warn({ err: error, instanceId }, 'Reconcile trigger tick failed');
        });
      }, intervalMs);
      // Never keeps a process alive on its own.
      timer.unref();
    },
    stop: async (): Promise<void> => {
      clearInterval(timer);
      timer = undefined;
      await ticking?.catch(() => undefined);
    },
  };
};

export type ReconcileTrigger = ReturnType<typeof createReconcileTrigger>;
