import type { Server } from 'node:http';

import {
  API_BASE_PATH,
  errorBodySchema,
  roomFocusSessionResponseSchema,
  roomFocusStateResponseSchema,
} from '@focus-flow/contracts';
import express from 'express';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestHarness, stopTestHarness, type TestHarness } from '../../../test/harness.js';
import { callApi, createStubLogger } from '../../../test/rooms.js';
import { signUpTestUser, type TestUser } from '../../../test/users.js';
import { tasks } from '../../db/schema.js';
import { createErrorHandler } from '../../platform/http/errors.js';
import { requireAuth } from '../auth/middleware.js';
import { generateRoomCode } from '../rooms/code.js';
import { insertMembershipIfAbsent, insertRoom } from '../rooms/queries.js';
import { createRoomFocusRouter } from './http.js';
import { createKit, type Kit } from './test-kit.js';

// The room focus routes over real authentication and PostgreSQL, with the in-memory timer
// and ledger of the kit (so the run can be moved deterministically).

let harness: TestHarness | undefined;
let kit: Kit | undefined;
let server: Server | undefined;
let baseUrl = '';
const limit = { allow: true, fail: false };

const requireKit = (): Kit => {
  if (kit === undefined) {
    throw new Error('the kit failed to start');
  }
  return kit;
};

const requireHarness = (): TestHarness => {
  if (harness === undefined) {
    throw new Error('the harness failed to start');
  }
  return harness;
};

beforeAll(async () => {
  harness = await startTestHarness();
  kit = createKit(harness.db);
  const { logger } = createStubLogger();
  const app = express();
  app.use(express.json({ limit: '16kb' }));
  app.use(
    API_BASE_PATH,
    createRoomFocusRouter({
      service: kit.service,
      authenticate: requireAuth(harness.authDeps),
      rateLimit: () =>
        limit.fail ? Promise.reject(new Error('redis down')) : Promise.resolve(limit.allow),
    }),
  );
  app.use(createErrorHandler(logger));
  const started: Server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => {
      resolve(listening);
    });
  });
  server = started;
  const address = started.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the test app did not listen');
  }
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve) => {
    if (server === undefined) {
      resolve();
    } else {
      server.close(() => {
        resolve();
      });
    }
  });
  if (harness !== undefined) {
    await stopTestHarness(harness);
  }
});

const api = (user: TestUser | null, method: string, path: string, body?: unknown) =>
  callApi(baseUrl, user, method, path, body);

const pathOf = (roomId: string): string => `/rooms/${roomId}/focus-participation`;

