import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { startTestHarness, stopTestHarness, type TestHarness } from '../../../test/harness.js';
import { createFakeLive, createStubLogger } from '../../../test/rooms.js';
import { signUpTestUser, type TestUser } from '../../../test/users.js';
import { focusSessions, roomMembers, tasks } from '../../db/schema.js';
import { AppError } from '../../platform/http/errors.js';
import { createFocusSessionChanges } from '../focus-sessions/changes.js';
import { listInProgressSessionKeys } from '../focus-sessions/queries.js';
import {
  pauseFocusSession,
  resumeFocusSession,
  stopFocusSession,
} from '../focus-sessions/service.js';
import { sweepStaleSessions } from '../focus-sessions/sweep.js';
import type { TimerState } from '../room-timer/types.js';
import { generateRoomCode } from '../rooms/code.js';
import { insertMembershipIfAbsent, insertRoom } from '../rooms/queries.js';
import { removeMember } from '../rooms/service.js';
import { createKit, type Kit } from './test-kit.js';

// The room focus service against real PostgreSQL (row locks, constraints, the partial unique
// index) with in-memory timer, ledger, presence and scheduler (test-kit.ts). Instants are the
// kit's fake Redis TIME, so every ordering below is explicit, never a sleep.

let harness: TestHarness | undefined;

const requireHarness = (): TestHarness => {
  if (harness === undefined) {
    throw new Error('the harness failed to start');
  }
  return harness;
};

beforeAll(async () => {
  harness = await startTestHarness();
}, 120_000);

afterAll(async () => {
  if (harness !== undefined) {
    await stopTestHarness(harness);
  }
});

const patchTimer = (kit: Kit, roomId: string, patch: Partial<TimerState>): void => {
  const state = kit.timers.get(roomId);
  if (state === undefined) {
    throw new Error('the room has no timer');
  }
  kit.timers.set(roomId, { ...state, ...patch });
};

type Fixture = { kit: Kit; roomId: string; host: TestUser; alice: TestUser; bob: TestUser };

/** A room with a host and two members, all present, a running focus phase 0 s in. */
const fixture = async (
  options: { durationMs?: number; elapsedMs?: number; present?: boolean } = {},
): Promise<Fixture & { runId: string }> => {
  const h = requireHarness();
  const [host, alice, bob] = await Promise.all([
    signUpTestUser(h, 'host'),
    signUpTestUser(h, 'alice'),
    signUpTestUser(h, 'bob'),
  ]);
  const room = await insertRoom(h.db, {
    id: uuidv7(),
    code: generateRoomCode(),
    name: 'Focus room',
    hostId: host.userId,
    isPrivate: false,
    focusSeconds: 1500,
    shortBreakSeconds: 300,
    longBreakSeconds: 900,
  });
  for (const user of [host, alice, bob]) {
    await insertMembershipIfAbsent(h.db, room.id, user.userId);
  }
  const kit = createKit(h.db);
  const runId = kit.startFocus(room.id, {
    ...(options.durationMs === undefined ? {} : { durationMs: options.durationMs }),
    ...(options.elapsedMs === undefined ? {} : { elapsedMs: options.elapsedMs }),
  });
  if (options.present !== false) {
    for (const user of [host, alice, bob]) {
      kit.setPresent(room.id, user.userId, true);
    }
  }
  return { kit, roomId: room.id, host, alice, bob, runId };
};

const rowsOf = (userId: string) =>
  requireHarness().db.select().from(focusSessions).where(eq(focusSessions.userId, userId));

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) {
      return error.code;
    }
    throw error;
  }
  return 'NO_ERROR';
};

