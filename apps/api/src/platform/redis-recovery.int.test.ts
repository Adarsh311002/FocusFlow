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
// recovery after data loss, and revocation decisions surviving Redis data loss (R-2).

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

const sidOf = async (user: TestUser): Promise<string> => {
  const [session] = await requireHarness()
    .db.select({ id: authSessions.id })
    .from(authSessions)
    .where(eq(authSessions.userId, user.userId));
  if (session === undefined) {
    throw new Error('no auth session for the test user');
  }
  return session.id;
};

/**
 * Revokes a user's (only) session exactly as logout does: PostgreSQL, then the Redis
 * marker — or, with `writeMarker: false`, as a logout whose marker write failed.
 */
const revoke = async (
  user: TestUser,
  { writeMarker = true }: { writeMarker?: boolean } = {},
): Promise<void> => {
  const h = requireHarness();
  const sid = await sidOf(user);
  await revokeAuthSession(h.db, sid);
  if (writeMarker) {
    await markSessionRevoked(h.redis, sid, h.config.ACCESS_TOKEN_TTL_SECONDS, h.authDeps.logger);
  }
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

describe('revocation: a missing Redis marker is never proof (review finding R-2)', () => {
  /** Ages the epoch past one access-token lifetime: what R3 used to treat as "trusted". */
  const ageEpoch = async (): Promise<void> => {
    const h = requireHarness();
    const epoch = parseEpoch(await h.redis.get(redisKeys.epoch));
    if (epoch === undefined) {
      throw new Error('expected an epoch');
    }
    const windowMs = h.config.ACCESS_TOKEN_TTL_SECONDS * 1_000;
    await h.redis.set(
      redisKeys.epoch,
      formatEpoch({ id: epoch.id, createdAtMs: epoch.createdAtMs - windowMs - 1_000 }),
    );
  };

  it('refuses a session revoked in PostgreSQL whose marker was never written, however old the epoch', async () => {
    const h = requireHarness();
    const revoked = await signUpTestUser(h, 'unmarked');
    const active = await signUpTestUser(h, 'active');
    // The revocation commits in PostgreSQL, but the marker write fails (simulated by
    // never writing it) while Redis keeps its data and its long-lived epoch.
    await revoke(revoked, { writeMarker: false });
    await ageEpoch();
    expect(await h.redis.exists(`auth:revoked:${await sidOf(revoked)}`)).toBe(0);

    expect(await getMe(revoked)).toEqual({ status: 401, code: 'SESSION_REVOKED' });
    expect((await getMe(active)).status).toBe(200);
  });

  it('refuses a revoked session after Redis loses its data, before and after recovery', async () => {
    const h = requireHarness();
    const revoked = await signUpTestUser(h, 'revoked');
    const active = await signUpTestUser(h, 'active');
    await revoke(revoked);

    // Normal operation: the Redis marker rejects the revoked session.
    expect(await getMe(revoked)).toEqual({ status: 401, code: 'SESSION_REVOKED' });
    expect((await getMe(active)).status).toBe(200);

    // Redis loses its data and recovery has not run yet (heartbeats stopped, so nothing
    // recreates the epoch): the marker is gone, and PostgreSQL decides.
    await h.runtime.heartbeat.stop();
    for (const extra of h.extraInstances) {
      await extra.runtime.heartbeat.stop();
    }
    try {
      await h.redis.flushall();
      expect(await h.redis.get(redisKeys.epoch)).toBeNull();

      expect(await getMe(revoked)).toEqual({ status: 401, code: 'SESSION_REVOKED' });
      expect((await getMe(active)).status).toBe(200);

      // Recovery recreates the epoch; its age no longer matters for revocation, even
      // once it is older than one access-token lifetime.
      const result = await h.runtime.epoch.check('tick');
      expect(result.created).toBe(true);
      expect(await getMe(revoked)).toEqual({ status: 401, code: 'SESSION_REVOKED' });
      await ageEpoch();
      expect(await getMe(revoked)).toEqual({ status: 401, code: 'SESSION_REVOKED' });
      expect((await getMe(active)).status).toBe(200);

      // Revocations made after the loss are marked in the new cache and apply at once.
      const lateRevoked = await signUpTestUser(h, 'late');
      await revoke(lateRevoked);
      expect(await getMe(lateRevoked)).toEqual({ status: 401, code: 'SESSION_REVOKED' });
    } finally {
      await h.runtime.heartbeat.start();
      for (const extra of h.extraInstances) {
        await extra.runtime.heartbeat.start();
      }
    }
  });
});
