import {
  API_BASE_PATH,
  errorBodySchema,
  focusSessionIdSchema,
  focusSessionInsightsResponseSchema,
  focusSessionPath,
  focusSessionPaths,
  type FocusSessionPathTemplate,
  focusSessionResponseSchema,
  type FocusSessionView,
} from '@focus-flow/contracts';
import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { startTestHarness, stopTestHarness, type TestHarness } from '../../../test/harness.js';
import { closeAllSockets, connectSocket } from '../../../test/sockets.js';
import { signUpTestUser, type TestUser } from '../../../test/users.js';
import { focusSessions } from '../../db/schema.js';

// Deep Focus (DF1–DF6) against the real API and PostgreSQL.

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

const connectedUser = async (name = 'deep'): Promise<TestUser> => {
  const h = requireHarness();
  const user = await signUpTestUser(h, name);
  await connectSocket(h.baseUrl, user.accessToken);
  await waitFor(() => h.runtime.presence.isUserOnline(user.userId));
  return user;
};

const post = (user: TestUser | null, template: FocusSessionPathTemplate, sessionId: string) =>
  call(user, 'POST', focusSessionPath(template, focusSessionIdSchema.parse(sessionId)));

const start = async (user: TestUser, deepFocus?: boolean): Promise<FocusSessionView> =>
  sessionOf(
    await call(user, 'POST', focusSessionPaths.collection, {
      plannedSeconds: 1_500,
      ...(deepFocus === undefined ? {} : { deepFocus }),
    }),
  );

