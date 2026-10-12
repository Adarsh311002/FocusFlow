import { randomUUID } from 'node:crypto';

import { RECONCILE_JOB, type ReconcileJob } from '@focus-flow/contracts';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  configFor,
  startInstance,
  startTestHarness,
  stopTestHarness,
  type TestHarness,
  type TestInstance,
} from '../../../test/harness.js';
import { closeAllSockets, connectSocket } from '../../../test/sockets.js';
import { signUpTestUser } from '../../../test/users.js';
import { focusSessions } from '../../db/schema.js';
import { createMaintenanceQueue, RECONCILE_SCHEDULER_ID } from '../../platform/queues.js';
import { createReconcileTrigger } from '../../platform/reconcile-trigger.js';
import {
  createRedisClient,
  createRedisConnection,
  redisTimeMs,
  waitForRedisReady,
} from '../../platform/redis.js';
import { redisKeys } from '../../platform/redis-keys.js';
import { createRuntime } from '../../platform/runtime.js';
import type { UserOfflineEvent } from '../presence/presence.js';

// BullMQ worker role and reconciler (approved Phase 3 decisions 6 and 7) against real
// Redis, with two worker-running API instances and short intervals.

const TIMINGS = {
  INSTANCE_HEARTBEAT_MS: '200',
  INSTANCE_TTL_MS: '1000',
  RECONCILER_INTERVAL_MS: '500',
};

let harness: TestHarness | undefined;
let second: TestInstance | undefined;

const requireHarness = (): TestHarness => {
  if (harness === undefined) {
    throw new Error('the API harness failed to start');
  }
  return harness;
};

const requireSecond = (): TestInstance => {
  if (second === undefined) {
    throw new Error('the second API instance failed to start');
  }
  return second;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (condition: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await condition()) {
        return;
      }
    } catch {
      // A probe that throws (Redis reconnecting) counts as "not yet".
    }
    if (Date.now() > deadline) {
      throw new Error('condition not met in time');
    }
    await sleep(50);
  }
};

const queue = () => requireHarness().runtime.maintenanceQueue;
const jobState = async (jobId: string) => (await queue().getJob(jobId))?.getState();
const userEntries = (userId: string) =>
  requireHarness().redis.smembers(redisKeys.userSockets(userId));

/** Offline reports for one user from either worker-running instance. */
const collectOfflineEvents = (userId: string): UserOfflineEvent[] => {
  const events: UserOfflineEvent[] = [];
  for (const runtime of [requireHarness().runtime, requireSecond().runtime]) {
    runtime.presence.onUserOffline((event) => {
      if (event.userId === userId) {
        events.push(event);
      }
    });
  }
  return events;
};

beforeAll(async () => {
  harness = await startTestHarness(TIMINGS);
  second = await startInstance(harness, TIMINGS);
}, 180_000);

afterEach(() => {
  closeAllSockets();
});

afterAll(async () => {
  closeAllSockets();
  if (harness !== undefined) {
    await stopTestHarness(harness);
  }
}, 60_000);

describe('schedule and startup runs', () => {
  it('registers exactly one reconcile schedule, however many instances start', async () => {
    const schedulers = await queue().getJobSchedulers();

    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]?.key).toBe(RECONCILE_SCHEDULER_ID);
    expect(schedulers[0]?.every).toBe(500);
  });

  it('processes the startup reconcile of every worker instance', async () => {
    for (const runtime of [requireHarness().runtime, requireSecond().runtime]) {
      await waitFor(
        async () => (await jobState(`reconcile-startup-${runtime.instanceId}`)) === 'completed',
      );
    }
  });

  it('keeps running the scheduled reconcile', async () => {
    const before = await queue().getCompletedCount();

    await waitFor(async () => (await queue().getCompletedCount()) >= before + 2, 5_000);
  });
});

