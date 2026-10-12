import {
  API_BASE_PATH,
  focusSessionIdSchema,
  focusSessionPath,
  focusSessionPaths,
  focusSessionResponseSchema,
  type FocusSessionView,
} from '@focus-flow/contracts';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startTestHarness, stopTestHarness, type TestHarness } from '../../../test/harness.js';
import { closeAllSockets, connectSocket } from '../../../test/sockets.js';
import { signUpTestUser, type TestUser } from '../../../test/users.js';
import { focusSessions } from '../../db/schema.js';
import { parseEpoch } from '../../platform/epoch.js';
import { redisTimeMs } from '../../platform/redis.js';
import { redisKeys } from '../../platform/redis-keys.js';
import type { FocusSessionChange } from './changes.js';

// The presence-recovery window after a Redis data loss (E17, E18, E21) against the
// real runtime, PostgreSQL and Redis: a real FLUSHALL, the real epoch monitor re-creating
// the epoch, real sockets re-added by each instance's sync, and the real API. The window is
// INSTANCE_TTL_MS (here 5 s, with a 200 ms heartbeat).

const WINDOW_MS = 5_000;

let harness: TestHarness | undefined;

const requireHarness = (): TestHarness => {
  if (harness === undefined) {
    throw new Error('the API harness failed to start');
  }
  return harness;
};

type ApiResult = { status: number; body: unknown };

