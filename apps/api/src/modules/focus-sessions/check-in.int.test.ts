import {
  API_BASE_PATH,
  errorBodySchema,
  focusSessionIdSchema,
  focusSessionPath,
  focusSessionPaths,
  focusSessionResponseSchema,
  type FocusSessionView,
  mePaths,
  meResponseSchema,
  taskIdSchema,
  taskPath,
  taskPaths,
  taskResponseSchema,
} from '@focus-flow/contracts';
import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { startTestHarness, stopTestHarness, type TestHarness } from '../../../test/harness.js';
import { closeAllSockets, connectSocket } from '../../../test/sockets.js';
import { signUpTestUser, type TestUser } from '../../../test/users.js';
import { focusSessions } from '../../db/schema.js';
import type { FocusSessionChange } from './changes.js';

// The session check-in (CI1–CI4) against the real API and PostgreSQL.

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
): Promise<ApiResult> => {
  const headers: Record<string, string> = {};
  if (user !== null) {
    headers.Authorization = `Bearer ${user.accessToken}`;
  }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(`${requireHarness().baseUrl}${API_BASE_PATH}${path}`, {
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

const connectedUser = async (name = 'checkin'): Promise<TestUser> => {
  const h = requireHarness();
  const user = await signUpTestUser(h, name);
  await connectSocket(h.baseUrl, user.accessToken);
  await waitFor(() => h.runtime.presence.isUserOnline(user.userId));
  return user;
};

const createTask = async (user: TestUser, title = 'Draft the intro'): Promise<string> => {
  const result = await call(user, 'POST', taskPaths.collection, { title });
  return taskResponseSchema.parse(result.body).task.id;
};

const sessionPath = (template: 'stop' | 'checkIn', sessionId: string): string =>
  focusSessionPath(focusSessionPaths[template], focusSessionIdSchema.parse(sessionId));

/** A started and then stopped session, optionally with a task. */
const endedSession = async (user: TestUser, taskId?: string): Promise<FocusSessionView> => {
  const started = sessionOf(
    await call(user, 'POST', focusSessionPaths.collection, {
      plannedSeconds: 1_500,
      ...(taskId === undefined ? {} : { taskId }),
    }),
  );
  return sessionOf(await call(user, 'POST', sessionPath('stop', started.id)));
};

const checkIn = (user: TestUser | null, sessionId: string, body: unknown) =>
  call(user, 'PUT', sessionPath('checkIn', sessionId), body);

const taskOf = async (user: TestUser, taskId: string) =>
  call(user, 'GET', taskPath(taskPaths.item, taskIdSchema.parse(taskId)));

const currentTaskIdOf = async (user: TestUser): Promise<string | null> =>
  meResponseSchema.parse((await call(user, 'GET', mePaths.self)).body).user.currentTaskId;

/** The violated constraint's name of a rejected query (drizzle wraps the driver's error). */
const violatedConstraint = async (query: Promise<unknown>): Promise<string | undefined> => {
  try {
    await query;
  } catch (error) {
    let current: unknown = error;
    while (typeof current === 'object' && current !== null) {
      if ('constraint' in current && typeof current.constraint === 'string') {
        return current.constraint;
      }
      current = 'cause' in current ? current.cause : undefined;
    }
    return 'unknown-error';
  }
  return undefined;
};

const cleanups: (() => void)[] = [];

beforeAll(async () => {
  harness = await startTestHarness(
    { INSTANCE_HEARTBEAT_MS: '200', INSTANCE_TTL_MS: '2000' },
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
  closeAllSockets();
  if (harness !== undefined) {
    await stopTestHarness(harness);
  }
}, 60_000);

describe('PUT /focus-sessions/:sessionId/check-in', () => {
  it('needs a token, a valid body and the caller’s own session', async () => {
    const owner = await connectedUser('owner');
    const other = await connectedUser('other');
    const session = await endedSession(owner);

    expect((await checkIn(null, session.id, { outcome: 'done' })).status).toBe(401);
    for (const body of [
      {},
      { outcome: 'finished' },
      { outcome: 'done', note: 'x'.repeat(281) },
      { outcome: 'done', userId: other.userId },
    ]) {
      const result = await checkIn(owner, session.id, body);
      expect(result.status).toBe(400);
      expect(errorCode(result)).toBe('VALIDATION_FAILED');
    }
    for (const id of [session.id, uuidv7()]) {
      const result = await checkIn(other, id, { outcome: 'done' });
      expect(result.status).toBe(404);
      expect(errorCode(result)).toBe('NOT_FOUND');
    }
  });

  it('refuses an in-progress session with 409 SESSION_NOT_ENDED', async () => {
    const user = await connectedUser();
    const started = sessionOf(
      await call(user, 'POST', focusSessionPaths.collection, { plannedSeconds: 1_500 }),
    );
    const result = await checkIn(user, started.id, { outcome: 'progress' });
    expect(result.status).toBe(409);
    expect(errorCode(result)).toBe('SESSION_NOT_ENDED');
  });

  it('records the outcome and a trimmed note; a later check-in replaces it', async () => {
    const user = await connectedUser();
    const session = await endedSession(user);

    const first = sessionOf(
      await checkIn(user, session.id, { outcome: 'progress', note: '  Half of the outline  ' }),
    );
    expect(first.status).toBe('abandoned');
    expect(first.status !== 'in_progress' && first.checkIn).toMatchObject({
      outcome: 'progress',
      note: 'Half of the outline',
    });

    const second = sessionOf(await checkIn(user, session.id, { outcome: 'stuck', note: '   ' }));
    expect(second.status !== 'in_progress' && second.checkIn).toMatchObject({
      outcome: 'stuck',
      note: null,
    });
    // The session's time is the server's record and never changes with a check-in.
    expect(second.focusedSeconds).toBe(session.focusedSeconds);
    expect(second.status !== 'in_progress' && second.endedAt).toBe(
      session.status !== 'in_progress' && session.endedAt,
    );
  });

  it('completes the open task on "done" and clears it as the current task (CI3, D43)', async () => {
    const user = await connectedUser();
    const taskId = await createTask(user);
    expect((await call(user, 'PUT', mePaths.currentTask, { taskId })).status).toBe(200);
    const session = await endedSession(user, taskId);

    await checkIn(user, session.id, { outcome: 'done' });

    const task = taskResponseSchema.parse((await taskOf(user, taskId)).body).task;
    expect(task.status).toBe('completed');
    expect(await currentTaskIdOf(user)).toBeNull();

    // Changing the answer later never reopens the task.
    await checkIn(user, session.id, { outcome: 'progress' });
    expect(taskResponseSchema.parse((await taskOf(user, taskId)).body).task.status).toBe(
      'completed',
    );
  });

  it('leaves the task alone for "progress" and "stuck", and for a deleted task', async () => {
    const user = await connectedUser();
    const kept = await createTask(user, 'Keep going');
    const session = await endedSession(user, kept);
    await checkIn(user, session.id, { outcome: 'stuck' });
    expect(taskResponseSchema.parse((await taskOf(user, kept)).body).task.status).toBe('open');

    const gone = await createTask(user, 'Remove me');
    const another = await endedSession(user, gone);
    expect(
      (await call(user, 'DELETE', taskPath(taskPaths.item, taskIdSchema.parse(gone)))).status,
    ).toBe(204);
    const result = await checkIn(user, another.id, { outcome: 'done' });
    expect(result.status).toBe(200);
    expect((await taskOf(user, gone)).status).toBe(404);
  });

  it('publishes a "checked_in" change after the commit', async () => {
    const user = await connectedUser();
    const session = await endedSession(user);
    const changes: FocusSessionChange[] = [];
    cleanups.push(
      requireHarness().runtime.focusSessionChanges.subscribe((change) => {
        if (change.userId === user.userId) {
          changes.push(change);
        }
      }),
    );
    await checkIn(user, session.id, { outcome: 'done' });
    expect(changes.map((change) => change.transition)).toEqual(['checked_in']);
  });
});

describe('check-in constraints (CI1)', () => {
  it('keeps a check-in off an in-progress row and the outcome inside its set', async () => {
    const user = await connectedUser();
    const started = sessionOf(
      await call(user, 'POST', focusSessionPaths.collection, { plannedSeconds: 1_500 }),
    );
    const db = requireHarness().db;
    expect(
      await violatedConstraint(
        db
          .update(focusSessions)
          .set({ checkInOutcome: 'done', checkedInAt: sql`now()` })
          .where(eq(focusSessions.id, started.id)),
      ),
    ).toBe('ck_focus_sessions_check_in_ended');

    const ended = await endedSession(await connectedUser('second'));
    expect(
      await violatedConstraint(
        db
          .update(focusSessions)
          .set({ checkInOutcome: 'great', checkedInAt: sql`now()` })
          .where(eq(focusSessions.id, ended.id)),
      ),
    ).toBe('ck_focus_sessions_check_in_outcome');
    expect(
      await violatedConstraint(
        db
          .update(focusSessions)
          .set({ checkInOutcome: 'done' })
          .where(eq(focusSessions.id, ended.id)),
      ),
    ).toBe('ck_focus_sessions_check_in_presence');
    expect(
      await violatedConstraint(
        db
          .update(focusSessions)
          .set({ shareIntention: true })
          .where(eq(focusSessions.id, ended.id)),
      ),
    ).toBe('ck_focus_sessions_share_intention');
  });
});