describe('dead-instance cleanup', () => {
  it('removes a crashed instance’s presence on its own and reports its users offline', async () => {
    const h = requireHarness();
    const doomed = await startInstance(h, { ...TIMINGS, ROLE: 'api' });
    const stranded = await signUpTestUser(h, 'stranded');
    const survivor = await signUpTestUser(h, 'survivor');
    await connectSocket(doomed.baseUrl, stranded.accessToken);
    await connectSocket(doomed.baseUrl, survivor.accessToken);
    await connectSocket(h.baseUrl, survivor.accessToken);
    await waitFor(async () => (await userEntries(stranded.userId)).length === 1);
    await waitFor(async () => (await userEntries(survivor.userId)).length === 2);
    const offline: string[] = [];
    for (const runtime of [h.runtime, requireSecond().runtime]) {
      runtime.presence.onUserOffline(({ userId, reason }) => {
        offline.push(`${userId}:${reason}`);
      });
    }

    // Simulated crash: the instance loses Redis without cleaning up after itself.
    doomed.runtime.redis.disconnect();

    await waitFor(
      async () =>
        (await h.redis.zscore(redisKeys.instances, doomed.runtime.instanceId)) === null &&
        (await h.redis.exists(redisKeys.instanceSockets(doomed.runtime.instanceId))) === 0,
    );
    expect(await userEntries(stranded.userId)).toEqual([]);
    expect(await userEntries(survivor.userId)).toHaveLength(1);
    expect(offline).toContain(`${stranded.userId}:instance_dead`);
    expect(offline).not.toContain(`${survivor.userId}:instance_dead`);
  });

  it('is idempotent: concurrent runs from two instances leave the same state', async () => {
    const h = requireHarness();
    const ghost = '01a0ed0d-0000-7000-8000-00000000d0d0';
    const user = await signUpTestUser(h, 'ghosted');
    const events = collectOfflineEvents(user.userId);
    await h.redis
      .multi()
      .zadd(redisKeys.instances, 1, ghost)
      .sadd(redisKeys.userSockets(user.userId), `${ghost}:socket-1`)
      .sadd(redisKeys.instanceSockets(ghost), `${user.userId}:socket-1`)
      .exec();
    const job: ReconcileJob = { schemaVersion: 1, trigger: 'recovery', correlationId: 'test' };

    const results = await Promise.all([
      h.runtime.reconciler.run(job),
      requireSecond().runtime.reconciler.run(job),
      h.runtime.reconciler.run(job),
    ]);

    expect(results.some((result) => result.deadInstances.includes(ghost))).toBe(true);
    expect(await h.redis.zscore(redisKeys.instances, ghost)).toBeNull();
    expect(await userEntries(user.userId)).toEqual([]);
    expect(await h.redis.exists(redisKeys.instanceSockets(ghost))).toBe(0);
    // Concurrent runs may each report the user; every report carries the same key, so a
    // consumer collapses them to one.
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(
      new Set(events.map((event) => `${event.userId}@${String(event.disconnectedAtMs)}`)),
    ).toEqual(new Set([`${user.userId}@1`]));
  });

  it('reports a dead instance’s users as disconnected at its last heartbeat', async () => {
    const h = requireHarness();
    const dead = randomUUID();
    const user = await signUpTestUser(h, 'crashed');
    const events = collectOfflineEvents(user.userId);
    const lastHeartbeatMs = (await redisTimeMs(h.redis)) - 60_000;
    await h.redis
      .multi()
      .zadd(redisKeys.instances, lastHeartbeatMs, dead)
      .sadd(redisKeys.userSockets(user.userId), `${dead}:socket-1`)
      .sadd(redisKeys.instanceSockets(dead), `${user.userId}:socket-1`)
      .exec();

    // The scheduled run (every 500 ms here) or this one, whichever comes first.
    await h.runtime.reconciler.run({ schemaVersion: 1, trigger: 'recovery', correlationId: 't' });

    await waitFor(() => Promise.resolve(events.length >= 1));
    for (const event of events) {
      expect(event).toEqual({
        userId: user.userId,
        reason: 'instance_dead',
        disconnectedAtMs: lastHeartbeatMs,
      });
    }
    expect(await userEntries(user.userId)).toEqual([]);
  });

  it('re-adds an instance wrongly declared dead, with its sockets, on its next heartbeat', async () => {
    const h = requireHarness();
    const user = await signUpTestUser(h);
    const socket = await connectSocket(h.baseUrl, user.accessToken);
    await waitFor(async () => (await userEntries(user.userId)).length === 1);

    // What another instance's reconciler does to an instance it believes is dead.
    await h.runtime.presence.removeInstance(h.runtime.instanceId, 'instance_dead');
    await h.redis.zrem(redisKeys.instances, h.runtime.instanceId);
    expect(await userEntries(user.userId)).toEqual([]);

    // The sockets may come back first (the per-heartbeat sync), the instance on its next
    // heartbeat; both must.
    await waitFor(
      async () =>
        (await userEntries(user.userId)).length === 1 &&
        (await h.redis.zscore(redisKeys.instances, h.runtime.instanceId)) !== null,
    );
    expect(await userEntries(user.userId)).toEqual([
      `${h.runtime.instanceId}:${String(socket.id)}`,
    ]);
  });
});