const call = async (user: TestUser, path: string, body?: unknown): Promise<ApiResult> => {
  const response = await fetch(`${requireHarness().baseUrl}${API_BASE_PATH}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${user.accessToken}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text.length === 0 ? undefined : JSON.parse(text) };
};

const sessionOf = (result: ApiResult): FocusSessionView =>
  focusSessionResponseSchema.parse(result.body).session;

const start = (user: TestUser) => call(user, focusSessionPaths.collection, { plannedSeconds: 60 });

const action = (user: TestUser, verb: 'pause' | 'resume' | 'stop', sessionId: string) =>
  call(user, focusSessionPath(focusSessionPaths[verb], focusSessionIdSchema.parse(sessionId)));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (condition: () => Promise<boolean>, timeoutMs = 8_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition().catch(() => false)) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error('condition not met in time');
    }
    await sleep(50);
  }
};

const redisNow = () => redisTimeMs(requireHarness().redis);

const connect = async (user: TestUser) => {
  const h = requireHarness();
  const socket = await connectSocket(h.baseUrl, user.accessToken);
  await waitFor(() => h.runtime.presence.isUserOnline(user.userId));
  return socket;
};

/** A connected user's 60-second session whose planned end passed two minutes ago. */
const pastPlannedEnd = async (name: string) => {
  const h = requireHarness();
  const user = await signUpTestUser(h, name);
  const socket = await connect(user);
  const session = sessionOf(await start(user));
  const shift = sql`make_interval(secs => ${180})`;
  await h.db
    .update(focusSessions)
    .set({
      startedAt: sql`${focusSessions.startedAt} - ${shift}`,
      runningSince: sql`${focusSessions.runningSince} - ${shift}`,
    })
    .where(eq(focusSessions.id, session.id));
  return { user, socket, session, plannedEndMs: Date.parse(session.startedAt) - 120_000 };
};

const rowOf = async (sessionId: string) => {
  const [row] = await requireHarness()
    .db.select()
    .from(focusSessions)
    .where(eq(focusSessions.id, sessionId));
  return row;
};

const cleanups: (() => void)[] = [];

/** Every after-commit change for one user while the test runs. */
const recordChanges = (userId: string): FocusSessionChange[] => {
  const changes: FocusSessionChange[] = [];
  cleanups.push(
    requireHarness().runtime.focusSessionChanges.subscribe((change) => {
      if (change.userId === userId) {
        changes.push(change);
      }
    }),
  );
  return changes;
};

/**
 * FLUSHALL, then waits for the runtime to create the new epoch (heartbeat → epoch check)
 * and for `online` users to be re-added by its sync. Returns the new epoch's creation time.
 */
const loseRedisData = async (online: readonly TestUser[]): Promise<number> => {
  const h = requireHarness();
  await h.redis.flushall();
  let createdAtMs: number | undefined;
  await waitFor(async () => {
    createdAtMs = parseEpoch(await h.redis.get(redisKeys.epoch))?.createdAtMs;
    return createdAtMs !== undefined;
  });
  for (const user of online) {
    await waitFor(() => h.runtime.presence.isUserOnline(user.userId));
  }
  if (createdAtMs === undefined) {
    throw new Error('no epoch');
  }
  return createdAtMs;
};

/** Fails the test if the window ended before `step` finished: its assertions would be void. */
const insideWindow = async <T>(epochCreatedAtMs: number, step: () => Promise<T>): Promise<T> => {
  const result = await step();
  expect(await redisNow()).toBeLessThan(epochCreatedAtMs + WINDOW_MS);
  return result;
};

const afterWindow = async (epochCreatedAtMs: number): Promise<void> => {
  await waitFor(async () => (await redisNow()) >= epochCreatedAtMs + WINDOW_MS, 15_000);
};

beforeAll(async () => {
  harness = await startTestHarness(
    { INSTANCE_HEARTBEAT_MS: '200', INSTANCE_TTL_MS: String(WINDOW_MS) },
    // Redis kept its data for a week before each test's FLUSHALL.
    { epochAgeMs: 7 * 86_400_000 },
  );
}, 180_000);

// Each test starts with trusted presence: after the window of the previous test's loss.
beforeEach(async () => {
  const h = requireHarness();
  await waitFor(async () => {
    const createdAtMs = parseEpoch(await h.redis.get(redisKeys.epoch))?.createdAtMs;
    return createdAtMs !== undefined && (await redisNow()) >= createdAtMs + WINDOW_MS;
  }, 15_000);
});

afterEach(() => {
  closeAllSockets();
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

afterAll(async () => {
  if (harness !== undefined) {
    await stopTestHarness(harness);
  }
}, 60_000);

describe('the presence check reads the epoch atomically (E17)', () => {
  it('reports the epoch stored with the presence it read, and the new one after a loss', async () => {
    const h = requireHarness();
    const user = await signUpTestUser(h, 'atomic');
    await connect(user);
    const before = parseEpoch(await h.redis.get(redisKeys.epoch))?.createdAtMs;
    expect((await h.runtime.presence.checkUser(user.userId)).epochCreatedAtMs).toBe(before);

    const createdAtMs = await loseRedisData([user]);
    const check = await h.runtime.presence.checkUser(user.userId);
    expect(check.epochCreatedAtMs).toBe(createdAtMs);
    expect(check.epochCreatedAtMs).not.toBe(before);
  });
});

describe('pause or stop at or after T_end across the recovery window (E18, E8, E9)', () => {
  it('online, no E8 evidence: deferred inside the window, abandoned(expired) after it', async () => {
    const { user, session } = await pastPlannedEnd('online-loss');
    const changes = recordChanges(user.userId);
    const createdAtMs = await loseRedisData([user]);

    await insideWindow(createdAtMs, async () => {
      for (const verb of ['pause', 'stop'] as const) {
        expect((await action(user, verb, session.id)).status).toBe(503);
      }
      expect(await rowOf(session.id)).toMatchObject({ status: 'in_progress' });
      expect((await rowOf(session.id))?.runningSince).not.toBeNull();
    });

    await afterWindow(createdAtMs);
    // The stop settles it — or finds it already expired by the retried end job (E11).
    const result = await action(user, 'stop', session.id);
    expect(result.status).toBe(200);
    expect(sessionOf(result)).toMatchObject({ status: 'abandoned', abandonReason: 'expired' });
    expect(await rowOf(session.id)).toMatchObject({ abandonReason: 'expired', focusedSeconds: 0 });
    expect(changes.map((change) => change.transition)).toEqual(['expired']);
  });

  it('offline, no marker left: deferred inside the window, abandoned(expired) after it', async () => {
    const { user, socket, session } = await pastPlannedEnd('offline-loss');
    socket.disconnect();
    await waitFor(async () => !(await requireHarness().runtime.presence.isUserOnline(user.userId)));
    const changes = recordChanges(user.userId);
    // The loss also drops the disconnect marker the offline hint recorded.
    const createdAtMs = await loseRedisData([]);

    await insideWindow(createdAtMs, async () => {
      expect((await action(user, 'pause', session.id)).status).toBe(503);
    });
    expect(await rowOf(session.id)).toMatchObject({ status: 'in_progress' });

    await afterWindow(createdAtMs);
    const result = await action(user, 'pause', session.id);
    expect(sessionOf(result)).toMatchObject({ status: 'abandoned', abandonReason: 'expired' });
    expect(changes.map((change) => change.transition)).toEqual(['expired']);
  });

  it('observed evidence through the end recorded inside the window completes (E8)', async () => {
    const { user, socket, session, plannedEndMs } = await pastPlannedEnd('evidence');
    const changes = recordChanges(user.userId);
    const createdAtMs = await loseRedisData([user]);

    await insideWindow(createdAtMs, async () => {
      // The user's socket goes away now, after T_end: an observed disconnect through the end.
      socket.disconnect();
      await waitFor(
        async () =>
          (await requireHarness().runtime.focusSessionLifecycle.markers.read(user.userId))
            ?.evidence === 'observed',
      );
      const result = await action(user, 'pause', session.id);
      expect(result.status).toBe(200);
      expect(sessionOf(result)).toMatchObject({ status: 'completed', focusedSeconds: 60 });
    });
    expect((await rowOf(session.id))?.endedAt?.getTime()).toBe(plannedEndMs);
    expect(changes.map((change) => change.transition)).toEqual(['completed']);
  });
});

describe('start and resume across the recovery window (E21)', () => {
  it('answer 503 inside the window without changing anything, and work after it', async () => {
    const h = requireHarness();
    const starter = await signUpTestUser(h, 'starter');
    await connect(starter);
    const resumer = await signUpTestUser(h, 'resumer');
    await connect(resumer);
    const paused = sessionOf(await start(resumer));
    expect((await action(resumer, 'pause', paused.id)).status).toBe(200);
    const createdAtMs = await loseRedisData([starter, resumer]);

    await insideWindow(createdAtMs, async () => {
      expect((await start(starter)).status).toBe(503);
      expect((await action(resumer, 'resume', paused.id)).status).toBe(503);
    });
    expect(
      await h.db.select().from(focusSessions).where(eq(focusSessions.userId, starter.userId)),
    ).toEqual([]);
    expect(await rowOf(paused.id)).toMatchObject({ status: 'in_progress', runningSince: null });

    await afterWindow(createdAtMs);
    expect((await start(starter)).status).toBe(201);
    const resumed = await action(resumer, 'resume', paused.id);
    expect(resumed.status).toBe(200);
    expect(sessionOf(resumed).status).toBe('in_progress');
    expect((await rowOf(paused.id))?.runningSince).not.toBeNull();
  });

  it('a user who is really not connected still gets 409 once presence is trusted', async () => {
    const h = requireHarness();
    const user = await signUpTestUser(h, 'absent');
    const createdAtMs = await loseRedisData([]);
    await insideWindow(createdAtMs, async () => {
      expect((await start(user)).status).toBe(503);
    });
    await afterWindow(createdAtMs);
    expect((await start(user)).status).toBe(409);
  });
});
