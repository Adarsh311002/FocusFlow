import { randomUUID } from 'node:crypto';

import {
  API_BASE_PATH,
  focusSessionPaths,
  focusSessionResponseSchema,
  soloEndJobSchema,
  soloGraceJobSchema,
} from '@focus-flow/contracts';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { startTestHarness, stopTestHarness, type TestHarness } from '../../../test/harness.js';
import { closeAllSockets, connectSocket } from '../../../test/sockets.js';
import { signUpTestUser } from '../../../test/users.js';
import { focusSessions } from '../../db/schema.js';
import { formatEpoch } from '../../platform/epoch.js';
import { redisTimeMs } from '../../platform/redis.js';
import { redisKeys } from '../../platform/redis-keys.js';
import type { FocusSessionChange } from './changes.js';
import { CLOCK_SKEW_TOLERANCE_MS, type DisconnectMarker } from './decision.js';
import {
  type LifecycleDeps,
  reconcileRunningSession,
  runSoloEndJob,
  runSoloGraceJob,
} from './lifecycle.js';
import type { DisconnectMarkerStore } from './marker-store.js';
import { pauseFocusSession, stopFocusSession } from './service.js';
import type { DecisionSnapshot } from './snapshot.js';

// The decision's atomic Redis snapshot (E8, E10, E17) against the real runtime: real
// sockets, the real presence store, the real offline handler writing the real marker, real
// PostgreSQL row locks. Deterministic barriers put a socket disconnect at the two orders
// that matter:
//   A. the marker is written after the decision locked the row but before its snapshot:
//      the snapshot sees it, and E8 decides;
//   B. the snapshot is taken after the socket was removed but before the marker is
//      written: the snapshot has no evidence, and none is invented afterwards;
// and C. the snapshot fails while the marker can still be read: E8 still decides.
// The epoch is set directly (as if Redis had been re-created at that instant) to place a
// definite Redis loss inside the running stretch (E9). ROLE=api: no worker or reconciler
// of the runtime decides these sessions; only the tests do.

const SWEEP_TIMEOUT_MS = 5_000;

let harness: TestHarness | undefined;

const requireHarness = (): TestHarness => {
  if (harness === undefined) {
    throw new Error('the API harness failed to start');
  }
  return harness;
};

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
    await sleep(25);
  }
};

const markers = (): DisconnectMarkerStore => requireHarness().runtime.focusSessionLifecycle.markers;

const rowOf = async (sessionId: string) => {
  const [row] = await requireHarness()
    .db.select()
    .from(focusSessions)
    .where(eq(focusSessions.id, sessionId));
  return row;
};

/** A one-shot latch. */
const latch = () => {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
};

const cleanups: (() => void)[] = [];

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

/** Sets the epoch's creation time and waits until the runtime has taken it in. */
const setEpoch = async (createdAtMs: number): Promise<void> => {
  const h = requireHarness();
  const value = formatEpoch({ id: randomUUID(), createdAtMs });
  await h.redis.set(redisKeys.epoch, value);
  // The runtime treats a new epoch as a Redis loss and re-syncs its sockets: let that finish
  // before the test disconnects anything.
  await waitFor(() => Promise.resolve(h.runtime.epoch.known() === value));
  await h.runtime.presence.syncLocal();
};

/**
 * A connected user's 60-second running session whose planned end passed two minutes ago,
 * with the epoch either long before the stretch (`loss: false`) or inside it, after the
 * presence-recovery window (`loss: true`, a definite Redis loss, E9).
 */