describe('optIn', () => {
  it('creates a room session whose plan is the time left, and joins the ledger', async () => {
    const { kit, roomId, alice, runId } = await fixture({ elapsedMs: 300_000 });
    const { session, created } = await kit.service.optIn(alice.userId, roomId, undefined);

    expect(created).toBe(true);
    expect(session.status).toBe('in_progress');
    expect(session.plannedSeconds).toBe(1200);
    expect(session.focusedSeconds).toBe(0);
    expect(session.context).toEqual({ kind: 'room', roomId, focusRunId: runId });
    const [row] = await rowsOf(alice.userId);
    expect(row?.roomId).toBe(roomId);
    expect(row?.focusRunId).toBe(runId);
    expect(row?.runningSince).toBeNull();

    const [entry] = kit.participantsOf(roomId, runId);
    expect(entry).toMatchObject({
      userId: alice.userId,
      sessionId: session.id,
      elapsedAtOptInMs: 300_000,
      disconnectedAtMs: null,
    });
    expect(kit.changes.map((change) => change.kind)).toEqual(['participants', 'session']);
  });

  it('answers the snapshot and state with the participant', async () => {
    const { kit, roomId, alice, bob, runId } = await fixture();
    const { session } = await kit.service.optIn(alice.userId, roomId, undefined);

    const snap = await kit.service.snapshot(alice.userId, roomId);
    expect(snap.focusRunId).toBe(runId);
    expect(snap.participants.map((p) => p.userId)).toEqual([alice.userId]);
    expect(snap.participants[0]?.connected).toBe(true);
    expect(snap.me.participation?.sessionId).toBe(session.id);

    const others = await kit.service.snapshot(bob.userId, roomId);
    expect(others.me.participation).toBeNull();
    const state = await kit.service.state(alice.userId, roomId);
    expect(state.session?.id).toBe(session.id);
    expect((await kit.service.state(bob.userId, roomId)).session).toBeNull();
  });

  it('is idempotent: a repeat does not duplicate the row or the ledger entry', async () => {
    const { kit, roomId, alice, runId } = await fixture();
    const first = await kit.service.optIn(alice.userId, roomId, undefined);
    const second = await kit.service.optIn(alice.userId, roomId, undefined);

    expect(second.created).toBe(false);
    expect(second.session.id).toBe(first.session.id);
    expect(await rowsOf(alice.userId)).toHaveLength(1);
    expect(kit.participantsOf(roomId, runId)).toHaveLength(1);
  });

  it('rejects non-members with ROOM_NOT_FOUND and writes nothing', async () => {
    const { kit, roomId } = await fixture();
    const outsider = await signUpTestUser(requireHarness(), 'outsider');
    expect(await codeOf(kit.service.optIn(outsider.userId, roomId, undefined))).toBe(
      'ROOM_NOT_FOUND',
    );
    expect(await codeOf(kit.service.optIn(outsider.userId, uuidv7(), undefined))).toBe(
      'ROOM_NOT_FOUND',
    );
    expect(await rowsOf(outsider.userId)).toHaveLength(0);
  });

  it('requires presence in the room and a focus phase', async () => {
    const { kit, roomId, alice } = await fixture();
    kit.setPresent(roomId, alice.userId, false);
    expect(await codeOf(kit.service.optIn(alice.userId, roomId, undefined))).toBe('NOT_PRESENT');
    kit.setPresent(roomId, alice.userId, true);
    kit.closeRun(roomId, 'completed');
    expect(await codeOf(kit.service.optIn(alice.userId, roomId, undefined))).toBe(
      'NOT_FOCUS_PHASE',
    );
    expect(await rowsOf(alice.userId)).toHaveLength(0);
  });

  it('allows opting in while the timer is idle or paused', async () => {
    const idle = await fixture();
    patchTimer(idle.kit, idle.roomId, { status: 'idle', segmentStartedAtMs: null });
    expect((await idle.kit.service.optIn(idle.alice.userId, idle.roomId, undefined)).created).toBe(
      true,
    );
    const paused = await fixture({ elapsedMs: 600_000 });
    patchTimer(paused.kit, paused.roomId, { status: 'paused', segmentStartedAtMs: null });
    const { session } = await paused.kit.service.optIn(
      paused.alice.userId,
      paused.roomId,
      undefined,
    );
    expect(session.plannedSeconds).toBe(900);
  });

  it('answers RUN_ENDING and writes nothing when less than 60 s are left', async () => {
    const { kit, roomId, alice } = await fixture({ durationMs: 120_000 });
    patchTimer(kit, roomId, {
      status: 'paused',
      segmentStartedAtMs: null,
      elapsedBeforeMs: 90_000,
    });
    expect(await codeOf(kit.service.optIn(alice.userId, roomId, undefined))).toBe('RUN_ENDING');
    expect(await rowsOf(alice.userId)).toHaveLength(0);
  });

  it('refuses a second session: solo or in another room (the global one-session rule)', async () => {
    const one = await fixture();
    const { session } = await one.kit.service.optIn(one.alice.userId, one.roomId, undefined);

    // Another room, same user.
    const other = await fixture();
    const h = requireHarness();
    await insertMembershipIfAbsent(h.db, other.roomId, one.alice.userId);
    other.kit.setPresent(other.roomId, one.alice.userId, true);
    let details: unknown;
    try {
      await other.kit.service.optIn(one.alice.userId, other.roomId, undefined);
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      details = (error as AppError).details;
      expect((error as AppError).code).toBe('SESSION_IN_PROGRESS');
    }
    expect(details).toMatchObject({ session: { id: session.id } });
    expect(await rowsOf(one.alice.userId)).toHaveLength(1);
  });

  it('refuses a user who has a solo session in progress', async () => {
    const { kit, roomId, alice } = await fixture();
    await requireHarness().db.insert(focusSessions).values({
      id: uuidv7(),
      userId: alice.userId,
      status: 'in_progress',
      plannedSeconds: 600,
      focusedSeconds: 0,
      runningSince: new Date(),
      startedAt: new Date(),
    });
    expect(await codeOf(kit.service.optIn(alice.userId, roomId, undefined))).toBe(
      'SESSION_IN_PROGRESS',
    );
    expect(kit.participantsOf(roomId, kit.timers.get(roomId)?.focusRunId ?? '')).toHaveLength(0);
  });

  it('checks the task: own, not deleted, open', async () => {
    const { kit, roomId, alice, bob } = await fixture();
    const db = requireHarness().db;
    const mine = uuidv7();
    const done = uuidv7();
    const gone = uuidv7();
    const theirs = uuidv7();
    await db.insert(tasks).values([
      { id: mine, userId: alice.userId, title: 'Write' },
      { id: done, userId: alice.userId, title: 'Done', completedAt: new Date() },
      { id: gone, userId: alice.userId, title: 'Gone', deletedAt: new Date() },
      { id: theirs, userId: bob.userId, title: 'Bob task' },
    ]);
    expect(await codeOf(kit.service.optIn(alice.userId, roomId, theirs))).toBe('TASK_NOT_FOUND');
    expect(await codeOf(kit.service.optIn(alice.userId, roomId, gone))).toBe('TASK_NOT_FOUND');
    expect(await codeOf(kit.service.optIn(alice.userId, roomId, done))).toBe('TASK_NOT_OPEN');
    expect(await codeOf(kit.service.optIn(alice.userId, roomId, uuidv7()))).toBe('TASK_NOT_FOUND');
    expect(await rowsOf(alice.userId)).toHaveLength(0);

    const { session } = await kit.service.optIn(alice.userId, roomId, mine);
    expect(session.task).toEqual({ id: mine, title: 'Write', deleted: false });
  });

  it('deletes the row and answers RUN_CHANGED when the run changed before the ledger write', async () => {
    const { kit, roomId, alice, runId } = await fixture();
    kit.beforeAdd.run = () => {
      kit.closeRun(roomId, 'reset');
    };
    expect(await codeOf(kit.service.optIn(alice.userId, roomId, undefined))).toBe('RUN_CHANGED');
    expect(await rowsOf(alice.userId)).toHaveLength(0);
    expect(kit.participantsOf(roomId, runId)).toHaveLength(0);
    expect(kit.changes).toHaveLength(0);
  });

  it('keeps the row on a ledger failure and a retry repairs it without a duplicate', async () => {
    const { kit, roomId, alice, runId } = await fixture({ elapsedMs: 300_000 });
    kit.failures.addParticipant = 1;
    expect(await codeOf(kit.service.optIn(alice.userId, roomId, undefined))).toBe('INTERNAL');
    const [orphan] = await rowsOf(alice.userId);
    expect(orphan?.status).toBe('in_progress');
    expect(kit.participantsOf(roomId, runId)).toHaveLength(0);

    kit.clock.nowMs += 5_000;
    const { session, created } = await kit.service.optIn(alice.userId, roomId, undefined);
    expect(created).toBe(false);
    expect(session.id).toBe(orphan?.id);
    expect(await rowsOf(alice.userId)).toHaveLength(1);
    const [entry] = kit.participantsOf(roomId, runId);
    expect(entry?.sessionId).toBe(orphan?.id);
    // The opt-in's elapsed time is rebuilt from the plan: duration - planned.
    expect(entry?.elapsedAtOptInMs).toBe(300_000);
  });

  it('replaces a stale ledger entry left by an earlier ended session of the same run', async () => {
    const { kit, roomId, alice, runId } = await fixture();
    const first = await kit.service.optIn(alice.userId, roomId, undefined);
    // The session ends in PostgreSQL but the ledger cleanup was lost.
    await requireHarness()
      .db.update(focusSessions)
      .set({ status: 'abandoned', abandonReason: 'opted_out', endedAt: new Date() })
      .where(eq(focusSessions.id, first.session.id));
    const again = await kit.service.optIn(alice.userId, roomId, undefined);
    expect(again.created).toBe(true);
    expect(again.session.id).not.toBe(first.session.id);
    expect(kit.participantsOf(roomId, runId).map((p) => p.sessionId)).toEqual([again.session.id]);
  });

  it('records a disconnect that happened between the presence check and the ledger write', async () => {
    const { kit, roomId, alice, runId } = await fixture();
    kit.beforeAdd.run = () => {
      kit.setPresent(roomId, alice.userId, false);
    };
    await kit.service.optIn(alice.userId, roomId, undefined);
    const [entry] = kit.participantsOf(roomId, runId);
    expect(entry?.disconnectedAtMs).toBe(kit.clock.nowMs);
    expect(kit.graceCalls).toHaveLength(1);
  });
});