describe('Redis data loss', () => {
  it('re-registers the schedule and processes one recovery run after FLUSHALL', async () => {
    const h = requireHarness();

    await h.redis.flushall();

    await waitFor(async () => (await queue().getJobSchedulers()).length === 1);
    await waitFor(async () => {
      const epoch = await h.redis.get(redisKeys.epoch);
      return epoch !== null && (await jobState(`reconcile-recovery-${epoch}`)) === 'completed';
    });
  });
});

describe('job validation', () => {
  it('fails an invalid payload once, without retries', async () => {
    const invalid = { schemaVersion: 2, trigger: 'schedule' } as unknown as ReconcileJob;
    await queue().add(RECONCILE_JOB, invalid, { jobId: 'reconcile-invalid-payload' });

    await waitFor(async () => (await jobState('reconcile-invalid-payload')) === 'failed');
    const job = await queue().getJob('reconcile-invalid-payload');
    expect(job?.attemptsMade).toBe(1);
    expect(job?.failedReason).toContain('invalid reconcile payload');
  });
});

describe('worker-only role', () => {
  it('runs the reconciler without an HTTP listener', async () => {
    const worker = await createRuntime(configFor(requireHarness(), { ...TIMINGS, ROLE: 'worker' }));
    try {
      const port = await worker.start({ port: 0, host: '127.0.0.1' });

      expect(port).toBeUndefined();
      expect(worker.server.listening).toBe(false);
      expect(worker.maintenanceWorker).toBeDefined();
      await waitFor(
        async () => (await jobState(`reconcile-startup-${worker.instanceId}`)) === 'completed',
      );
    } finally {
      await worker.stop();
    }
  });
});

describe('shutdown order', () => {
  it('follows the approved order: Socket.IO, then heartbeat, presence, worker, queue, connections', () => {
    const { runtime } = requireHarness();

    // The HTTP server closes between the two lists; the general Redis client and PostgreSQL
    // close after the last step (see createShutdown).
    expect(runtime.beforeServerClose.map((step) => step.name)).toEqual(['socket.io']);
    expect(runtime.shutdownSteps.map((step) => step.name)).toEqual([
      'instance heartbeat',
      'presence',
      'maintenance worker',
      'maintenance queue',
      'focus-session worker',
      'focus-session queue',
      'redis connections',
    ]);
  });
});

