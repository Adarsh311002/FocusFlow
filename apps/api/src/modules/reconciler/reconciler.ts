import type { ReconcileJob } from '@focus-flow/contracts';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import { redisTimeMs } from '../../platform/redis.js';
import { redisKeys } from '../../platform/redis-keys.js';
import type { LifecycleDeps } from '../focus-sessions/lifecycle.js';
import {
  type SweepOptions,
  sweepRunningSessions,
  sweepStaleSessions,
  type SweepSummary,
} from '../focus-sessions/sweep.js';
import type { InstanceRemovalReason } from '../presence/presence.js';

// The reconciler (docs/architecture/focus-timing-protocol.md, "Reconciler"): repairs what
// the event-driven path can miss. It runs at startup, after Redis recovery and every
// RECONCILER_INTERVAL_MS through BullMQ — and, when those runs stop happening (a lost
// schedule, Redis down), directly from each worker process (platform/reconcile-trigger.ts,
// E23). Several runs may overlap across instances; every step is idempotent and the
// session steps lock rows with SKIP LOCKED, so that is harmless. Within one instance runs
// are serialised (single-flight).
//
// Implemented steps (the others belong to the phases that own their state):
//   1. dead instances' presence                                (Phase 3)
//   2. overdue room timers / missing phase-end jobs             (Phase 7)
//   3. closed runs in the unsettled set                         (Phase 8)
//   4. room participants past their grace                       (Phase 8)
//   5. every running solo session: the decision, settled or its jobs ensured  (Phase 4B)
//   6. solo sessions still in progress 12 h after started_at: expired          (Phase 4B)
//   7. orphaned room sessions → timer_lost                      (Phase 8)

export type InstanceCleanup = {
  readonly removeInstance: (instanceId: string, reason: InstanceRemovalReason) => Promise<void>;
};

export type ReconcileSummary = {
  readonly deadInstances: readonly string[];
  /** Step 5 (absent when the focus steps are not wired, or the step itself failed). */
  readonly runningSessions?: SweepSummary;
  /** Step 6. */
  readonly staleSessions?: SweepSummary;
};

type ReconcilerDeps = {
  readonly redis: Redis;
  readonly presence: InstanceCleanup;
  readonly instanceTtlMs: number;
  /** RECONCILER_INTERVAL_MS: also each session step's time budget. */
  readonly intervalMs: number;
  readonly logger: Logger;
  /** Solo Focus steps 5 and 6 (Phase 4B). */
  readonly focusSessions?: { readonly deps: LifecycleDeps; readonly options?: SweepOptions };
};

/** How long the liveness record is kept: far longer than any threshold reading it. */
const LIVENESS_TTL_MS = 24 * 60 * 60 * 1_000;