beforeAll(async () => {
  harness = await startTestHarness(
    { INSTANCE_HEARTBEAT_MS: '200', INSTANCE_TTL_MS: '2000' },
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

describe('Deep Focus sessions', () => {
  it('starts a Deep Focus session; only that session carries deepFocus (DF1)', async () => {
    const user = await connectedUser();
    const deep = await start(user, true);
    expect(deep.deepFocus).toEqual({ distractions: 0, pausesUsed: 0 });
    await post(user, focusSessionPaths.stop, deep.id);

    const normal = await start(user);
    expect(normal.deepFocus).toBeUndefined();
    expect(
      (await call(user, 'POST', focusSessionPaths.collection, { plannedSeconds: 60, deepFocus: 1 }))
        .status,
    ).toBe(400);
  });

  it('counts distractions while in progress; not for other sessions (DF3)', async () => {
    const user = await connectedUser();
    const other = await connectedUser('other');
    const deep = await start(user, true);

    expect((await post(null, focusSessionPaths.distraction, deep.id)).status).toBe(401);
    const foreign = await post(other, focusSessionPaths.distraction, deep.id);
    expect(foreign.status).toBe(404);
    expect((await post(user, focusSessionPaths.distraction, uuidv7())).status).toBe(404);

    const once = sessionOf(await post(user, focusSessionPaths.distraction, deep.id));
    const twice = sessionOf(await post(user, focusSessionPaths.distraction, deep.id));
    expect(once.deepFocus?.distractions).toBe(1);
    expect(twice.deepFocus?.distractions).toBe(2);
    expect(twice.status).toBe('in_progress');
    expect(twice.status === 'in_progress' && twice.runningSince).toBe(
      deep.status === 'in_progress' && deep.runningSince,
    );

    const stopped = sessionOf(await post(user, focusSessionPaths.stop, deep.id));
    const after = sessionOf(await post(user, focusSessionPaths.distraction, deep.id));
    expect(after).toEqual(stopped);

    const normal = await start(user);
    const refused = await post(user, focusSessionPaths.distraction, normal.id);
    expect(refused.status).toBe(409);
    expect(errorCode(refused)).toBe('NOT_DEEP_FOCUS');
  });

  it('allows one pause per Deep Focus session (DF4); normal sessions pause freely', async () => {
    const user = await connectedUser();
    const deep = await start(user, true);

    const paused = sessionOf(await post(user, focusSessionPaths.pause, deep.id));
    expect(paused.deepFocus?.pausesUsed).toBe(1);
    // A repeat while paused is still a harmless no-op (E11).
    expect((await post(user, focusSessionPaths.pause, deep.id)).status).toBe(200);
    sessionOf(await post(user, focusSessionPaths.resume, deep.id));

    const second = await post(user, focusSessionPaths.pause, deep.id);
    expect(second.status).toBe(409);
    expect(errorCode(second)).toBe('PAUSE_USED');
    await post(user, focusSessionPaths.stop, deep.id);

    const normal = await start(user);
    for (let round = 0; round < 2; round += 1) {
      expect((await post(user, focusSessionPaths.pause, normal.id)).status).toBe(200);
      expect((await post(user, focusSessionPaths.resume, normal.id)).status).toBe(200);
    }
    const [row] = await requireHarness()
      .db.select({ pauseCount: focusSessions.pauseCount })
      .from(focusSessions)
      .where(eq(focusSessions.id, normal.id));
    expect(row?.pauseCount).toBe(2);
  });

  it('breaks a Deep Focus session as abandoned(focus_broken), keeping its time (DF2)', async () => {
    const h = requireHarness();
    const user = await connectedUser();
    const deep = await start(user, true);
    // Two minutes in, so the kept focused time is visible.
    await h.db.execute(
      sql`UPDATE focus_sessions SET started_at = started_at - interval '2 minutes',
          running_since = running_since - interval '2 minutes' WHERE id = ${deep.id}`,
    );

    const broken = sessionOf(await post(user, focusSessionPaths.break, deep.id));
    expect(broken.status).toBe('abandoned');
    expect(broken.status === 'abandoned' && broken.abandonReason).toBe('focus_broken');
    expect(broken.focusedSeconds).toBeGreaterThanOrEqual(120);
    // Ended → unchanged (E11).
    expect(sessionOf(await post(user, focusSessionPaths.break, deep.id))).toEqual(broken);

    const normal = await start(user);
    const refused = await post(user, focusSessionPaths.break, normal.id);
    expect(refused.status).toBe(409);
    expect(errorCode(refused)).toBe('NOT_DEEP_FOCUS');
    expect(sessionOf(await post(user, focusSessionPaths.stop, normal.id)).status).toBe('abandoned');
  });

  it('reports Deep Focus in the insights, with the unbroken run (DF6)', async () => {
    const user = await connectedUser();
    const first = await start(user, true);
    await post(user, focusSessionPaths.break, first.id);
    const second = await start(user, true);
    await post(user, focusSessionPaths.distraction, second.id);
    await post(user, focusSessionPaths.stop, second.id);
    const third = await start(user, true);
    await post(user, focusSessionPaths.stop, third.id);
    const normal = await start(user);
    await post(user, focusSessionPaths.stop, normal.id);

    const today = new Date().toISOString().slice(0, 10);
    const result = await call(
      user,
      'GET',
      `${focusSessionPaths.insights}?from=${today}&to=${today}&tz=UTC`,
    );
    const insights = focusSessionInsightsResponseSchema.parse(result.body);
    expect(insights.deepFocus).toEqual({
      sessions: 3,
      completed: 0,
      broken: 1,
      distractionFree: 0,
      distractions: 1,
      unbrokenRun: 2,
    });
  });

  it('keeps the constraints: Deep Focus is solo only, only it can be broken', async () => {
    const h = requireHarness();
    const user = await connectedUser();
    const normal = await start(user);
    await post(user, focusSessionPaths.stop, normal.id);
    await expect(
      h.db
        .update(focusSessions)
        .set({ abandonReason: 'focus_broken' })
        .where(eq(focusSessions.id, normal.id)),
    ).rejects.toThrow();
    await expect(
      h.db.update(focusSessions).set({ distractions: -1 }).where(eq(focusSessions.id, normal.id)),
    ).rejects.toThrow();
  });
});