describe('the process-owned trigger (E23)', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
  });

  /**
   * A trigger with a fake reconciler on its own key prefix (shared by triggers given the
   * same `prefix`), so the runtime's own runs (every 500 ms here) never touch its liveness
   * record or schedule.
   */
  const isolatedTrigger = async (options: { prefix?: string; redisUrl?: string } = {}) => {
    const h = requireHarness();
    const config = {
      ...h.config,
      REDIS_KEY_PREFIX: options.prefix ?? `ff-t-${randomUUID().slice(0, 8)}:`,
      ...(options.redisUrl === undefined ? {} : { REDIS_URL: options.redisUrl }),
    };
    const redis = createRedisClient(config, h.runtime.logger);
    if (options.redisUrl === undefined) {
      await waitForRedisReady(redis, 10_000);
    }
    const queueConnection = createRedisConnection(h.config, h.runtime.logger, 'bullmq');
    const queue = createMaintenanceQueue(queueConnection, config);
    const calls = { direct: 0, stale: 0 };
    let holdDirectRuns = false;
    let release: () => void = () => undefined;
    const trigger = createReconcileTrigger({
      redis,
      queue,
      config,
      reconciler: {
        runIfIdle: async () => {
          calls.direct += 1;
          if (holdDirectRuns) {
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
          return { deadInstances: [] };
        },
        runStaleCleanup: () => {
          calls.stale += 1;
          return Promise.resolve({ outcomes: {}, failed: 0, followUpFailed: 0, complete: true });
        },
      },
      logger: h.runtime.logger,
      instanceId: randomUUID(),
    });
    cleanups.push(async () => {
      release();
      await trigger.stop();
      await queue.close();
      queueConnection.disconnect();
      redis.disconnect();
    });
    return {
      trigger,
      redis,
      queue,
      calls,
      prefix: config.REDIS_KEY_PREFIX,
      hold: () => {
        holdDirectRuns = true;
      },
      release: () => {
        release();
      },
    };
  };

  it('runs directly only when no reconcile run has finished for 3 intervals', async () => {
    const t = await isolatedTrigger();
    const intervalMs = requireHarness().config.RECONCILER_INTERVAL_MS;
    const now = await redisTimeMs(t.redis);

    await t.redis.set(redisKeys.reconcileLastFinished, String(now));
    expect(await t.trigger.tick()).toMatchObject({ kind: 'checked', ranDirectly: false });
    // Exactly three intervals before an instant earlier than the tick's own TIME: overdue.
    await t.redis.set(redisKeys.reconcileLastFinished, String(now - 3 * intervalMs));
    expect(await t.trigger.tick()).toMatchObject({ kind: 'checked', ranDirectly: true });
    await t.redis.del(redisKeys.reconcileLastFinished);
    expect(await t.trigger.tick()).toMatchObject({ kind: 'checked', ranDirectly: true });
    expect(t.calls).toEqual({ direct: 2, stale: 0 });
  });

  it('re-registers a missing schedule; concurrent repairs leave exactly one', async () => {
    const t = await isolatedTrigger();
    expect(await t.queue.getJobSchedulers()).toEqual([]);
    expect(await t.trigger.tick()).toMatchObject({ schedule: 'repaired' });
    expect(await t.trigger.tick()).toMatchObject({ schedule: 'present' });

    await t.queue.removeJobScheduler(RECONCILE_SCHEDULER_ID);
    const others = [
      await isolatedTrigger({ prefix: t.prefix }),
      await isolatedTrigger({ prefix: t.prefix }),
    ];
    await Promise.all([t.trigger.tick(), ...others.map((other) => other.trigger.tick())]);
    expect(await t.queue.getJobSchedulers()).toHaveLength(1);
  });

  it('a tick while the previous one is still running does nothing', async () => {
    const t = await isolatedTrigger();
    t.hold();
    const first = t.trigger.tick();
    await waitFor(() => Promise.resolve(t.calls.direct === 1));
    expect(await t.trigger.tick()).toEqual({ kind: 'busy' });
    t.release();
    expect(await first).toMatchObject({ ranDirectly: true });
    expect(t.calls.direct).toBe(1);
  });

  it('with Redis unreachable, runs only the PostgreSQL stale cleanup (E22)', async () => {
    const t = await isolatedTrigger({ redisUrl: 'redis://127.0.0.1:1' });
    expect(await t.trigger.tick()).toEqual({ kind: 'redis_unavailable', staleCleanupRan: true });
    expect(t.calls).toEqual({ direct: 0, stale: 1 });
  });

  it('with the BullMQ workers paused, a FLUSHALL is recovered by the trigger alone', async () => {
    const h = requireHarness();
    const workers = [h.runtime.maintenanceWorker, requireSecond().runtime.maintenanceWorker].filter(
      (worker) => worker !== undefined,
    );
    await Promise.all(workers.map((worker) => worker.pause()));
    try {
      await h.redis.flushall();
      // The schedule comes back and a run finishes although no BullMQ worker takes jobs:
      // the triggers re-registered it and ran the reconciler directly.
      await waitFor(async () => (await queue().getJobSchedulers()).length === 1);
      await waitFor(async () => (await h.redis.get(redisKeys.reconcileLastFinished)) !== null);
      expect(await queue().getJobCounts('completed')).toEqual({ completed: 0 });
    } finally {
      await Promise.all(workers.map((worker) => worker.resume()));
    }
  });
});

