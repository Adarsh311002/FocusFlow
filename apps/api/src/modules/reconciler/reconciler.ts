import type { ReconcileJob } from '@focus-flow/contracts';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import { redisTimeMs } from '../../platform/redis.js';
import { redisKeys } from '../../platform/redis-keys.js';
import type { InstanceRemovalReason } from '../presence/presence.js';

// The reconciler (docs/architecture/focus-timing-protocol.md, "Reconciler"): repairs what
// the event-driven path can miss. It runs at startup, after Redis recovery and every
// RECONCILER_INTERVAL_MS through BullMQ, so exactly one worker takes each scheduled run;
// every step is idempotent, so a concurrent or repeated run is harmless.
//
// Phase 3 implements step 1. The later steps belong to the phases that own their state:
//   2. overdue room timers / missing phase-end jobs           (Phase 7)
//   3. closed runs in the unsettled set                       (Phase 8)
//   4. participants and solo users past their grace           (Phases 4, 8)
//   5. solo sessions past T_end, missing end jobs             (Phase 4)
//   6. solo sessions to expire                                (Phase 4)
//   7. orphaned room sessions → timer_lost                    (Phase 8)

export type InstanceCleanup = {
  readonly removeInstance: (instanceId: string, reason: InstanceRemovalReason) => Promise<void>;
};

export type ReconcileSummary = { readonly deadInstances: readonly string[] };

type ReconcilerDeps = {
  readonly redis: Redis;
  readonly presence: InstanceCleanup;
  readonly instanceTtlMs: number;
  readonly logger: Logger;
};

export const createReconciler = ({ redis, presence, instanceTtlMs, logger }: ReconcilerDeps) => {
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

  return {
    run: async (job: ReconcileJob): Promise<ReconcileSummary> => {
      const deadInstances = await removeDeadInstances();
      const log = deadInstances.length > 0 ? logger.warn.bind(logger) : logger.debug.bind(logger);
      log(
        { trigger: job.trigger, correlationId: job.correlationId, deadInstances },
        'Reconcile run finished',
      );
      return { deadInstances };
    },
  };
};

export type Reconciler = ReturnType<typeof createReconciler>;
