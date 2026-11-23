import {
  API_BASE_PATH,
  focusSessionIdSchema,
  focusSessionPath,
  focusSessionPaths,
  focusSessionResponseSchema,
  type FocusSessionView,
} from '@focus-flow/contracts';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { startTestHarness, stopTestHarness, type TestHarness } from '../../../test/harness.js';
import { closeAllSockets, connectSocket } from '../../../test/sockets.js';
import { signUpTestUser, type TestUser } from '../../../test/users.js';
import { focusSessions } from '../../db/schema.js';
import { redisTimeMs } from '../../platform/redis.js';
import { soloEndJobId, soloGraceJobId } from './jobs.js';
import type { FocusSessionScheduler } from './lifecycle.js';
import { handleUserOnline } from './presence-hints.js';

// The Solo Focus lifecycle end to end (Phase 4B Milestone 3): real sockets drive the
// presence hints, the runtime's own worker runs the end and grace jobs, and the grace is
// shortened to 1.5 s (FOCUS_GRACE_MS) so it can run its course in a test.

const GRACE_MS = 1_500;

let harness: TestHarness | undefined;

const requireHarness = (): TestHarness => {
  if (harness === undefined) {
    throw new Error('the harness failed to start');
  }
  return harness;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (condition: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> => {
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

const call = async (user: TestUser, path: string, body?: unknown) => {
  const response = await fetch(`${requireHarness().baseUrl}${API_BASE_PATH}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${user.accessToken}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return focusSessionResponseSchema.parse(await response.json()).session;
};

const start = (user: TestUser, plannedSeconds = 1_500) =>
  call(user, focusSessionPaths.collection, { plannedSeconds });

const act = (user: TestUser, verb: 'pause' | 'resume' | 'stop', session: FocusSessionView) =>
  call(user, focusSessionPath(focusSessionPaths[verb], focusSessionIdSchema.parse(session.id)));

const isOnline = (userId: string) => requireHarness().runtime.presence.isUserOnline(userId);

/** A signed-up user with one live socket, confirmed online. */
const connectedUser = async () => {
  const h = requireHarness();
  const user = await signUpTestUser(h, 'lifecycle');
  const socket = await connectSocket(h.baseUrl, user.accessToken);
  await waitFor(() => isOnline(user.userId));
  return { user, socket };
};

const row = async (sessionId: string) => {
  const [found] = await requireHarness()
    .db.select()
    .from(focusSessions)
    .where(eq(focusSessions.id, sessionId));
  return found;
};

const markerOf = (userId: string) =>
  requireHarness().runtime.focusSessionLifecycle.markers.read(userId);

/** Moves a session's stored timestamps `ms` into the past. */
const travelBack = async (sessionId: string, ms: number) => {
  const shift = sql`make_interval(secs => ${ms / 1_000})`;
  await requireHarness()
    .db.update(focusSessions)
    .set({
      startedAt: sql`${focusSessions.startedAt} - ${shift}`,
      runningSince: sql`${focusSessions.runningSince} - ${shift}`,
    })
    .where(eq(focusSessions.id, sessionId));
};

beforeAll(async () => {
  harness = await startTestHarness(
    {
      INSTANCE_HEARTBEAT_MS: '200',
      INSTANCE_TTL_MS: '2000',
      FOCUS_GRACE_MS: String(GRACE_MS),
    },
    // Redis kept its data for a week: sessions moved minutes into the past saw no loss (E9).
    { epochAgeMs: 7 * 86_400_000 },
  );
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

describe('disconnect while running', () => {
  it('records an observed disconnect, and the grace job abandons the session when it expires', async () => {
    const { user, socket } = await connectedUser();
    const session = await start(user);
    const before = await redisTimeMs(requireHarness().redis);

    socket.disconnect();
    await waitFor(async () => (await markerOf(user.userId)) !== undefined);
    const recorded = await markerOf(user.userId);
    expect(recorded).toMatchObject({ sessionId: session.id, evidence: 'observed' });
    expect(recorded?.disconnectedAtMs).toBeGreaterThanOrEqual(before);

    await waitFor(async () => (await row(session.id))?.status === 'abandoned');
    const settled = await row(session.id);
    expect(settled?.abandonReason).toBe('grace_expired');
    expect(settled?.endedAt?.getTime()).toBe(recorded?.disconnectedAtMs);
    // The settlement's follow-up clears the session's own marker.
    await waitFor(async () => (await markerOf(user.userId)) === undefined);
  });

  it('a reconnect within the grace clears the marker and the session keeps running', async () => {
    const h = requireHarness();
    const { user, socket } = await connectedUser();
    const session = await start(user);

    socket.disconnect();
    await waitFor(async () => (await markerOf(user.userId)) !== undefined);
    await connectSocket(h.baseUrl, user.accessToken);
    await waitFor(async () => (await markerOf(user.userId)) === undefined);

    await sleep(GRACE_MS + 1_000);
    expect((await row(session.id))?.status).toBe('in_progress');
  });

  it('a paused session gets no marker and no grace (D14/15/35)', async () => {
    const { user, socket } = await connectedUser();
    const session = await start(user);
    await act(user, 'pause', session);

    socket.disconnect();
    await waitFor(async () => !(await isOnline(user.userId)));
    await sleep(GRACE_MS + 500);
    expect(await markerOf(user.userId)).toBeUndefined();
    expect(await row(session.id)).toMatchObject({ status: 'in_progress', runningSince: null });
  });
});

describe('end jobs', () => {
  it('start and resume schedule an end job for their own stretch', async () => {
    const { user } = await connectedUser();
    const queue = requireHarness().runtime.focusSessionLifecycle.queue;
    const session = await start(user);
    const startedStretch = Date.parse(
      session.status === 'in_progress' && session.runningSince !== null ? session.runningSince : '',
    );
    await waitFor(
      async () => (await queue.getJob(soloEndJobId(session.id, startedStretch))) !== undefined,
    );

    await act(user, 'pause', session);
    const resumed = await act(user, 'resume', session);
    const resumedStretch = Date.parse(
      resumed.status === 'in_progress' && resumed.runningSince !== null ? resumed.runningSince : '',
    );
    expect(resumedStretch).toBeGreaterThan(startedStretch);
    await waitFor(
      async () => (await queue.getJob(soloEndJobId(session.id, resumedStretch))) !== undefined,
    );
  });

  it('the worker completes a connected user’s session at T_end', async () => {
    const { user } = await connectedUser();
    const session = await start(user, 60);
    await travelBack(session.id, 2 * 60_000);
    const moved = await row(session.id);
    const runningSinceMs = moved?.runningSince?.getTime() ?? 0;

    await requireHarness().runtime.focusSessionLifecycle.scheduler.scheduleEnd({
      sessionId: session.id,
      userId: user.userId,
      runningSinceMs,
      plannedEndMs: runningSinceMs + 60_000,
    });

    await waitFor(async () => (await row(session.id))?.status === 'completed');
    const completed = await row(session.id);
    expect(completed?.focusedSeconds).toBe(60);
    expect(completed?.endedAt?.getTime()).toBe(runningSinceMs + 60_000);
  });

  it('a reconnect after T_end keeps the marker; its late grace job completes at T_end (E16)', async () => {
    const h = requireHarness();
    const { user } = await connectedUser();
    const session = await start(user, 60);
    await travelBack(session.id, 5 * 60_000);
    const moved = await row(session.id);
    const runningSinceMs = moved?.runningSince?.getTime() ?? 0;
    const disconnectedAtMs = runningSinceMs + 30_000;
    // A disconnect before the end whose reconnect was never recorded (the online hint was
    // lost), and whose grace job never ran.
    await h.runtime.focusSessionLifecycle.markers.record(
      user.userId,
      { sessionId: session.id, disconnectedAtMs, evidence: 'detected' },
      runningSinceMs,
    );

    // A new socket raises the online hint: the marker stays, the grace job of exactly that
    // disconnect runs (its grace is long over) and applies E16.
    await connectSocket(h.baseUrl, user.accessToken);
    await waitFor(async () => (await row(session.id))?.status === 'completed', 10_000);
    const completed = await row(session.id);
    expect(completed?.endedAt?.getTime()).toBe(runningSinceMs + 60_000);
    expect(completed?.focusedSeconds).toBe(completed?.plannedSeconds);
    // The grace job settled it: the job finishes after its commit and follow-ups.
    const graceJobOf = () =>
      h.runtime.focusSessionLifecycle.queue.getJob(soloGraceJobId(session.id, disconnectedAtMs));
    await waitFor(async () => (await (await graceJobOf())?.getState()) === 'completed');
    expect((await graceJobOf())?.returnvalue).toEqual({ kind: 'settled', transition: 'completed' });
    await waitFor(async () => (await markerOf(user.userId)) === undefined);
  });

  it('stopping a session clears its marker but never another session’s', async () => {
    const { user, socket } = await connectedUser();
    const first = await start(user);
    socket.disconnect();
    await waitFor(async () => (await markerOf(user.userId)) !== undefined);

    // Reconnect, stop: the stop's follow-up clears the first session's marker.
    await connectSocket(requireHarness().baseUrl, user.accessToken);
    await waitFor(() => isOnline(user.userId));
    await act(user, 'stop', first);
    await waitFor(async () => (await markerOf(user.userId)) === undefined);

    // The next session's marker survives a late clear for the first session.
    const second = await start(user);
    await requireHarness().runtime.focusSessionLifecycle.markers.record(
      user.userId,
      { sessionId: second.id, disconnectedAtMs: Date.now(), evidence: 'observed' },
      Date.parse(second.startedAt),
    );
    expect(
      await requireHarness().runtime.focusSessionLifecycle.markers.clear(user.userId, {
        kind: 'session',
        sessionId: first.id,
      }),
    ).toBe(false);
    expect((await markerOf(user.userId))?.sessionId).toBe(second.id);
  });
});

describe('the online hint (E8, E10, E16)', () => {
  /** The hint against the real database, marker and presence, with jobs only recorded. */
  const hintWith = () => {
    const h = requireHarness();
    const ends: unknown[] = [];
    const graces: unknown[] = [];
    const scheduler: FocusSessionScheduler = {
      scheduleEnd: (job) => {
        ends.push(job);
        return Promise.resolve();
      },
      scheduleGrace: (job) => {
        graces.push(job);
        return Promise.resolve();
      },
    };
    const deps = {
      db: h.db,
      markers: h.runtime.focusSessionLifecycle.markers,
      checkUser: h.runtime.presence.checkUser,
      scheduler,
      graceMs: GRACE_MS,
    };
    return { ends, graces, run: (userId: string) => handleUserOnline(deps, userId) };
  };

  const recordDisconnect = (
    userId: string,
    sessionId: string,
    disconnectedAtMs: number,
    R: number,
  ) =>
    requireHarness().runtime.focusSessionLifecycle.markers.record(
      userId,
      { sessionId, disconnectedAtMs, evidence: 'detected' },
      R,
    );

  it('before T_end, a reconnect inside the grace clears the marker', async () => {
    const { user } = await connectedUser();
    const session = await start(user);
    const R = (await row(session.id))?.runningSince?.getTime() ?? 0;
    await recordDisconnect(user.userId, session.id, await redisTimeMs(requireHarness().redis), R);

    const hint = hintWith();
    await hint.run(user.userId);
    expect(await markerOf(user.userId)).toBeUndefined();
    expect(hint.graces).toEqual([]);
    expect(hint.ends).toEqual([]);
  });

  it('before T_end, a reconnect after the grace ran out keeps the marker and ensures its grace job', async () => {
    const { user } = await connectedUser();
    const session = await start(user);
    await travelBack(session.id, 60_000);
    const R = (await row(session.id))?.runningSince?.getTime() ?? 0;
    await recordDisconnect(user.userId, session.id, R + 1_000, R);

    const hint = hintWith();
    await hint.run(user.userId);
    expect(await markerOf(user.userId)).toMatchObject({ disconnectedAtMs: R + 1_000 });
    expect(hint.graces).toEqual([
      { sessionId: session.id, userId: user.userId, disconnectedAtMs: R + 1_000 },
    ]);
    expect(hint.ends).toEqual([]);
  });

  it('after T_end, never clears the marker: ensures its grace job and an end decision', async () => {
    const { user } = await connectedUser();
    const session = await start(user, 60);
    await travelBack(session.id, 5 * 60_000);
    const R = (await row(session.id))?.runningSince?.getTime() ?? 0;
    // Recorded after T_end and still inside its grace, or before T_end: both stay.
    for (const disconnectedAtMs of [await redisTimeMs(requireHarness().redis), R + 30_000]) {
      await requireHarness().runtime.focusSessionLifecycle.markers.clear(user.userId, {
        kind: 'session',
        sessionId: session.id,
      });
      await recordDisconnect(user.userId, session.id, disconnectedAtMs, R);

      const hint = hintWith();
      await hint.run(user.userId);
      expect(await markerOf(user.userId)).toMatchObject({ disconnectedAtMs });
      expect(hint.graces).toEqual([
        { sessionId: session.id, userId: user.userId, disconnectedAtMs },
      ]);
      expect(hint.ends).toHaveLength(1);
    }
  });
});