export const createReconciler = ({
  redis,
  presence,
  instanceTtlMs,
  intervalMs,
  logger,
  focusSessions,
}: ReconcilerDeps) => {
  let stopping = false;

  /**
   * Step 1: instances whose heartbeat is older than the TTL (Redis TIME) are dead. Their
   * presence entries are removed through the reverse index, and each user left without a
   * live socket is reported offline (`instance_dead`, disconnected at the instance's last
   * heartbeat) before the entries go. The instance leaves the live set last, so a crash
   * midway is simply repeated by the next run, which reports again with the same time. An
   * instance wrongly declared dead (a long pause) re-adds its sockets on its next sync and
   * itself on its next heartbeat.
   */
  const removeDeadInstances = async (): Promise<string[]> => {
    const cutoffMs = (await redisTimeMs(redis)) - instanceTtlMs;
    const dead = await redis.zrangebyscore(redisKeys.instances, '-inf', `(${String(cutoffMs)}`);
    for (const instanceId of dead) {
      await presence.removeInstance(instanceId, 'instance_dead');
      await redis.zrem(redisKeys.instances, instanceId);
    }
    return dead;
  };

  /** A time budget of one interval for a step, ended early by `stop()`. */
  const budget = (): (() => boolean) => {
    const endsAt = Date.now() + intervalMs;
    return () => !stopping && Date.now() < endsAt;
  };

  const sweepOptions = (): SweepOptions => ({
    ...focusSessions?.options,
    shouldContinue: budget(),
  });

  const runStep = async <T>(
    errors: unknown[],
    name: string,
    step: () => Promise<T>,
  ): Promise<T | undefined> => {
    try {
      return await step();
    } catch (error) {
      errors.push(error);
      logger.warn({ err: error, step: name }, 'Reconcile step failed; the next run repeats it');
      return undefined;
    }
  };

  /** Steps 1, 5 and 6, then the liveness record. Fails (after all steps) if one failed. */
  const fullRun = async (job: ReconcileJob): Promise<ReconcileSummary> => {
    const errors: unknown[] = [];
    // Step 1 first: its instance_dead hints record markers at the last heartbeat, so step
    // 5 does not start late grace from a later detection time for those users.
    const deadInstances = (await runStep(errors, 'dead instances', removeDeadInstances)) ?? [];
    const runningSessions =
      focusSessions === undefined
        ? undefined
        : await runStep(errors, 'running sessions', () =>
            sweepRunningSessions({ ...focusSessions.deps, logger }, sweepOptions()),
          );
    const staleSessions =
      focusSessions === undefined
        ? undefined
        : await runStep(errors, 'stale sessions', () =>
            sweepStaleSessions({ ...focusSessions.deps, logger }, sweepOptions()),
          );
    await runStep(errors, 'liveness', async () => {
      await redis.set(
        redisKeys.reconcileLastFinished,
        String(await redisTimeMs(redis)),
        'PX',
        LIVENESS_TTL_MS,
      );
    });
    const summary: ReconcileSummary = {
      deadInstances,
      ...(runningSessions === undefined ? {} : { runningSessions }),
      ...(staleSessions === undefined ? {} : { staleSessions }),
    };
    const settledAny =
      deadInstances.length > 0 ||
      Object.keys(runningSessions?.outcomes ?? {}).some((label) => label.startsWith('settled')) ||
      (staleSessions?.outcomes.expired ?? 0) > 0;
    const log =
      settledAny || errors.length > 0 ? logger.warn.bind(logger) : logger.debug.bind(logger);
    log(
      { trigger: job.trigger, correlationId: job.correlationId, ...summary },
      'Reconcile run finished',
    );
    if (errors.length > 0) {
      throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'reconcile steps failed');
    }
    return summary;
  };

  // Single-flight within this instance: one run at a time. A run requested while one is in
  // flight waits for it and then runs once more (shared by every request meanwhile), since
  // the running one may have started before the cause of the request.
  let inFlight: Promise<unknown> | undefined;
  let queued: Promise<ReconcileSummary> | undefined;

  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const running = work().finally(() => {
      inFlight = undefined;
    });
    inFlight = running;
    return running;
  };

  const run = (job: ReconcileJob): Promise<ReconcileSummary> => {
    if (inFlight === undefined) {
      return exclusive(() => fullRun(job));
    }
    queued ??= inFlight
      .catch(() => undefined)
      .then(() => {
        queued = undefined;
        return run(job);
      });
    return queued;
  };

  return {
    run,
    /** A direct run (the trigger's watchdog): skipped while another run is in flight here. */
    runIfIdle: (job: ReconcileJob): Promise<ReconcileSummary | undefined> =>
      inFlight === undefined ? run(job) : Promise.resolve(undefined),
    /**
     * Step 6 alone, PostgreSQL only — while Redis is unavailable (E22). Skipped while
     * another run is in flight here.
     */
    runStaleCleanup: (): Promise<SweepSummary | undefined> =>
      focusSessions === undefined || inFlight !== undefined
        ? Promise.resolve(undefined)
        : exclusive(() => sweepStaleSessions({ ...focusSessions.deps, logger }, sweepOptions())),
    /** Stops starting new sessions in a running sweep and waits for the run to end. */
    stop: async (): Promise<void> => {
      stopping = true;
      await inFlight?.catch(() => undefined);
    },
  };
};

export type Reconciler = ReturnType<typeof createReconciler>;
