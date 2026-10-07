import {
  API_BASE_PATH,
  currentFocusSessionResponseSchema,
  errorBodySchema,
  focusSessionIdSchema,
  focusSessionPath,
  focusSessionPaths,
  focusSessionResponseSchema,
  type FocusSessionView,
  mePaths,
  sessionInProgressDetailsSchema,
  taskIdSchema,
  taskPath,
  taskPaths,
  taskResponseSchema,
} from '@focus-flow/contracts';
import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { beginHeldTransaction, trackSettled, waitUntilBlockedBy } from '../../../test/db-locks.js';
import {
  startInstance,
  startTestHarness,
  stopTestHarness,
  type TestHarness,
} from '../../../test/harness.js';
import { closeAllSockets, connectSocket } from '../../../test/sockets.js';
import { startTcpProxy, type TcpProxy } from '../../../test/tcp-proxy.js';
import { signUpTestUser, type TestUser } from '../../../test/users.js';
import { focusSessions } from '../../db/schema.js';
import type { FocusSessionChange } from './changes.js';

// Solo focus REST endpoints (Phase 4B, Milestone 2) against the real API, PostgreSQL and
// Redis. Presence comes from real Socket.IO connections; the planned end is reached by
// moving a session's stored timestamps into the past.

let harness: TestHarness | undefined;

const requireHarness = (): TestHarness => {
  if (harness === undefined) {
    throw new Error('the API harness failed to start');
  }
  return harness;
};

type ApiResult = { status: number; body: unknown };