describe('the reconciler run (E19, E23)', () => {
  it('is single-flight within an instance: a direct run is skipped while one is in flight', async () => {
    const { reconciler } = requireHarness().runtime;
    const job: ReconcileJob = { schemaVersion: 1, trigger: 'recovery', correlationId: 'single' };
    const first = reconciler.run(job);
    expect(await reconciler.runIfIdle(job)).toBeUndefined();
    const queued = reconciler.run(job);
    await expect(first).resolves.toMatchObject({ deadInstances: expect.any(Array) as unknown });
    await expect(queued).resolves.toMatchObject({ deadInstances: expect.any(Array) as unknown });
  });

  it('step 1 records a dead instance’s disconnect before step 5: no late grace from detection', async () => {
    const h = requireHarness();
    const user = await signUpTestUser(h, 'step-order');
    const startedAt = new Date((await redisTimeMs(h.redis)) - 60_000);
    const [row] = await h.db
      .insert(focusSessions)
      .values({
        id: randomUUID(),
        userId: user.userId,
        status: 'in_progress',
        plannedSeconds: 1_500,
        focusedSeconds: 0,
        runningSince: startedAt,
        startedAt,
      })
      .returning();
    if (row === undefined) {
      throw new Error('no session row');
    }
    const dead = randomUUID();
    const lastHeartbeatMs = (await redisTimeMs(h.redis)) - 5_000;
    await h.redis
      .multi()
      .zadd(redisKeys.instances, lastHeartbeatMs, dead)
      .sadd(redisKeys.userSockets(user.userId), `${dead}:socket-1`)
      .sadd(redisKeys.instanceSockets(dead), `${user.userId}:socket-1`)
      .exec();

    // This run, or a scheduled one just before it: either way step 1 ran first.
    await h.runtime.reconciler.run({ schemaVersion: 1, trigger: 'recovery', correlationId: 'o' });
    expect(await h.redis.zscore(redisKeys.instances, dead)).toBeNull();
    expect(await h.runtime.focusSessionLifecycle.markers.read(user.userId)).toEqual({
      sessionId: row.id,
      disconnectedAtMs: lastHeartbeatMs,
      evidence: 'detected',
    });
    const [after] = await h.db.select().from(focusSessions).where(eq(focusSessions.id, row.id));
    expect(after?.status).toBe('in_progress');
  });

  it('only worker roles get the trigger', async () => {
    const api = await createRuntime(configFor(requireHarness(), { ...TIMINGS, ROLE: 'api' }));
    try {
      await api.start({ port: 0, host: '127.0.0.1' });
      expect(api.reconcileTrigger).toBeUndefined();
      expect(requireHarness().runtime.reconcileTrigger).toBeDefined();
    } finally {
      await api.stop();
    }
  });
});