describe('opt out and departure', () => {
  it('optOut abandons with opted_out, counts the elapsed focus time and clears the ledger', async () => {
    const { kit, roomId, alice, runId } = await fixture({ elapsedMs: 100_000 });
    const { session } = await kit.service.optIn(alice.userId, roomId, undefined);
    kit.clock.nowMs += 90_500; // The running timer advances 90.5 s.

    const ended = await kit.service.optOut(alice.userId, roomId);
    expect(ended.session).toMatchObject({
      id: session.id,
      status: 'abandoned',
      abandonReason: 'opted_out',
      focusedSeconds: 90,
    });
    expect(kit.participantsOf(roomId, runId)).toHaveLength(0);
    const [row] = await rowsOf(alice.userId);
    expect(row?.endedAt).not.toBeNull();
    expect(kit.changes.at(-1)).toMatchObject({ kind: 'session', userId: alice.userId });

    // A repeat answers the same ended session and changes nothing.
    const repeat = await kit.service.optOut(alice.userId, roomId);
    expect(repeat.session?.id).toBe(session.id);
    expect(await rowsOf(alice.userId)).toHaveLength(1);
  });

  it('optOut with no participation ever answers null; a non-member gets ROOM_NOT_FOUND', async () => {
    const { kit, roomId, bob } = await fixture();
    expect((await kit.service.optOut(bob.userId, roomId)).session).toBeNull();
    const outsider = await signUpTestUser(requireHarness(), 'outsider');
    expect(await codeOf(kit.service.optOut(outsider.userId, roomId))).toBe('ROOM_NOT_FOUND');
  });

  it('depart with left_room and removed, idempotently; no participation is a no-op', async () => {
    const { kit, roomId, alice, bob } = await fixture();
    await kit.service.depart(alice.userId, roomId, 'left_room'); // No-op.
    expect(kit.changes).toHaveLength(0);

    await kit.service.optIn(alice.userId, roomId, undefined);
    await kit.service.optIn(bob.userId, roomId, undefined);
    await kit.service.depart(alice.userId, roomId, 'left_room');
    await kit.service.depart(alice.userId, roomId, 'left_room');
    await kit.service.depart(bob.userId, roomId, 'removed');
    const [a] = await rowsOf(alice.userId);
    const [b] = await rowsOf(bob.userId);
    expect(a).toMatchObject({ status: 'abandoned', abandonReason: 'left_room' });
    expect(b).toMatchObject({ status: 'abandoned', abandonReason: 'removed' });
  });

  it('counts 0 focused seconds but still ends the session when Redis is unreachable', async () => {
    const { kit, roomId, alice } = await fixture();
    await kit.service.optIn(alice.userId, roomId, undefined);
    kit.clock.nowMs += 60_000;
    kit.failures.ledgerRead = 1;
    await kit.service.depart(alice.userId, roomId, 'left_room');
    const [row] = await rowsOf(alice.userId);
    expect(row).toMatchObject({
      status: 'abandoned',
      abandonReason: 'left_room',
      focusedSeconds: 0,
    });
  });

  it('abandons in the membership-deleting transaction and rolls both back together', async () => {
    const { kit, roomId, host, alice } = await fixture();
    const h = requireHarness();
    await kit.service.optIn(alice.userId, roomId, undefined);
    const { logger } = createStubLogger();
    const live = createFakeLive();

    // A failing commit leaves the membership AND the session untouched.
    const failing = {
      beginDeparture: async (...args: Parameters<typeof kit.service.beginDeparture>) => {
        const plan = await kit.service.beginDeparture(...args);
        if (plan === undefined) return undefined;
        return {
          ...plan,
          commit: async (tx: Parameters<typeof plan.commit>[0]) => {
            await plan.commit(tx);
            throw new Error('boom after the abandon');
          },
        };
      },
    };
    await expect(
      removeMember({ db: h.db, live, logger, focus: failing }, host.userId, roomId, alice.userId),
    ).rejects.toThrow('boom after the abandon');
    expect(
      await h.db.select().from(roomMembers).where(eq(roomMembers.userId, alice.userId)),
    ).toHaveLength(1);
    expect((await rowsOf(alice.userId))[0]?.status).toBe('in_progress');

    // The real thing: both change, and the ledger is cleaned after the commit.
    await removeMember(
      { db: h.db, live, logger, focus: kit.service },
      host.userId,
      roomId,
      alice.userId,
    );
    expect(
      await h.db.select().from(roomMembers).where(eq(roomMembers.userId, alice.userId)),
    ).toHaveLength(0);
    expect((await rowsOf(alice.userId))[0]).toMatchObject({
      status: 'abandoned',
      abandonReason: 'removed',
    });
    expect(kit.participantsOf(roomId, kit.timers.get(roomId)?.focusRunId ?? '')).toHaveLength(0);
    expect(live.names()).toContain('announceMemberRemoved');
  });
});