const call = async (
  user: TestUser | null,
  method: string,
  path: string,
  body?: unknown,
  baseUrl = requireHarness().baseUrl,
): Promise<ApiResult> => {
  const headers: Record<string, string> = {};
  if (user !== null) {
    headers.Authorization = `Bearer ${user.accessToken}`;
  }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(`${baseUrl}${API_BASE_PATH}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text.length === 0 ? undefined : JSON.parse(text) };
};

const errorCode = (result: ApiResult): string => errorBodySchema.parse(result.body).error.code;
const sessionOf = (result: ApiResult): FocusSessionView =>
  focusSessionResponseSchema.parse(result.body).session;

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

/** A signed-up user with a live socket, confirmed online by the presence check. */
const connectedUser = async (name = 'focus'): Promise<TestUser> => {
  const h = requireHarness();
  const user = await signUpTestUser(h, name);
  await connectSocket(h.baseUrl, user.accessToken);
  await waitFor(() => h.runtime.presence.isUserOnline(user.userId));
  return user;
};

const start = (user: TestUser, body: unknown = { plannedSeconds: 1_500 }, baseUrl?: string) =>
  call(user, 'POST', focusSessionPaths.collection, body, baseUrl);

const action = (user: TestUser, verb: 'pause' | 'resume' | 'stop', sessionId: string) =>
  call(
    user,
    'POST',
    focusSessionPath(focusSessionPaths[verb], focusSessionIdSchema.parse(sessionId)),
  );

const current = async (user: TestUser): Promise<FocusSessionView | null> => {
  const result = await call(user, 'GET', focusSessionPaths.current);
  expect(result.status).toBe(200);
  return currentFocusSessionResponseSchema.parse(result.body).session;
};

const createTask = async (user: TestUser, title = 'Write the report'): Promise<string> => {
  const result = await call(user, 'POST', taskPaths.collection, { title });
  return taskResponseSchema.parse(result.body).task.id;
};

/** Moves a session's stored timestamps into the past, as if it had started `ms` earlier. */
const travelBack = async (sessionId: string, ms: number): Promise<void> => {
  const shift = sql`make_interval(secs => ${ms / 1_000})`;
  await requireHarness()
    .db.update(focusSessions)
    .set({
      startedAt: sql`${focusSessions.startedAt} - ${shift}`,
      runningSince: sql`${focusSessions.runningSince} - ${shift}`,
    })
    .where(eq(focusSessions.id, sessionId));
};

const sessionsInDb = (userId: string) =>
  requireHarness().db.select().from(focusSessions).where(eq(focusSessions.userId, userId));

/** Records every after-commit change for one user while the test runs. */
const recordChanges = (userId: string): FocusSessionChange[] => {
  const changes: FocusSessionChange[] = [];
  const unsubscribe = requireHarness().runtime.focusSessionChanges.subscribe((change) => {
    if (change.userId === userId) {
      changes.push(change);
    }
  });
  cleanups.push(unsubscribe);
  return changes;
};

const cleanups: (() => void)[] = [];

beforeAll(async () => {
  harness = await startTestHarness({ INSTANCE_HEARTBEAT_MS: '200', INSTANCE_TTL_MS: '2000' });
}, 180_000);

afterEach(() => {
  closeAllSockets();
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

afterAll(async () => {
  closeAllSockets();
  if (harness !== undefined) {
    await stopTestHarness(harness);
  }
}, 60_000);

describe('authentication and validation', () => {
  it('requires a bearer token on every route', async () => {
    const id = uuidv7();
    for (const [method, path] of [
      ['POST', focusSessionPaths.collection],
      ['GET', focusSessionPaths.current],
      ['POST', `/focus-sessions/${id}/pause`],
      ['POST', `/focus-sessions/${id}/resume`],
      ['POST', `/focus-sessions/${id}/stop`],
    ] as const) {
      const result = await call(null, method, path, method === 'POST' ? {} : undefined);
      expect(result.status).toBe(401);
    }
  });

  it.each([
    [{ plannedSeconds: 59 }],
    [{ plannedSeconds: 14_401 }],
    [{ plannedSeconds: 90.5 }],
    [{}],
    [{ plannedSeconds: 1_500, userId: uuidv7() }],
    [{ plannedSeconds: 1_500, taskId: 'not-a-uuid' }],
  ])('rejects the start body %j with 400', async (body) => {
    const user = await connectedUser();
    const result = await start(user, body);
    expect(result.status).toBe(400);
    expect(errorCode(result)).toBe('VALIDATION_FAILED');
  });

  it('rejects a malformed session id with 400', async () => {
    const user = await connectedUser();
    const result = await call(user, 'POST', '/focus-sessions/not-a-uuid/pause');
    expect(result.status).toBe(400);
  });
});

describe('POST /focus-sessions', () => {
  it('starts a running solo session for a connected user', async () => {
    const user = await connectedUser();
    const result = await start(user, { plannedSeconds: 1_500 });

    expect(result.status).toBe(201);
    const session = sessionOf(result);
    expect(session).toMatchObject({
      status: 'in_progress',
      context: { kind: 'solo' },
      task: null,
      plannedSeconds: 1_500,
      focusedSeconds: 0,
    });
    expect(session.status === 'in_progress' && session.runningSince).toBe(session.startedAt);
    expect(await current(user)).toEqual(session);
  });

  it('refuses a user with no live socket with 409 NOT_CONNECTED and stores nothing', async () => {
    const user = await signUpTestUser(requireHarness(), 'offline');
    const result = await start(user);
    expect(result.status).toBe(409);
    expect(errorCode(result)).toBe('NOT_CONNECTED');
    expect(await sessionsInDb(user.userId)).toEqual([]);
  });

  it('links the user’s own open task', async () => {
    const user = await connectedUser();
    const taskId = await createTask(user);
    const session = sessionOf(await start(user, { plannedSeconds: 600, taskId }));
    expect(session.task).toEqual({ id: taskId, title: 'Write the report', deleted: false });
  });

  it('never infers the current task (E3)', async () => {
    const user = await connectedUser();
    const taskId = await createTask(user);
    expect((await call(user, 'PUT', mePaths.currentTask, { taskId })).status).toBe(200);
    const session = sessionOf(await start(user, { plannedSeconds: 600 }));
    expect(session.task).toBeNull();
  });

  it('rejects another user’s, a deleted and a nonexistent task with 404, a completed one with 409', async () => {
    const user = await connectedUser();
    const other = await signUpTestUser(requireHarness(), 'other');
    const othersTask = await createTask(other);
    const deleted = await createTask(user);
    await call(user, 'DELETE', taskPath(taskPaths.item, taskIdSchema.parse(deleted)));
    const done = await createTask(user);
    await call(user, 'POST', taskPath(taskPaths.complete, taskIdSchema.parse(done)));

    for (const taskId of [othersTask, deleted, uuidv7()]) {
      const result = await start(user, { plannedSeconds: 600, taskId });
      expect(result.status).toBe(404);
      expect(errorCode(result)).toBe('TASK_NOT_FOUND');
    }
    const result = await start(user, { plannedSeconds: 600, taskId: done });
    expect(result.status).toBe(409);
    expect(errorCode(result)).toBe('TASK_NOT_OPEN');
    expect(await sessionsInDb(user.userId)).toEqual([]);
  });

  it('answers a second start with 409 SESSION_IN_PROGRESS carrying the existing session', async () => {
    const user = await connectedUser();
    const first = sessionOf(await start(user));
    const second = await start(user, { plannedSeconds: 600 });
    expect(second.status).toBe(409);
    expect(errorCode(second)).toBe('SESSION_IN_PROGRESS');
    const details = errorBodySchema.parse(second.body).error.details;
    expect(sessionInProgressDetailsSchema.parse(details).session).toEqual(first);
  });

  it('lets exactly one of many concurrent starts win', async () => {
    const user = await connectedUser();
    const results = await Promise.all(Array.from({ length: 6 }, () => start(user)));
    const created = results.filter((result) => result.status === 201);
    const conflicts = results.filter((result) => result.status === 409);
    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(5);
    const winner = sessionOf(created[0]!);
    for (const conflict of conflicts) {
      expect(errorCode(conflict)).toBe('SESSION_IN_PROGRESS');
      const details = errorBodySchema.parse(conflict.body).error.details;
      expect(sessionInProgressDetailsSchema.parse(details).session.id).toBe(winner.id);
    }
    expect(await sessionsInDb(user.userId)).toHaveLength(1);
  });

  it('waits for a concurrent task delete holding the task row, then refuses the deleted task', async () => {
    const h = requireHarness();
    const user = await connectedUser();
    const taskId = await createTask(user);
    const holder = await beginHeldTransaction(h.pool);
    try {
      await holder.client.query('UPDATE tasks SET deleted_at = now() WHERE id = $1', [taskId]);
      const pending = trackSettled(start(user, { plannedSeconds: 600, taskId }));

      // The start's FOR SHARE task lock queues behind the uncommitted delete.
      await waitUntilBlockedBy(h.pool, holder.pid);
      expect(pending.state.settled).toBe(false);

      await holder.commit();
      const result = await pending.done;
      expect(result.status).toBe(404);
      expect(errorCode(result)).toBe('TASK_NOT_FOUND');
    } finally {
      await holder.rollback();
    }
  });
});

describe('GET /focus-sessions/current', () => {
  it('is null without an in-progress session, including after it ended', async () => {
    const user = await connectedUser();
    expect(await current(user)).toBeNull();
    const session = sessionOf(await start(user));
    await action(user, 'stop', session.id);
    expect(await current(user)).toBeNull();
  });

  it('shows a soft-deleted task as deleted (D38)', async () => {
    const user = await connectedUser();
    const taskId = await createTask(user);
    await start(user, { plannedSeconds: 600, taskId });
    await call(user, 'DELETE', taskPath(taskPaths.item, taskIdSchema.parse(taskId)));
    expect((await current(user))?.task).toEqual({
      id: taskId,
      title: 'Write the report',
      deleted: true,
    });
  });
});

describe('pause, resume, stop', () => {
  it('pauses with the whole seconds focused, resumes, and repeats are unchanged (E11)', async () => {
    const user = await connectedUser();
    const session = sessionOf(await start(user));
    await travelBack(session.id, 90_500);

    const paused = sessionOf(await action(user, 'pause', session.id));
    expect(paused).toMatchObject({ status: 'in_progress', runningSince: null });
    expect(paused.focusedSeconds).toBeGreaterThanOrEqual(90);
    expect(paused.focusedSeconds).toBeLessThan(95);
    expect(sessionOf(await action(user, 'pause', session.id))).toEqual(paused);

    const resumed = sessionOf(await action(user, 'resume', session.id));
    expect(resumed.status === 'in_progress' && resumed.runningSince).not.toBeNull();
    expect(resumed.focusedSeconds).toBe(paused.focusedSeconds);
    expect(sessionOf(await action(user, 'resume', session.id))).toEqual(resumed);
  });

  it('resume needs a connected user, but a repeat on a running session does not', async () => {
    const h = requireHarness();
    const user = await signUpTestUser(h, 'leaver');
    const socket = await connectSocket(h.baseUrl, user.accessToken);
    await waitFor(() => h.runtime.presence.isUserOnline(user.userId));
    const session = sessionOf(await start(user));

    socket.disconnect();
    await waitFor(async () => !(await h.runtime.presence.isUserOnline(user.userId)));

    expect((await action(user, 'resume', session.id)).status).toBe(200); // still running
    await action(user, 'pause', session.id); // pause needs no presence
    const refused = await action(user, 'resume', session.id);
    expect(refused.status).toBe(409);
    expect(errorCode(refused)).toBe('NOT_CONNECTED');
    expect((await current(user))?.status === 'in_progress' && (await current(user))).toMatchObject({
      runningSince: null,
    });
  });

  it('stops a running session as abandoned(stopped) keeping the time; repeats are unchanged', async () => {
    const user = await connectedUser();
    const session = sessionOf(await start(user));
    await travelBack(session.id, 5 * 60_000);

    const stopped = sessionOf(await action(user, 'stop', session.id));
    expect(stopped).toMatchObject({ status: 'abandoned', abandonReason: 'stopped' });
    expect(stopped.focusedSeconds).toBeGreaterThanOrEqual(300);
    for (const verb of ['stop', 'pause', 'resume'] as const) {
      const repeat = await action(user, verb, session.id);
      expect(repeat.status).toBe(200);
      expect(sessionOf(repeat)).toEqual(stopped);
    }
  });

  it('stops a paused session keeping what it had accumulated', async () => {
    const user = await connectedUser();
    const session = sessionOf(await start(user));
    await travelBack(session.id, 61_000);
    const paused = sessionOf(await action(user, 'pause', session.id));
    const stopped = sessionOf(await action(user, 'stop', session.id));
    expect(stopped.focusedSeconds).toBe(paused.focusedSeconds);
  });

  it('answers 404 for another user’s or an unknown session', async () => {
    const owner = await connectedUser('owner');
    const session = sessionOf(await start(owner));
    const other = await connectedUser('intruder');
    for (const verb of ['pause', 'resume', 'stop'] as const) {
      expect((await action(other, verb, session.id)).status).toBe(404);
      const unknown = await action(other, verb, uuidv7());
      expect(unknown.status).toBe(404);
      expect(errorCode(unknown)).toBe('NOT_FOUND');
    }
    expect((await current(owner))?.status).toBe('in_progress');
  });
});

describe('the planned end wins (E7)', () => {
  it('a pause or stop at or after T_end completes a connected user’s session', async () => {
    for (const verb of ['pause', 'stop'] as const) {
      const user = await connectedUser();
      const session = sessionOf(await start(user, { plannedSeconds: 60 }));
      await travelBack(session.id, 2 * 60_000);

      const result = sessionOf(await action(user, verb, session.id));
      expect(result).toMatchObject({ status: 'completed', focusedSeconds: 60 });
      // ended_at is T_end (started + 60 s), not the request time.
      expect(result.status === 'completed' && Date.parse(result.endedAt)).toBe(
        Date.parse(session.startedAt) - 2 * 60_000 + 60_000,
      );
    }
  });

  it('without presence through the end, the pause or stop applies with F capped at P', async () => {
    const h = requireHarness();
    for (const verb of ['pause', 'stop'] as const) {
      const user = await signUpTestUser(h, 'gone');
      const socket = await connectSocket(h.baseUrl, user.accessToken);
      await waitFor(() => h.runtime.presence.isUserOnline(user.userId));
      const session = sessionOf(await start(user, { plannedSeconds: 60 }));
      await travelBack(session.id, 3 * 60_000);
      socket.disconnect();
      await waitFor(async () => !(await h.runtime.presence.isUserOnline(user.userId)));

      const result = sessionOf(await action(user, verb, session.id));
      expect(result.focusedSeconds).toBe(60);
      expect(result.status).toBe(verb === 'pause' ? 'in_progress' : 'abandoned');
    }
  });
});

describe('row locking', () => {
  it('a change waits for a concurrent transaction holding the session row', async () => {
    const h = requireHarness();
    const user = await connectedUser();
    const session = sessionOf(await start(user));
    const holder = await beginHeldTransaction(h.pool);
    try {
      await holder.client.query('SELECT id FROM focus_sessions WHERE id = $1 FOR UPDATE', [
        session.id,
      ]);
      const pending = trackSettled(action(user, 'pause', session.id));
      await waitUntilBlockedBy(h.pool, holder.pid);
      expect(pending.state.settled).toBe(false);

      await holder.commit();
      expect(sessionOf(await pending.done)).toMatchObject({ runningSince: null });
    } finally {
      await holder.rollback();
    }
  });

  it('a request that waited for the row lock computes with the time after the wait', async () => {
    const h = requireHarness();
    const user = await connectedUser();
    const session = sessionOf(await start(user));
    await action(user, 'pause', session.id);
    const holder = await beginHeldTransaction(h.pool);
    try {
      await holder.client.query('SELECT id FROM focus_sessions WHERE id = $1 FOR UPDATE', [
        session.id,
      ]);
      // This pause's transaction starts now, then waits for the lock…
      const pending = trackSettled(action(user, 'pause', session.id));
      await waitUntilBlockedBy(h.pool, holder.pid);
      // …while the holder resumes the session with a later running_since.
      await sleep(50);
      await holder.client.query(
        `UPDATE focus_sessions SET running_since = date_trunc('milliseconds', clock_timestamp())
         WHERE id = $1`,
        [session.id],
      );
      await holder.commit();

      const result = await pending.done;
      expect(result.status).toBe(200);
      expect(sessionOf(result)).toMatchObject({ status: 'in_progress', runningSince: null });
    } finally {
      await holder.rollback();
    }
  });

  it('concurrent pause and stop serialise: the session ends abandoned(stopped) exactly once', async () => {
    const user = await connectedUser();
    const session = sessionOf(await start(user));
    const changes = recordChanges(user.userId);
    const [paused, stopped] = await Promise.all([
      action(user, 'pause', session.id),
      action(user, 'stop', session.id),
    ]);
    expect(paused.status).toBe(200);
    expect(stopped.status).toBe(200);
    expect(sessionOf(stopped)).toMatchObject({ status: 'abandoned', abandonReason: 'stopped' });
    expect(changes.filter((change) => change.transition === 'stopped')).toHaveLength(1);
  });
});

describe('after-commit changes', () => {
  it('publishes each real transition once, after the commit, and nothing for repeats', async () => {
    const user = await connectedUser();
    const changes = recordChanges(user.userId);
    const session = sessionOf(await start(user, { plannedSeconds: 1_500 }));
    await action(user, 'pause', session.id);
    await action(user, 'pause', session.id); // repeat
    await action(user, 'resume', session.id);
    await action(user, 'stop', session.id);
    await action(user, 'stop', session.id); // repeat

    expect(changes.map((change) => change.transition)).toEqual([
      'started',
      'paused',
      'resumed',
      'stopped',
    ]);
    const [started, , resumed] = changes;
    expect(started?.runningStretch?.plannedEndMs).toBe(Date.parse(session.startedAt) + 1_500_000);
    expect(resumed?.runningStretch).not.toBeNull();
    expect(changes[1]?.runningStretch).toBeNull();
    // Each published view is the committed state.
    expect(changes[3]?.session.status).toBe('abandoned');
  });

  it('publishes nothing for a refused request', async () => {
    const user = await signUpTestUser(requireHarness(), 'refused');
    const changes = recordChanges(user.userId);
    expect((await start(user)).status).toBe(409);
    expect(changes).toEqual([]);
  });

  it('a failing listener never fails the committed request', async () => {
    const user = await connectedUser();
    cleanups.push(
      requireHarness().runtime.focusSessionChanges.subscribe(() => {
        throw new Error('listener bug');
      }),
    );
    expect((await start(user)).status).toBe(201);
    expect(await sessionsInDb(user.userId)).toHaveLength(1);
  });
});

describe('presence unavailable', () => {
  let proxy: TcpProxy | undefined;

  afterEach(async () => {
    await proxy?.restore();
  });

  it('fails closed with 503 instead of deciding on an unknown presence (H2)', async () => {
    const h = requireHarness();
    const container = h.redisContainer;
    proxy = await startTcpProxy(container.getHost(), container.getPort());
    const isolated = await startInstance(h, {
      INSTANCE_HEARTBEAT_MS: '200',
      INSTANCE_TTL_MS: '2000',
      ROLE: 'api',
      REDIS_URL: `redis://127.0.0.1:${String(proxy.port)}`,
    });
    const user = await signUpTestUser(h, 'cutoff');
    await connectSocket(h.baseUrl, user.accessToken);
    await waitFor(() => h.runtime.presence.isUserOnline(user.userId));
    const session = sessionOf(await start(user, { plannedSeconds: 60 }));
    await travelBack(session.id, 2 * 60_000);

    await proxy.cut();
    await waitFor(() => Promise.resolve(isolated.runtime.redis.status !== 'ready'));

    // Start needs presence: unknown → 503, nothing stored.
    const startResult = await call(
      user,
      'POST',
      focusSessionPaths.collection,
      {
        plannedSeconds: 600,
      },
      isolated.baseUrl,
    );
    expect(startResult.status).toBe(503);

    // A pause at the planned end needs the completion decision: unknown → 503, unchanged.
    const pauseResult = await call(
      user,
      'POST',
      focusSessionPath(focusSessionPaths.pause, focusSessionIdSchema.parse(session.id)),
      undefined,
      isolated.baseUrl,
    );
    expect(pauseResult.status).toBe(503);
    expect(await current(user)).toEqual(
      expect.objectContaining({ id: session.id, status: 'in_progress' }),
    );
    expect((await sessionsInDb(user.userId))[0]?.runningSince).not.toBeNull();
  });
});