const makeRoom = async (): Promise<{ roomId: string; host: TestUser; member: TestUser }> => {
  const h = requireHarness();
  const [host, member] = await Promise.all([
    signUpTestUser(h, 'host'),
    signUpTestUser(h, 'member'),
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
  await insertMembershipIfAbsent(h.db, room.id, host.userId);
  await insertMembershipIfAbsent(h.db, room.id, member.userId);
  requireKit().startFocus(room.id);
  requireKit().setPresent(room.id, member.userId, true);
  requireKit().setPresent(room.id, host.userId, true);
  return { roomId: room.id, host, member };
};

const errorCode = (result: { body: unknown }): string =>
  errorBodySchema.parse(result.body).error.code;

describe('focus participation routes', () => {
  it('opts in (201), repeats (200), reads the state and opts out (200)', async () => {
    const { roomId, member } = await makeRoom();

    const created = await api(member, 'POST', pathOf(roomId), {});
    expect(created.status).toBe(201);
    const { session } = roomFocusSessionResponseSchema.parse(created.body);
    expect(session.context).toMatchObject({ kind: 'room', roomId });
    expect(session.status).toBe('in_progress');

    // A body-less POST is valid too, and a repeat answers the same session.
    const repeat = await api(member, 'POST', pathOf(roomId));
    expect(repeat.status).toBe(200);
    expect(roomFocusSessionResponseSchema.parse(repeat.body).session.id).toBe(session.id);

    const state = await api(member, 'GET', pathOf(roomId));
    expect(state.status).toBe(200);
    const parsed = roomFocusStateResponseSchema.parse(state.body);
    expect(parsed.session?.id).toBe(session.id);
    expect(parsed.me.participation?.sessionId).toBe(session.id);
    expect(parsed.participants.map((p) => p.userId)).toEqual([member.userId]);

    const ended = await api(member, 'DELETE', pathOf(roomId));
    expect(ended.status).toBe(200);
    expect(roomFocusSessionResponseSchema.parse(ended.body).session).toMatchObject({
      id: session.id,
      status: 'abandoned',
      abandonReason: 'opted_out',
    });
    // Idempotent: the same ended session again.
    const again = await api(member, 'DELETE', pathOf(roomId));
    expect(again.status).toBe(200);
    expect(roomFocusSessionResponseSchema.parse(again.body).session.id).toBe(session.id);
  });

  it('shows each caller only their own session in the state', async () => {
    const { roomId, host, member } = await makeRoom();
    await api(member, 'POST', pathOf(roomId), {});
    const hostState = roomFocusStateResponseSchema.parse(
      (await api(host, 'GET', pathOf(roomId))).body,
    );
    expect(hostState.session).toBeNull();
    expect(hostState.me.participation).toBeNull();
    expect(hostState.participants.map((p) => p.userId)).toEqual([member.userId]);
  });

  it('rate limits the writes with 429 and leaves the state read exempt (Rev I M3)', async () => {
    const { roomId, member } = await makeRoom();
    limit.allow = false;
    try {
      for (const method of ['POST', 'DELETE']) {
        const result = await api(
          member,
          method,
          pathOf(roomId),
          method === 'POST' ? {} : undefined,
        );
        expect([result.status, errorCode(result)]).toEqual([429, 'RATE_LIMITED']);
      }
      expect((await api(member, 'GET', pathOf(roomId))).status).toBe(200);
      limit.fail = true;
      expect((await api(member, 'POST', pathOf(roomId), {})).status).toBe(503);
    } finally {
      limit.allow = true;
      limit.fail = false;
    }
    expect((await api(member, 'POST', pathOf(roomId), {})).status).toBe(201);
  });

  it('answers 401 without a token', async () => {
    const { roomId } = await makeRoom();
    for (const method of ['POST', 'GET', 'DELETE']) {
      expect((await api(null, method, pathOf(roomId))).status).toBe(401);
    }
  });

  it('answers 404 ROOM_NOT_FOUND to non-members and for unknown rooms, creating nothing', async () => {
    const { roomId } = await makeRoom();
    const outsider = await signUpTestUser(requireHarness(), 'outsider');
    for (const [method, id] of [
      ['POST', roomId],
      ['GET', roomId],
      ['DELETE', roomId],
      ['POST', uuidv7()],
      ['GET', uuidv7()],
      ['DELETE', uuidv7()],
    ] as const) {
      const result = await api(outsider, method, pathOf(id), method === 'POST' ? {} : undefined);
      expect(result.status).toBe(404);
      expect(errorCode(result)).toBe('ROOM_NOT_FOUND');
    }
    const current = await callApi(
      requireHarness().baseUrl,
      outsider,
      'GET',
      '/focus-sessions/current',
    );
    expect(current.body).toEqual({ session: null });
  });

  it('isolates rooms: membership of one room gives nothing in another', async () => {
    const one = await makeRoom();
    const two = await makeRoom();
    const result = await api(one.member, 'POST', pathOf(two.roomId), {});
    expect(result.status).toBe(404);
    expect((await api(one.member, 'GET', pathOf(two.roomId))).status).toBe(404);
  });

  it('rejects malformed input with 400 VALIDATION_FAILED', async () => {
    const { roomId, member } = await makeRoom();
    const bodies: unknown[] = [
      { userId: uuidv7() },
      { sessionId: uuidv7() },
      { taskId: 'nope' },
      { taskId: 42 },
      { extra: true },
    ];
    for (const body of bodies) {
      const result = await api(member, 'POST', pathOf(roomId), body);
      expect(result.status).toBe(400);
      expect(errorCode(result)).toBe('VALIDATION_FAILED');
    }
    expect((await api(member, 'POST', '/rooms/not-a-uuid/focus-participation', {})).status).toBe(
      400,
    );
    expect((await api(member, 'GET', `${pathOf(roomId)}?foo=1`)).status).toBe(400);
  });

  it('maps the protocol errors to their codes', async () => {
    const { roomId, member } = await makeRoom();
    const k = requireKit();

    k.setPresent(roomId, member.userId, false);
    let result = await api(member, 'POST', pathOf(roomId), {});
    expect([result.status, errorCode(result)]).toEqual([409, 'NOT_PRESENT']);
    k.setPresent(roomId, member.userId, true);

    const taskId = uuidv7();
    await requireHarness().db.insert(tasks).values({
      id: taskId,
      userId: member.userId,
      title: 'Done',
      completedAt: new Date(),
    });
    result = await api(member, 'POST', pathOf(roomId), { taskId });
    expect([result.status, errorCode(result)]).toEqual([409, 'TASK_NOT_OPEN']);

    result = await api(member, 'POST', pathOf(roomId), { taskId: uuidv7() });
    expect([result.status, errorCode(result)]).toEqual([404, 'TASK_NOT_FOUND']);

    k.beforeAdd.run = () => {
      k.closeRun(roomId, 'reset');
    };
    result = await api(member, 'POST', pathOf(roomId), {});
    expect([result.status, errorCode(result)]).toEqual([409, 'RUN_CHANGED']);

    result = await api(member, 'POST', pathOf(roomId), {});
    expect([result.status, errorCode(result)]).toEqual([409, 'NOT_FOCUS_PHASE']);
  });

  it('answers SESSION_IN_PROGRESS with the existing session in details', async () => {
    const one = await makeRoom();
    const two = await makeRoom();
    const h = requireHarness();
    await insertMembershipIfAbsent(h.db, two.roomId, one.member.userId);
    requireKit().setPresent(two.roomId, one.member.userId, true);
    const first = await api(one.member, 'POST', pathOf(one.roomId), {});
    const firstSession = roomFocusSessionResponseSchema.parse(first.body).session;

    const second = await api(one.member, 'POST', pathOf(two.roomId), {});
    expect(second.status).toBe(409);
    const body = errorBodySchema.parse(second.body);
    expect(body.error.code).toBe('SESSION_IN_PROGRESS');
    expect(body.error.details).toMatchObject({ session: { id: firstSession.id } });
  });

  it('keeps the solo endpoints consistent: current shows it, history labels it, pause is refused', async () => {
    const { roomId, member } = await makeRoom();
    const created = await api(member, 'POST', pathOf(roomId), {});
    const { session } = roomFocusSessionResponseSchema.parse(created.body);

    const h = requireHarness();
    const current = await callApi(h.baseUrl, member, 'GET', '/focus-sessions/current');
    expect(current.status).toBe(200);
    expect(current.body).toMatchObject({ session: { id: session.id, context: { kind: 'room' } } });

    for (const action of ['pause', 'resume', 'stop']) {
      const result = await callApi(
        h.baseUrl,
        member,
        'POST',
        `/focus-sessions/${session.id}/${action}`,
      );
      expect(result.status).toBe(409);
      expect(errorCode(result)).toBe('NOT_SOLO_SESSION');
    }
    const history = await callApi(h.baseUrl, member, 'GET', '/focus-sessions');
    expect(history.body).toMatchObject({
      sessions: [{ id: session.id, context: { kind: 'room', roomId } }],
    });
  });
});
