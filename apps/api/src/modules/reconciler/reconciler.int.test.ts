import { RECONCILE_JOB, type ReconcileJob } from '@focus-flow/contracts';
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
import { RECONCILE_SCHEDULER_ID } from '../../platform/queues.js';
import { redisKeys } from '../../platform/redis-keys.js';
import { createRuntime } from '../../platform/runtime.js';

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
      runtime.presence.onUserOffline((userId, reason) => {
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

    await waitFor(async () => (await userEntries(user.userId)).length === 1);
    expect(await userEntries(user.userId)).toEqual([
      `${h.runtime.instanceId}:${String(socket.id)}`,
    ]);
    expect(await h.redis.zscore(redisKeys.instances, h.runtime.instanceId)).not.toBeNull();
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