const pastPlannedEnd = async (name: string, { loss }: { readonly loss: boolean }) => {
  const h = requireHarness();
  await setEpoch((await redisTimeMs(h.redis)) - 7 * 86_400_000);
  const user = await signUpTestUser(h, name);
  const socket = await connectSocket(h.baseUrl, user.accessToken);
  await waitFor(() => h.runtime.presence.isUserOnline(user.userId));
  const response = await fetch(`${h.baseUrl}${API_BASE_PATH}${focusSessionPaths.collection}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${user.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ plannedSeconds: 60 }),
  });
  expect(response.status).toBe(201);
  const { session } = focusSessionResponseSchema.parse(await response.json());
  const shift = sql`make_interval(secs => ${180})`;
  await h.db
    .update(focusSessions)
    .set({
      startedAt: sql`${focusSessions.startedAt} - ${shift}`,
      runningSince: sql`${focusSessions.runningSince} - ${shift}`,
    })
    .where(eq(focusSessions.id, session.id));
  const row = await rowOf(session.id);
  const runningSinceMs = row?.runningSince?.getTime();
  if (runningSinceMs === undefined) {
    throw new Error('not running');
  }
  if (loss) {
    // Created 10 s into the stretch (> R + tolerance), 170 s ago: outside the window.
    await setEpoch(runningSinceMs + 10_000);
    expect(runningSinceMs + 10_000).toBeGreaterThan(runningSinceMs + CLOCK_SKEW_TOLERANCE_MS);
  }
  return {
    user,
    socket,
    sessionId: session.id,
    runningSinceMs,
    plannedEndMs: runningSinceMs + 60_000,
    changes: recordChanges(user.userId),
  };
};

type Running = Awaited<ReturnType<typeof pastPlannedEnd>>;

/** The runtime's own lifecycle dependencies, with the decision snapshot replaceable. */
const lifecycleDeps = (
  snapshotUser?: (userId: string) => Promise<DecisionSnapshot>,
  markerStore: Pick<DisconnectMarkerStore, 'read'> = markers(),
): LifecycleDeps => {
  const h = requireHarness();
  return {
    db: h.db,
    checkUser: h.runtime.presence.checkUser,
    snapshotUser: snapshotUser ?? h.runtime.focusSessionLifecycle.snapshotUser,
    presenceRecoveryMs: h.config.INSTANCE_TTL_MS,
    markers: { ...markers(), read: (userId) => markerStore.read(userId) },
    graceMs: h.config.FOCUS_GRACE_MS,
    scheduler: h.runtime.focusSessionLifecycle.scheduler,
    changes: h.runtime.focusSessionChanges,
  };
};

/** The real snapshot, run once after `before` — by the first decision to reach it. */
const snapshotAfter = (before: () => Promise<void>) => {
  let first = true;
  return async (userId: string): Promise<DecisionSnapshot> => {
    if (first) {
      first = false;
      await before();
    }
    return requireHarness().runtime.focusSessionLifecycle.snapshotUser(userId);
  };
};

/** Disconnects the user's socket and waits for the real offline handler's observed marker. */
const disconnectAndAwaitMarker = async (s: Running): Promise<DisconnectMarker> => {
  s.socket.disconnect();
  let marker: DisconnectMarker | undefined;
  await waitFor(async () => {
    marker = await markers().read(s.user.userId);
    return marker?.sessionId === s.sessionId && marker.evidence === 'observed';
  });
  if (marker === undefined) {
    throw new Error('no marker');
  }
  return marker;
};

type Decider = 'end job' | 'reconciler' | 'pause' | 'stop';

const decide = (deps: LifecycleDeps, s: Running, decider: Decider): Promise<unknown> => {
  switch (decider) {
    case 'end job':
      return runSoloEndJob(
        deps,
        soloEndJobSchema.parse({
          schemaVersion: 1,
          sessionId: s.sessionId,
          userId: s.user.userId,
          runningSinceMs: s.runningSinceMs,
        }),
      );
    case 'reconciler':
      return reconcileRunningSession(
        deps,
        { id: s.sessionId, userId: s.user.userId },
        SWEEP_TIMEOUT_MS,
      );
    case 'pause':
      return pauseFocusSession(deps, s.user.userId, s.sessionId);
    case 'stop':
      return stopFocusSession(deps, s.user.userId, s.sessionId);
  }
};

const DECIDERS: readonly Decider[] = ['end job', 'reconciler', 'pause', 'stop'];

/** Every decider once more, after the outcome: none may change it or publish again. */
const decideAgain = async (s: Running, graceAtMs?: number) => {
  const deps = lifecycleDeps();
  for (const decider of DECIDERS) {
    await decide(deps, s, decider);
  }
  if (graceAtMs !== undefined) {
    await runSoloGraceJob(
      deps,
      soloGraceJobSchema.parse({
        schemaVersion: 1,
        sessionId: s.sessionId,
        userId: s.user.userId,
        disconnectedAtMs: graceAtMs,
      }),
    );
  }
};

const expectCompletedAtPlannedEnd = async (s: Running) => {
  expect(await rowOf(s.sessionId)).toMatchObject({
    status: 'completed',
    focusedSeconds: 60,
    plannedSeconds: 60,
    runningSince: null,
  });
  expect((await rowOf(s.sessionId))?.endedAt?.getTime()).toBe(s.plannedEndMs);
  expect(s.changes.map((change) => change.transition)).toEqual(['completed']);
};

beforeAll(async () => {
  harness = await startTestHarness(
    { ROLE: 'api', INSTANCE_HEARTBEAT_MS: '200', INSTANCE_TTL_MS: '5000' },
    { epochAgeMs: 7 * 86_400_000 },
  );
}, 180_000);

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

describe('the snapshot reads the marker with presence and the epoch (E17)', () => {
  it('returns the stored marker, and none for a missing or malformed value', async () => {
    const h = requireHarness();
    const snapshot = h.runtime.focusSessionLifecycle.snapshotUser;
    const userId = randomUUID();
    const marker: DisconnectMarker = {
      sessionId: randomUUID(),
      disconnectedAtMs: 1_000,
      evidence: 'observed',
    };
    expect((await snapshot(userId)).marker).toBeUndefined();
    await markers().record(userId, marker, 0);
    const read = await snapshot(userId);
    expect(read.marker).toEqual(marker);
    expect(read.presence).toMatchObject({ online: false });
    expect(read.presence.epochCreatedAtMs).toBeDefined();
    await h.redis.set(redisKeys.userDisconnected(userId), 'not-a-marker');
    expect((await snapshot(userId)).marker).toBeUndefined();
    await h.redis.del(redisKeys.userDisconnected(userId));
  });
});

describe('A: the marker is written after the row lock, before the snapshot (E8 over E9)', () => {
  for (const decider of DECIDERS) {
    it(`${decider}: the snapshot sees the observed disconnect and completes at T_end`, async () => {
      const s = await pastPlannedEnd(`a-${decider.replace(' ', '-')}`, { loss: true });
      let written: DisconnectMarker | undefined;
      const deps = lifecycleDeps(
        snapshotAfter(async () => {
          // The row is locked by this decision now; the disconnect handler never waits for it.
          written = await disconnectAndAwaitMarker(s);
        }),
      );

      await decide(deps, s, decider);

      expect(written?.disconnectedAtMs).toBeGreaterThanOrEqual(s.plannedEndMs);
      await expectCompletedAtPlannedEnd(s);
      await decideAgain(s, written?.disconnectedAtMs);
      await expectCompletedAtPlannedEnd(s);
    });
  }

  it('every decider at once, repeatedly: one completion, one event', async () => {
    for (let round = 0; round < 3; round += 1) {
      const s = await pastPlannedEnd(`a-all-${String(round)}`, { loss: true });
      const deps = lifecycleDeps(
        snapshotAfter(async () => {
          await disconnectAndAwaitMarker(s);
        }),
      );
      await Promise.all([...DECIDERS, ...DECIDERS].map((decider) => decide(deps, s, decider)));
      await expectCompletedAtPlannedEnd(s);
    }
  });
});

describe('B: the snapshot is taken after the socket was removed, before the marker is written', () => {
  /**
   * Holds the runtime's offline handler just before it records `userId`'s observed marker
   * (the socket entry is already removed), until `release` is called; `written` resolves
   * once that record has been applied.
   */
  const holdMarkerWrite = (userId: string) => {
    const store = markers() as { record: DisconnectMarkerStore['record'] };
    const original = store.record;
    const reached = latch();
    const released = latch();
    const written = latch();
    store.record = async (target, incoming, runningSinceMs) => {
      const held = target === userId && incoming.evidence === 'observed';
      if (held) {
        reached.open();
        await released.opened;
      }
      const result = await original(target, incoming, runningSinceMs);
      if (held) {
        written.open();
      }
      return result;
    };
    cleanups.push(() => {
      store.record = original;
    });
    return { reached: reached.opened, release: released.open, written: written.opened };
  };

  it('a definite loss: abandoned(expired), and the later observed marker changes nothing', async () => {
    const s = await pastPlannedEnd('b-loss', { loss: true });
    const held = holdMarkerWrite(s.user.userId);
    s.socket.disconnect();
    await held.reached;
    expect(await requireHarness().runtime.presence.isUserOnline(s.user.userId)).toBe(false);

    const outcome = await decide(lifecycleDeps(), s, 'end job');
    expect(outcome).toEqual({ kind: 'settled', transition: 'expired' });

    held.release();
    let marker: DisconnectMarker | undefined;
    await waitFor(async () => {
      marker = await markers().read(s.user.userId);
      return marker?.evidence === 'observed';
    });
    // The disconnect was through the end, but it was not recorded when the decision read
    // Redis: it is not evidence for that decision, and nothing re-decides an ended session.
    expect(marker?.disconnectedAtMs).toBeGreaterThanOrEqual(s.plannedEndMs);
    await decideAgain(s, marker?.disconnectedAtMs);
    expect(await rowOf(s.sessionId)).toMatchObject({
      status: 'abandoned',
      abandonReason: 'expired',
    });
    expect(s.changes.map((change) => change.transition)).toEqual(['expired']);
  });

  it('no loss: late grace from the snapshot; the older observed disconnect does not replace it', async () => {
    const s = await pastPlannedEnd('b-no-loss', { loss: false });
    const held = holdMarkerWrite(s.user.userId);
    s.socket.disconnect();
    await held.reached;

    const outcome = await decide(lifecycleDeps(), s, 'end job');
    expect(outcome).toEqual({ kind: 'late_grace' });
    const detected = await markers().read(s.user.userId);
    expect(detected).toMatchObject({ sessionId: s.sessionId, evidence: 'detected' });

    held.release();
    await held.written;
    // The handler's observed disconnect is older than the detected one: kept out (E10).
    expect(await markers().read(s.user.userId)).toEqual(detected);
    expect(s.changes).toEqual([]);

    // Its grace job (run with the grace over) ends it through grace — never a completion.
    const graceDeps = { ...lifecycleDeps(), graceMs: 1 };
    await runSoloGraceJob(
      graceDeps,
      soloGraceJobSchema.parse({
        schemaVersion: 1,
        sessionId: s.sessionId,
        userId: s.user.userId,
        disconnectedAtMs: detected?.disconnectedAtMs,
      }),
    );
    expect(await rowOf(s.sessionId)).toMatchObject({
      status: 'abandoned',
      abandonReason: 'grace_expired',
    });
    expect((await rowOf(s.sessionId))?.endedAt?.getTime()).toBe(s.plannedEndMs);
    await decideAgain(s);
    expect(s.changes.map((change) => change.transition)).toEqual(['grace_expired']);
  });
});

describe('C: the snapshot fails, the marker alone can still be read (E8)', () => {
  const failingSnapshot = () => Promise.reject(new Error('the presence read failed'));

  for (const decider of DECIDERS) {
    it(`${decider}: observed evidence through the end completes`, async () => {
      const s = await pastPlannedEnd(`c-${decider.replace(' ', '-')}`, { loss: true });
      const marker = await disconnectAndAwaitMarker(s);
      await decide(lifecycleDeps(failingSnapshot), s, decider);
      await expectCompletedAtPlannedEnd(s);
      await decideAgain(s, marker.disconnectedAtMs);
      await expectCompletedAtPlannedEnd(s);
    });
  }

  it('without qualifying evidence, nothing is decided (retry, deferred, 503)', async () => {
    const s = await pastPlannedEnd('c-none', { loss: true });
    const deps = lifecycleDeps(failingSnapshot);
    await expect(decide(deps, s, 'end job')).rejects.toThrow();
    expect(await decide(deps, s, 'reconciler')).toEqual({
      kind: 'deferred',
      reason: 'presence_unknown',
    });
    await expect(decide(deps, s, 'pause')).rejects.toMatchObject({ status: 503 });
    expect(await rowOf(s.sessionId)).toMatchObject({ status: 'in_progress' });
    expect(s.changes).toEqual([]);
  });

  it('the marker cannot be read either: nothing is decided', async () => {
    const s = await pastPlannedEnd('c-unreadable', { loss: false });
    await disconnectAndAwaitMarker(s);
    const deps = lifecycleDeps(failingSnapshot, {
      read: () => Promise.reject(new Error('the marker read failed')),
    });
    await expect(decide(deps, s, 'end job')).rejects.toThrow();
    expect(await decide(deps, s, 'reconciler')).toEqual({
      kind: 'deferred',
      reason: 'marker_unknown',
    });
    await expect(decide(deps, s, 'stop')).rejects.toMatchObject({ status: 503 });
    expect(await rowOf(s.sessionId)).toMatchObject({ status: 'in_progress' });
    expect(s.changes).toEqual([]);
  });
});