describe('disconnect grace (RF7)', () => {
  const optedIn = async () => {
    const f = await fixture({ elapsedMs: 100_000 });
    const { session } = await f.kit.service.optIn(f.alice.userId, f.roomId, undefined);
    return { ...f, session };
  };

  it('records the disconnect once and ensures a 60 s grace job', async () => {
    const { kit, roomId, alice, runId } = await optedIn();
    kit.clock.nowMs += 40_000;
    kit.setPresent(roomId, alice.userId, false);
    await kit.service.userLeftRoom(alice.userId, roomId);
    await kit.service.userLeftRoom(alice.userId, roomId);

    const [entry] = kit.participantsOf(roomId, runId);
    expect(entry?.disconnectedAtMs).toBe(kit.clock.nowMs);
    expect(entry?.elapsedAtDisconnectMs).toBe(140_000);
    expect(kit.graceCalls[0]).toMatchObject({
      roomId,
      focusRunId: runId,
      userId: alice.userId,
      disconnectedAtMs: kit.clock.nowMs,
      delayMs: 60_000,
    });
    expect((await rowsOf(alice.userId))[0]?.status).toBe('in_progress');
    expect(kit.changes.filter((change) => change.kind === 'participants')).toHaveLength(2);
  });

  it('ignores the hint while another socket keeps the user present', async () => {
    const { kit, roomId, alice, runId } = await optedIn();
    await kit.service.userLeftRoom(alice.userId, roomId);
    expect(kit.participantsOf(roomId, runId)[0]?.disconnectedAtMs).toBeNull();
    expect(kit.graceCalls).toHaveLength(0);
  });

  it('ignores users without participation', async () => {
    const { kit, roomId, bob, runId } = await optedIn();
    kit.setPresent(roomId, bob.userId, false);
    await kit.service.userLeftRoom(bob.userId, roomId);
    expect(kit.participantsOf(roomId, runId)[0]?.disconnectedAtMs).toBeNull();
    expect(kit.graceCalls).toHaveLength(0);
  });

  it('a reconnect within the grace clears the disconnect and the job becomes stale', async () => {
    const { kit, roomId, alice, runId } = await optedIn();
    kit.setPresent(roomId, alice.userId, false);
    await kit.service.userLeftRoom(alice.userId, roomId);
    const disconnectedAtMs = kit.clock.nowMs;

    kit.clock.nowMs += 30_000;
    kit.setPresent(roomId, alice.userId, true);
    await kit.service.userJoinedRoom(alice.userId, roomId);
    expect(kit.participantsOf(roomId, runId)[0]?.disconnectedAtMs).toBeNull();

    kit.clock.nowMs += 40_000;
    expect(await kit.service.graceExpired(roomId, runId, alice.userId, disconnectedAtMs)).toBe(
      'stale',
    );
    expect((await rowsOf(alice.userId))[0]?.status).toBe('in_progress');
  });

  it('the grace job abandons with grace_expired, counted up to the disconnect', async () => {
    const { kit, roomId, alice, runId, session } = await optedIn();
    kit.clock.nowMs += 20_000; // elapsed 120 s at the disconnect.
    kit.setPresent(roomId, alice.userId, false);
    await kit.service.userLeftRoom(alice.userId, roomId);
    const disconnectedAtMs = kit.clock.nowMs;
    kit.clock.nowMs += 60_000;

    expect(await kit.service.graceExpired(roomId, runId, alice.userId, disconnectedAtMs)).toBe(
      'abandoned',
    );
    const [row] = await rowsOf(alice.userId);
    expect(row).toMatchObject({
      id: session.id,
      status: 'abandoned',
      abandonReason: 'grace_expired',
      focusedSeconds: 20,
    });
    expect(row?.endedAt?.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    expect(kit.participantsOf(roomId, runId)).toHaveLength(0);
    // A duplicate delivery changes nothing.
    expect(await kit.service.graceExpired(roomId, runId, alice.userId, disconnectedAtMs)).toBe(
      'stale',
    );
  });

  it('a job that finds the user present again treats it as a reconnect', async () => {
    const { kit, roomId, alice, runId } = await optedIn();
    kit.setPresent(roomId, alice.userId, false);
    await kit.service.userLeftRoom(alice.userId, roomId);
    const disconnectedAtMs = kit.clock.nowMs;
    kit.clock.nowMs += 60_000;
    kit.setPresent(roomId, alice.userId, true); // The join hint was lost.
    expect(await kit.service.graceExpired(roomId, runId, alice.userId, disconnectedAtMs)).toBe(
      'reconnected',
    );
    expect(kit.participantsOf(roomId, runId)[0]?.disconnectedAtMs).toBeNull();
  });

  it('an early job waits for the reconciler instead of abandoning', async () => {
    const { kit, roomId, alice, runId } = await optedIn();
    kit.setPresent(roomId, alice.userId, false);
    await kit.service.userLeftRoom(alice.userId, roomId);
    const disconnectedAtMs = kit.clock.nowMs;
    kit.clock.nowMs += 20_000;
    expect(await kit.service.graceExpired(roomId, runId, alice.userId, disconnectedAtMs)).toBe(
      'stale',
    );
    expect((await rowsOf(alice.userId))[0]?.status).toBe('in_progress');
  });

  it('a join after the grace does not revive the session', async () => {
    const { kit, roomId, alice } = await optedIn();
    kit.setPresent(roomId, alice.userId, false);
    await kit.service.userLeftRoom(alice.userId, roomId);
    kit.clock.nowMs += 62_000;
    kit.setPresent(roomId, alice.userId, true);
    await kit.service.userJoinedRoom(alice.userId, roomId);
    expect((await rowsOf(alice.userId))[0]).toMatchObject({
      status: 'abandoned',
      abandonReason: 'grace_expired',
    });
  });
});

describe('settleRun (RF3, RF6)', () => {
  it('completes connected participants of a run that ended normally', async () => {
    const { kit, roomId, alice, bob, runId } = await fixture();
    const a = await kit.service.optIn(alice.userId, roomId, undefined);
    await kit.service.optIn(bob.userId, roomId, undefined);
    kit.clock.nowMs += 1_500_000;
    kit.closeRun(roomId, 'completed');

    expect(await kit.service.settleRun(roomId, runId)).toBe('settled');
    const [row] = await rowsOf(alice.userId);
    expect(row).toMatchObject({
      id: a.session.id,
      status: 'completed',
      focusedSeconds: row?.plannedSeconds,
      abandonReason: null,
    });
    expect((await rowsOf(bob.userId))[0]?.status).toBe('completed');
    expect(kit.runs.size).toBe(0); // The run left Redis.
    expect(await kit.service.settleRun(roomId, runId)).toBe('gone'); // Idempotent.
    expect(kit.sessionViews().filter((view) => view.status === 'completed')).toHaveLength(2);
  });

  it('presence alone never creates a session: a present non-participant has no row after a run settles (D11)', async () => {
    const { kit, roomId, alice, bob, runId } = await fixture();
    await kit.service.optIn(alice.userId, roomId, undefined);
    await kit.service.userJoinedRoom(bob.userId, roomId);
    kit.clock.nowMs += 1_500_000;
    kit.closeRun(roomId, 'completed');

    expect(await kit.service.settleRun(roomId, runId)).toBe('settled');
    expect(await rowsOf(alice.userId)).toHaveLength(1);
    expect(await rowsOf(bob.userId)).toHaveLength(0);
  });

  it('abandons with the close reason for a reset or a phase change (D17)', async () => {
    for (const reason of ['reset', 'phase_changed'] as const) {
      const { kit, roomId, alice, runId } = await fixture({ elapsedMs: 60_000 });
      await kit.service.optIn(alice.userId, roomId, undefined);
      kit.clock.nowMs += 100_000; // elapsed 160 s at the close.
      kit.closeRun(roomId, reason);
      expect(await kit.service.settleRun(roomId, runId)).toBe('settled');
      expect((await rowsOf(alice.userId))[0]).toMatchObject({
        status: 'abandoned',
        abandonReason: reason,
        focusedSeconds: 100,
      });
    }
  });

  it('a disconnected participant waits for the grace, then it decides (D14, D35)', async () => {
    const { kit, roomId, alice, runId } = await fixture();
    await kit.service.optIn(alice.userId, roomId, undefined);
    kit.clock.nowMs += 600_000;
    kit.setPresent(roomId, alice.userId, false);
    await kit.service.userLeftRoom(alice.userId, roomId);
    const disconnectedAtMs = kit.clock.nowMs;
    kit.clock.nowMs += 10_000;
    kit.closeRun(roomId, 'completed');
    kit.graceCalls.length = 0;

    expect(await kit.service.settleRun(roomId, runId)).toBe('pending_grace');
    expect((await rowsOf(alice.userId))[0]?.status).toBe('in_progress');
    expect(kit.graceCalls[0]).toMatchObject({ disconnectedAtMs, delayMs: 50_000 });

    kit.clock.nowMs += 50_000;
    expect(await kit.service.graceExpired(roomId, runId, alice.userId, disconnectedAtMs)).toBe(
      'abandoned',
    );
    expect((await rowsOf(alice.userId))[0]).toMatchObject({
      status: 'abandoned',
      abandonReason: 'grace_expired',
      focusedSeconds: 600,
    });
    // The last participant's settlement finished the run, so there is nothing left to settle.
    expect(kit.runs.size).toBe(0);
    expect(await kit.service.settleRun(roomId, runId)).toBe('gone');
  });

  it('a reconnect within the grace after the close completes the session', async () => {
    const { kit, roomId, alice, runId } = await fixture();
    await kit.service.optIn(alice.userId, roomId, undefined);
    kit.clock.nowMs += 1_400_000;
    kit.setPresent(roomId, alice.userId, false);
    await kit.service.userLeftRoom(alice.userId, roomId);
    kit.clock.nowMs += 10_000;
    kit.closeRun(roomId, 'completed');
    expect(await kit.service.settleRun(roomId, runId)).toBe('pending_grace');

    kit.clock.nowMs += 20_000; // 30 s after the disconnect: inside the grace.
    kit.setPresent(roomId, alice.userId, true);
    await kit.service.userJoinedRoom(alice.userId, roomId);
    expect((await rowsOf(alice.userId))[0]?.status).toBe('completed');
  });

  it('a reconnect after the grace of a closed run is a grace_expired', async () => {
    const { kit, roomId, alice, runId } = await fixture();
    await kit.service.optIn(alice.userId, roomId, undefined);
    kit.setPresent(roomId, alice.userId, false);
    await kit.service.userLeftRoom(alice.userId, roomId);
    kit.clock.nowMs += 10_000;
    kit.closeRun(roomId, 'completed');
    expect(await kit.service.settleRun(roomId, runId)).toBe('pending_grace');

    kit.clock.nowMs += 52_000; // 62 s after the disconnect.
    kit.setPresent(roomId, alice.userId, true);
    await kit.service.userJoinedRoom(alice.userId, roomId);
    expect((await rowsOf(alice.userId))[0]).toMatchObject({
      status: 'abandoned',
      abandonReason: 'grace_expired',
    });
  });

  it('removes ledger entries whose session already ended and finishes the run', async () => {
    const { kit, roomId, alice, runId } = await fixture();
    const { session } = await kit.service.optIn(alice.userId, roomId, undefined);
    await requireHarness()
      .db.update(focusSessions)
      .set({ status: 'abandoned', abandonReason: 'opted_out', endedAt: new Date() })
      .where(eq(focusSessions.id, session.id));
    kit.closeRun(roomId, 'completed');
    expect(await kit.service.settleRun(roomId, runId)).toBe('settled');
    expect((await rowsOf(alice.userId))[0]?.abandonReason).toBe('opted_out');
  });

  it('concurrent settlements end a session exactly once', async () => {
    const { kit, roomId, alice, bob, runId } = await fixture();
    await kit.service.optIn(alice.userId, roomId, undefined);
    await kit.service.optIn(bob.userId, roomId, undefined);
    kit.closeRun(roomId, 'completed');
    const results = await Promise.all([
      kit.service.settleRun(roomId, runId),
      kit.service.settleRun(roomId, runId),
      kit.service.settleRun(roomId, runId),
    ]);
    expect(results).toContain('settled');
    expect(kit.sessionViews().filter((view) => view.status === 'completed')).toHaveLength(2);
    expect((await rowsOf(alice.userId))[0]?.status).toBe('completed');
  });
});

describe('solo isolation (RF11)', () => {
  it('pause, resume and stop on a room session answer NOT_SOLO_SESSION and change nothing', async () => {
    const { kit, roomId, alice } = await fixture();
    const { session } = await kit.service.optIn(alice.userId, roomId, undefined);
    const h = requireHarness();
    const deps = {
      db: h.db,
      checkUser: () => Promise.reject(new Error('not used')),
      snapshotUser: () => Promise.reject(new Error('not used')),
      presenceRecoveryMs: 30_000,
      markers: { read: () => Promise.resolve(undefined) },
      graceMs: 60_000,
      changes: createFocusSessionChanges(pino({ level: 'silent' })),
    };
    for (const action of [pauseFocusSession, resumeFocusSession, stopFocusSession]) {
      expect(await codeOf(action(deps, alice.userId, session.id))).toBe('NOT_SOLO_SESSION');
    }
    const [row] = await rowsOf(alice.userId);
    expect(row).toMatchObject({ status: 'in_progress', focusedSeconds: 0, runningSince: null });
  });

  it('solo sweeps and stale cleanup never see a room session', async () => {
    const { kit, roomId, alice } = await fixture();
    await kit.service.optIn(alice.userId, roomId, undefined);
    const h = requireHarness();
    const keys = await listInProgressSessionKeys(h.db, { afterUserId: null, limit: 1_000 });
    expect(keys.map((key) => key.userId)).not.toContain(alice.userId);
    // Even an ancient room session is not solo-stale.
    await h.db
      .update(focusSessions)
      .set({ startedAt: new Date(Date.now() - 48 * 3_600_000) })
      .where(eq(focusSessions.userId, alice.userId));
    const summary = await sweepStaleSessions({
      db: h.db,
      changes: createFocusSessionChanges(pino({ level: 'silent' })),
      logger: pino({ level: 'silent' }),
    });
    expect(summary.failed).toBe(0);
    expect((await rowsOf(alice.userId))[0]?.status).toBe('in_progress');
  });
});

describe('review fixes', () => {
  it('never deletes a repaired row when the run changed (Rev I M1)', async () => {
    const { kit, roomId, alice } = await fixture();
    kit.failures.addParticipant = 1;
    expect(await codeOf(kit.service.optIn(alice.userId, roomId, undefined))).toBe('INTERNAL');
    kit.beforeAdd.run = () => {
      kit.closeRun(roomId, 'reset');
    };
    expect(await codeOf(kit.service.optIn(alice.userId, roomId, undefined))).toBe('RUN_CHANGED');
    // The row stays: the closed run settles it (it is not this call's row to delete).
    expect((await rowsOf(alice.userId))[0]?.status).toBe('in_progress');
  });

  it('a departure planned before an opt-in commits still abandons it in the deleting transaction (Rev I M2)', async () => {
    const { kit, roomId, alice, runId } = await fixture();
    const h = requireHarness();
    const plan = await kit.service.beginDeparture(alice.userId, roomId, 'removed');
    expect(plan).toBeDefined();
    await kit.service.optIn(alice.userId, roomId, undefined);
    await h.db.transaction(async (tx) => {
      await tx.delete(roomMembers).where(eq(roomMembers.userId, alice.userId));
      await plan?.commit(tx);
    });
    await plan?.afterCommit();
    expect((await rowsOf(alice.userId))[0]).toMatchObject({
      status: 'abandoned',
      abandonReason: 'removed',
    });
    expect(kit.participantsOf(roomId, runId)).toHaveLength(0);
  });

  it('refuses to opt in once the membership is gone, even between the check and the insert (Rev I M2)', async () => {
    const { kit, roomId, alice } = await fixture();
    await requireHarness().db.delete(roomMembers).where(eq(roomMembers.userId, alice.userId));
    expect(await codeOf(kit.service.optIn(alice.userId, roomId, undefined))).toBe('ROOM_NOT_FOUND');
    expect(await rowsOf(alice.userId)).toHaveLength(0);
  });

  it('takes its ledger entry back and answers RUN_CHANGED when the session ended meanwhile (Rev J2)', async () => {
    const { kit, roomId, alice, runId } = await fixture();
    kit.afterAdd.run = async () => {
      await requireHarness()
        .db.update(focusSessions)
        .set({ status: 'abandoned', abandonReason: 'removed', endedAt: new Date() })
        .where(eq(focusSessions.userId, alice.userId));
    };
    expect(await codeOf(kit.service.optIn(alice.userId, roomId, undefined))).toBe('RUN_CHANGED');
    expect(kit.participantsOf(roomId, runId)).toHaveLength(0);
    expect(kit.sessionViews()).toHaveLength(0);
  });

  it('settles a closed earlier run of the same room before refusing a new opt-in (Rev J4)', async () => {
    const { kit, roomId, alice } = await fixture();
    const first = await kit.service.optIn(alice.userId, roomId, undefined);
    kit.closeRun(roomId, 'completed');
    kit.startFocus(roomId); // The next focus phase, a new run; the old run is still unsettled.
    const second = await kit.service.optIn(alice.userId, roomId, undefined);
    expect(second.created).toBe(true);
    expect(second.session.id).not.toBe(first.session.id);
    const sessions = await rowsOf(alice.userId);
    expect(sessions.find((row) => row.id === first.session.id)?.status).toBe('completed');
  });

  it('removes a lost run leftovers before answering gone (Rev J5)', async () => {
    const { kit, roomId } = await fixture();
    const finish = vi.spyOn(kit.ledger, 'finishRun');
    const unknownRun = uuidv7();
    expect(await kit.service.settleRun(roomId, unknownRun)).toBe('gone');
    expect(finish).toHaveBeenCalledWith(roomId, unknownRun);
  });

  it('a person who leaves after the run closed is settled by the close, not left waiting (Rev I L1)', async () => {
    const { kit, roomId, alice } = await fixture();
    await kit.service.optIn(alice.userId, roomId, undefined);
    kit.closeRun(roomId, 'completed');
    kit.setPresent(roomId, alice.userId, false);
    await kit.service.userLeftRoom(alice.userId, roomId);
    expect((await rowsOf(alice.userId))[0]?.status).toBe('completed');
    expect(kit.graceCalls).toHaveLength(0);
  });

  it('a grace job within the tolerance of the boundary settles a completed run (Rev J6)', async () => {
    const { kit, roomId, alice, runId } = await fixture();
    await kit.service.optIn(alice.userId, roomId, undefined);
    kit.setPresent(roomId, alice.userId, false);
    await kit.service.userLeftRoom(alice.userId, roomId);
    const disconnectedAtMs = kit.clock.nowMs;
    kit.clock.nowMs += 5_000;
    kit.closeRun(roomId, 'completed');
    expect(await kit.service.settleRun(roomId, runId)).toBe('pending_grace');
    kit.clock.nowMs += 54_500; // 59.5 s after the disconnect: inside the 1 s tolerance.
    expect(await kit.service.graceExpired(roomId, runId, alice.userId, disconnectedAtMs)).toBe(
      'abandoned',
    );
    expect((await rowsOf(alice.userId))[0]).toMatchObject({
      status: 'abandoned',
      abandonReason: 'grace_expired',
    });
  });

  describe('a late phase-end job (G3)', () => {
    /** Opted in at the run start; the phase really ended 1 500 s later. */
    const lateScenario = async () => {
      const f = await fixture();
      await f.kit.service.optIn(f.alice.userId, f.roomId, undefined);
      const trueEndMs = f.kit.clock.nowMs + 1_500_000;
      return { ...f, trueEndMs };
    };

    it('a disconnect between the true end and the late job completes at the true end', async () => {
      const { kit, roomId, alice, runId, trueEndMs } = await lateScenario();
      kit.clock.nowMs = trueEndMs + 5_000;
      kit.setPresent(roomId, alice.userId, false);
      await kit.service.userLeftRoom(alice.userId, roomId); // recorded in the still-open ledger
      const disconnectedAtMs = kit.clock.nowMs;
      expect(kit.participantsOf(roomId, runId)[0]?.disconnectedAtMs).toBe(disconnectedAtMs);

      kit.clock.nowMs = trueEndMs + 20_000; // the worker finally runs
      kit.closeRun(roomId, 'completed', { closedAtMs: trueEndMs });
      expect(await kit.service.settleRun(roomId, runId)).toBe('settled');
      const [row] = await rowsOf(alice.userId);
      expect(row).toMatchObject({
        status: 'completed',
        abandonReason: null,
        focusedSeconds: row?.plannedSeconds,
      });
      expect(kit.runs.size).toBe(0);
      // The grace job scheduled for that disconnect is a stale no-op afterwards.
      kit.clock.nowMs += 60_000;
      expect(await kit.service.graceExpired(roomId, runId, alice.userId, disconnectedAtMs)).toBe(
        'stale',
      );
    });

    it('the grace job of such a disconnect completes it if it fires before the settlement', async () => {
      const { kit, roomId, alice, runId, trueEndMs } = await lateScenario();
      kit.clock.nowMs = trueEndMs + 5_000;
      kit.setPresent(roomId, alice.userId, false);
      await kit.service.userLeftRoom(alice.userId, roomId);
      const disconnectedAtMs = kit.clock.nowMs;
      kit.clock.nowMs = trueEndMs + 10_000;
      kit.closeRun(roomId, 'completed', { closedAtMs: trueEndMs });

      kit.clock.nowMs = disconnectedAtMs + 60_000;
      expect(await kit.service.graceExpired(roomId, runId, alice.userId, disconnectedAtMs)).toBe(
        'completed',
      );
      expect((await rowsOf(alice.userId))[0]?.status).toBe('completed');
    });

    it('a disconnect before the true end still waits for the grace and then expires', async () => {
      const { kit, roomId, alice, runId, trueEndMs } = await lateScenario();
      kit.clock.nowMs = trueEndMs - 10_000;
      kit.setPresent(roomId, alice.userId, false);
      await kit.service.userLeftRoom(alice.userId, roomId);
      const disconnectedAtMs = kit.clock.nowMs;
      kit.clock.nowMs = trueEndMs + 20_000;
      kit.closeRun(roomId, 'completed', { closedAtMs: trueEndMs });

      expect(await kit.service.settleRun(roomId, runId)).toBe('pending_grace');
      kit.clock.nowMs = disconnectedAtMs + 60_000;
      expect(await kit.service.graceExpired(roomId, runId, alice.userId, disconnectedAtMs)).toBe(
        'abandoned',
      );
      expect((await rowsOf(alice.userId))[0]).toMatchObject({
        status: 'abandoned',
        abandonReason: 'grace_expired',
      });
    });

    it('the grace job runs before the delayed phase-end job: present at the true end completes', async () => {
      const { kit, roomId, alice, runId, trueEndMs } = await lateScenario();
      kit.clock.nowMs = trueEndMs + 5_000; // The timer is past its end; the run is still open.
      kit.setPresent(roomId, alice.userId, false);
      await kit.service.userLeftRoom(alice.userId, roomId);
      const disconnectedAtMs = kit.clock.nowMs;
      expect(kit.runs.get(`${roomId}:${runId}`)?.status).toBe('open');

      kit.clock.nowMs = disconnectedAtMs + 60_000; // The grace job fires first.
      expect(await kit.service.graceExpired(roomId, runId, alice.userId, disconnectedAtMs)).toBe(
        'completed',
      );
      const [row] = await rowsOf(alice.userId);
      expect(row).toMatchObject({
        status: 'completed',
        abandonReason: null,
        focusedSeconds: row?.plannedSeconds,
      });

      // The delayed phase-end job then closes the run: nothing is left to settle.
      kit.clock.nowMs += 1_000;
      kit.closeRun(roomId, 'completed', { closedAtMs: trueEndMs });
      expect(await kit.service.settleRun(roomId, runId)).toBe('settled');
      expect(await rowsOf(alice.userId)).toHaveLength(1);
      expect((await rowsOf(alice.userId))[0]?.status).toBe('completed');
      expect(await kit.service.graceExpired(roomId, runId, alice.userId, disconnectedAtMs)).toBe(
        'stale',
      );
    });

    it('a late reconnect after such a disconnect also completes (open run)', async () => {
      const { kit, roomId, alice, runId, trueEndMs } = await lateScenario();
      kit.clock.nowMs = trueEndMs + 5_000;
      kit.setPresent(roomId, alice.userId, false);
      await kit.service.userLeftRoom(alice.userId, roomId);
      const disconnectedAtMs = kit.clock.nowMs;
      kit.clock.nowMs = disconnectedAtMs + 62_000;
      kit.setPresent(roomId, alice.userId, true);
      expect(await kit.service.graceExpired(roomId, runId, alice.userId, disconnectedAtMs)).toBe(
        'completed',
      );
      expect((await rowsOf(alice.userId))[0]?.status).toBe('completed');
    });

    it('a disconnect strictly before the true end still expires through the open run', async () => {
      const { kit, roomId, alice, runId, trueEndMs } = await lateScenario();
      kit.clock.nowMs = trueEndMs - 70_000;
      kit.setPresent(roomId, alice.userId, false);
      await kit.service.userLeftRoom(alice.userId, roomId);
      const disconnectedAtMs = kit.clock.nowMs;
      kit.clock.nowMs = disconnectedAtMs + 60_000; // Before the end: the timer still runs.
      expect(await kit.service.graceExpired(roomId, runId, alice.userId, disconnectedAtMs)).toBe(
        'abandoned',
      );
      expect((await rowsOf(alice.userId))[0]).toMatchObject({
        status: 'abandoned',
        abandonReason: 'grace_expired',
      });
    });

    it('a disconnect while the timer is paused is never present at an end', async () => {
      const { kit, roomId, alice, runId, trueEndMs } = await lateScenario();
      const state = kit.timers.get(roomId);
      if (state === undefined) throw new Error('no timer');
      kit.timers.set(roomId, {
        ...state,
        status: 'paused',
        elapsedBeforeMs: 100_000,
        segmentStartedAtMs: null,
      });
      kit.clock.nowMs = trueEndMs + 5_000;
      kit.setPresent(roomId, alice.userId, false);
      await kit.service.userLeftRoom(alice.userId, roomId);
      const disconnectedAtMs = kit.clock.nowMs;
      kit.clock.nowMs = disconnectedAtMs + 60_000;
      expect(await kit.service.graceExpired(roomId, runId, alice.userId, disconnectedAtMs)).toBe(
        'abandoned',
      );
    });

    it('an unreadable timer is retried, never guessed', async () => {
      const { kit, roomId, alice, runId, trueEndMs } = await lateScenario();
      kit.clock.nowMs = trueEndMs + 5_000;
      kit.setPresent(roomId, alice.userId, false);
      await kit.service.userLeftRoom(alice.userId, roomId);
      const disconnectedAtMs = kit.clock.nowMs;
      kit.clock.nowMs = disconnectedAtMs + 60_000;
      kit.failures.timerGet = 1;
      await expect(
        kit.service.graceExpired(roomId, runId, alice.userId, disconnectedAtMs),
      ).rejects.toThrow();
      expect((await rowsOf(alice.userId))[0]?.status).toBe('in_progress');
      expect(await kit.service.graceExpired(roomId, runId, alice.userId, disconnectedAtMs)).toBe(
        'completed',
      );
    });

    it('an on-time job leaves a connected participant completed (unchanged)', async () => {
      const { kit, roomId, runId, alice, trueEndMs } = await lateScenario();
      kit.clock.nowMs = trueEndMs;
      kit.closeRun(roomId, 'completed', { closedAtMs: trueEndMs });
      expect(await kit.service.settleRun(roomId, runId)).toBe('settled');
      expect((await rowsOf(alice.userId))[0]?.status).toBe('completed');
    });
  });

  it('the present-again branch of the job uses the same age rule as a join (Rev J9)', async () => {
    const early = await fixture();
    await early.kit.service.optIn(early.alice.userId, early.roomId, undefined);
    early.kit.setPresent(early.roomId, early.alice.userId, false);
    await early.kit.service.userLeftRoom(early.alice.userId, early.roomId);
    const at = early.kit.clock.nowMs;
    early.kit.clock.nowMs += 60_500; // Inside the tolerance: still a reconnect.
    early.kit.setPresent(early.roomId, early.alice.userId, true);
    expect(
      await early.kit.service.graceExpired(early.roomId, early.runId, early.alice.userId, at),
    ).toBe('reconnected');

    const late = await fixture();
    await late.kit.service.optIn(late.alice.userId, late.roomId, undefined);
    late.kit.setPresent(late.roomId, late.alice.userId, false);
    await late.kit.service.userLeftRoom(late.alice.userId, late.roomId);
    const lateAt = late.kit.clock.nowMs;
    late.kit.clock.nowMs += 62_000;
    late.kit.setPresent(late.roomId, late.alice.userId, true);
    expect(
      await late.kit.service.graceExpired(late.roomId, late.runId, late.alice.userId, lateAt),
    ).toBe('abandoned');
    expect((await rowsOf(late.alice.userId))[0]?.abandonReason).toBe('grace_expired');
  });
});
