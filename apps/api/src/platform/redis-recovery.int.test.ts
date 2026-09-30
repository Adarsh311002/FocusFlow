import { API_BASE_PATH, errorBodySchema, mePaths } from '@focus-flow/contracts';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  startInstance,
  startTestHarness,
  stopTestHarness,
  type TestHarness,
} from '../../test/harness.js';
import { signUpTestUser, type TestUser } from '../../test/users.js';
import { authSessions } from '../db/schema.js';
import { revokeAuthSession } from '../modules/auth/queries.js';
import { markSessionRevoked } from '../modules/auth/revocation.js';
import { formatEpoch, parseEpoch } from './epoch.js';
import { redisTimeMs } from './redis.js';
import { redisKeys } from './redis-keys.js';

// Phase 3 Redis coordination against a real Redis: the epoch, instance heartbeats,
// recovery after data loss, and the revocation trust-loss window (approved security fix).

const HEARTBEAT_MS = 200;

let harness: TestHarness | undefined;

const requireHarness = (): TestHarness => {
  if (harness === undefined) {
    throw new Error('the API harness failed to start');
  }
  return harness;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls until `condition` holds. A probe that throws counts as "not yet": the probes use
 * the application's own Redis client, which fails fast (by design) while it reconnects.
 */
const waitFor = async (condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  const holds = async (): Promise<boolean> => {
    try {
      return await condition();
    } catch {
      return false;
    }
  };
  while (!(await holds())) {
    if (Date.now() > deadline) {
      throw new Error('condition not met in time');
    }
    await sleep(50);
  }
};

const readEpoch = () => requireHarness().redis.get(redisKeys.epoch);

const heartbeatScore = (instanceId: string) =>
  requireHarness().redis.zscore(redisKeys.instances, instanceId);

const getMe = async (user: TestUser): Promise<{ status: number; code?: string }> => {
  const response = await fetch(`${requireHarness().baseUrl}${API_BASE_PATH}${mePaths.self}`, {
    headers: { Authorization: `Bearer ${user.accessToken}` },
  });
  const body: unknown = await response.json();
  const parsed = errorBodySchema.safeParse(body);
  return parsed.success
    ? { status: response.status, code: parsed.data.error.code }
    : { status: response.status };
};

/** Revokes a user's (only) session exactly as logout does: PostgreSQL, then Redis. */
const revoke = async (user: TestUser): Promise<void> => {
  const h = requireHarness();
  const [session] = await h.db
    .select({ id: authSessions.id })
    .from(authSessions)
    .where(eq(authSessions.userId, user.userId));
  if (session === undefined) {
    throw new Error('no auth session for the test user');
  }
  await revokeAuthSession(h.db, session.id);
  await markSessionRevoked(
    h.redis,
    session.id,
    h.config.ACCESS_TOKEN_TTL_SECONDS,
    h.authDeps.logger,
  );
};

beforeAll(async () => {
  harness = await startTestHarness({
    INSTANCE_HEARTBEAT_MS: String(HEARTBEAT_MS),
    INSTANCE_TTL_MS: '1000',
  });
}, 120_000);

afterAll(async () => {
  if (harness !== undefined) {
    await stopTestHarness(harness);
  }
}, 60_000);

describe('epoch', () => {
  it('is established at startup, stamped with Redis TIME', async () => {
    const epoch = parseEpoch(await readEpoch());
    const redisNow = await redisTimeMs(requireHarness().redis);

    expect(epoch).toBeDefined();
    expect(epoch?.createdAtMs).toBeLessThanOrEqual(redisNow);
    expect(requireHarness().runtime.epoch.known()).toBe(await readEpoch());
  });
});

describe('instance heartbeat', () => {
  it('scores this instance by Redis TIME and keeps refreshing it', async () => {
    const { instanceId } = requireHarness().runtime;
    const first = Number(await heartbeatScore(instanceId));

    await sleep(HEARTBEAT_MS * 3);
    const later = Number(await heartbeatScore(instanceId));
    const redisNow = await redisTimeMs(requireHarness().redis);

    expect(later).toBeGreaterThan(first);
    expect(redisNow - later).toBeLessThan(HEARTBEAT_MS * 3);
  });
});

describe('Redis data loss (FLUSHALL)', () => {
  it('recreates the epoch on exactly one instance and re-publishes every heartbeat', async () => {
    const h = requireHarness();
    const second = await startInstance(h, {
      INSTANCE_HEARTBEAT_MS: String(HEARTBEAT_MS),
      INSTANCE_TTL_MS: '1000',
    });
    const counts = { global: 0, local: 0 };
    for (const runtime of [h.runtime, second.runtime]) {
      runtime.epoch.onGlobalRecovery(() => {
        counts.global += 1;
      });
      runtime.epoch.onLocalRecovery(() => {
        counts.local += 1;
      });
    }
    const before = await readEpoch();

    await h.redis.flushall();

    await waitFor(async () => {
      const current = await readEpoch();
      return (
        current !== null &&
        current !== before &&
        h.runtime.epoch.known() === current &&
        second.runtime.epoch.known() === current
      );
    });
    // An instance records the new epoch before running its recovery hooks, so wait for
    // the hooks themselves.
    await waitFor(() => Promise.resolve(counts.local === 2));
    await waitFor(
      async () =>
        (await heartbeatScore(h.runtime.instanceId)) !== null &&
        (await heartbeatScore(second.runtime.instanceId)) !== null,
    );

    // One SET NX winner ran global recovery; both instances saw the change and re-asserted
    // their own state.
    expect(counts.global).toBe(1);
    expect(counts.local).toBe(2);
    expect(parseEpoch(await readEpoch())).toBeDefined();
  });
});

describe('Redis reconnect (restart with data kept)', () => {
  it('keeps the epoch and re-publishes the heartbeat when the connection comes back', async () => {
    const h = requireHarness();
    const epochBefore = await readEpoch();
    const killer = new Redis(h.redisContainer.getConnectionUrl());
    try {
      await h.redis.zrem(redisKeys.instances, h.runtime.instanceId);
      // Drop every client connection, as a Redis restart would; ioredis reconnects.
      await killer.call('CLIENT', 'KILL', 'TYPE', 'normal');
    } finally {
      killer.disconnect();
    }

    await waitFor(async () => (await heartbeatScore(h.runtime.instanceId)) !== null);
    expect(await readEpoch()).toBe(epochBefore);
  });
});

describe('revocation trust-loss window (approved security fix)', () => {
  it('never trusts an emptied revocation cache for one access-token lifetime', async () => {
    const h = requireHarness();
    const revoked = await signUpTestUser(h, 'revoked');
    const active = await signUpTestUser(h, 'active');
    await revoke(revoked);

    // Normal operation: the Redis marker rejects the revoked session.
    expect(await getMe(revoked)).toEqual({ status: 401, code: 'SESSION_REVOKED' });
    expect((await getMe(active)).status).toBe(200);

    // Redis loses its data and recovery has not run yet (heartbeat stopped, so nothing
    // recreates the epoch): the marker is gone, but the missing epoch sends the check to
    // PostgreSQL, which still knows the session is revoked.
    await h.runtime.heartbeat.stop();
    for (const extra of h.extraInstances) {
      await extra.runtime.heartbeat.stop();
    }
    await h.redis.flushall();
    expect(await h.redis.get(redisKeys.epoch)).toBeNull();

    expect(await getMe(revoked)).toEqual({ status: 401, code: 'SESSION_REVOKED' });
    expect((await getMe(active)).status).toBe(200);

    // Recovery recreates the epoch. Inside the window PostgreSQL still decides.
    const result = await h.runtime.epoch.check('tick');
    expect(result.created).toBe(true);
    expect(await getMe(revoked)).toEqual({ status: 401, code: 'SESSION_REVOKED' });
    expect((await getMe(active)).status).toBe(200);

    // Revocations made after the loss are in the new cache and apply immediately.
    const lateRevoked = await signUpTestUser(h, 'late');
    await revoke(lateRevoked);
    expect(await getMe(lateRevoked)).toEqual({ status: 401, code: 'SESSION_REVOKED' });

    // Once the epoch is one access-token lifetime old, Redis answers alone again. The
    // `revoked` user's token is accepted here only because this test ages the epoch
    // without waiting 15 minutes: in reality that token, issued before the loss, has
    // expired by then, which is exactly why one token lifetime is the window.
    const epoch = parseEpoch(await h.redis.get(redisKeys.epoch));
    if (epoch === undefined) {
      throw new Error('expected an epoch');
    }
    const windowMs = h.config.ACCESS_TOKEN_TTL_SECONDS * 1_000;
    await h.redis.set(
      redisKeys.epoch,
      formatEpoch({ id: epoch.id, createdAtMs: epoch.createdAtMs - windowMs - 1_000 }),
    );
    expect((await getMe(revoked)).status).toBe(200);
    expect(await getMe(lateRevoked)).toEqual({ status: 401, code: 'SESSION_REVOKED' });
    expect((await getMe(active)).status).toBe(200);

    await h.runtime.heartbeat.start();
  });
});
