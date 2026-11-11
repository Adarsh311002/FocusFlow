import { API_BASE_PATH, authPaths, mePaths } from '@focus-flow/contracts';

import {
  errorResponse,
  jsonResponse,
  noContentResponse,
  parsedBody,
  type RecordedRequest,
  refreshBody,
  userBody,
} from './api-stub';

/** The signed-in user of every room test (api-stub's `userBody`). */
export const ME = userBody.id;
export const GRACE_ID = '7b0a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
export const LINUS_ID = '9c1d2e3f-4a5b-4c6d-9e7f-8a9b0c1d2e3f';

export type FakeMember = {
  userId: string;
  displayName: string;
  joinedAt: string;
  isHost: boolean;
};

export type FakeRoom = {
  id: string;
  code: string;
  name: string;
  isPrivate: boolean;
  hostId: string;
  timerSettings: { focusSeconds: number; shortBreakSeconds: number; longBreakSeconds: number };
  createdAt: string;
  presentCount: number;
  members: FakeMember[];
};

export const NAMES: Record<string, string> = {
  [ME]: userBody.displayName,
  [GRACE_ID]: 'Grace Hopper',
  [LINUS_ID]: 'Linus Torvalds',
};

/** The focus run every default fixture is in (a valid UUID, as the contract requires). */
export const RAW_RUN_ID = '0192f8a0-1111-7aaa-8bbb-000000000001';
export const RAW_NEXT_RUN_ID = '0192f8a0-2222-7aaa-8bbb-000000000002';

/** A room focus session body as the API sends it (unbranded; the client's schemas brand it). */
export type FakeRoomFocusSession = {
  id: string;
  context: { kind: 'room'; roomId: string; focusRunId: string } | { kind: 'solo' };
  task: { id: string; title: string; deleted: boolean } | null;
  plannedSeconds: number;
  focusedSeconds: number;
  startedAt: string;
  status: 'in_progress';
  runningSince: null;
};

export type FakeFocusParticipant = {
  userId: string;
  displayName: string;
  avatarUrl: null;
  optedInAtMs: number;
  connected: boolean;
  disconnectedAtMs: number | null;
};

const CODES = ['ABC234', 'DEF567', 'GHJ789', 'KMN234', 'PQR567'];

/**
 * An in-memory stand-in for the room routes (docs/api/rest.md, "Rooms"), following the same
 * rules: a non-member sees `404 ROOM_NOT_FOUND`, the host cannot leave, public rooms are
 * joined idempotently, private ones answer `403 KNOCK_REQUIRED`. `setOverride` lets a test
 * answer a request itself (an error, a slow response) before the fake looks at it.
 */
export function createFakeRoomApi() {
  const rooms: FakeRoom[] = [];
  const tasks: Array<{ id: string; title: string }> = [];
  // The signed-in user's side of room focus runs (Phase 8), shared by every room of the fake.
  const focus: {
    runId: string | null;
    participants: FakeFocusParticipant[];
    /** The user's in-progress session in the room being asked about. */
    session: FakeRoomFocusSession | null;
    /** Another in-progress session of the user (solo, or in another room). */
    other: FakeRoomFocusSession | null;
    lastEnded: Record<string, unknown> | null;
  } = { runId: RAW_RUN_ID, participants: [], session: null, other: null, lastEnded: null };
  let nextCode = 0;
  let override: ((request: RecordedRequest) => Response | undefined) | undefined;

  const member = (userId: string, isHost = false): FakeMember => ({
    userId,
    displayName: NAMES[userId] ?? 'Someone',
    joinedAt: new Date().toISOString(),
    isHost,
  });

  function addRoom(
    options: {
      name?: string;
      isPrivate?: boolean;
      hostId?: string;
      /** Other members besides the host. */
      memberIds?: string[];
      /** Whether the signed-in user is a member when they are not the host (default: yes). */
      meIsMember?: boolean;
      presentCount?: number;
      code?: string;
    } = {},
  ): FakeRoom {
    const hostId = options.hostId ?? ME;
    const room: FakeRoom = {
      id: crypto.randomUUID(),
      code: options.code ?? CODES[nextCode++ % CODES.length] ?? 'ABC234',
      name: options.name ?? 'Deep work',
      isPrivate: options.isPrivate ?? false,
      hostId,
      timerSettings: { focusSeconds: 1_500, shortBreakSeconds: 300, longBreakSeconds: 900 },
      createdAt: new Date().toISOString(),
      presentCount: options.presentCount ?? 0,
      members: [member(hostId, true)],
    };
    for (const id of options.memberIds ?? []) {
      room.members.push(member(id));
    }
    if (hostId !== ME && options.meIsMember !== false) {
      room.members.push(member(ME));
    }
    rooms.push(room);
    return room;
  }

  const view = (room: FakeRoom) => ({
    id: room.id,
    code: room.code,
    name: room.name,
    isPrivate: room.isPrivate,
    hostId: room.hostId,
    timerSettings: room.timerSettings,
    createdAt: room.createdAt,
  });
  const preview = (room: FakeRoom) => ({
    id: room.id,
    code: room.code,
    name: room.name,
    isPrivate: room.isPrivate,
  });
  const isMember = (room: FakeRoom) => room.members.some((entry) => entry.userId === ME);
  const notFound = () => errorResponse(404, 'ROOM_NOT_FOUND', 'Room not found.');

  const me = (overrides: Partial<FakeFocusParticipant> = {}): FakeFocusParticipant => ({
    userId: ME,
    displayName: NAMES[ME] ?? 'Someone',
    avatarUrl: null,
    optedInAtMs: Date.now(),
    connected: true,
    disconnectedAtMs: null,
    ...overrides,
  });

  /** An in-progress room session of the signed-in user, as the server would record it. */
  function roomSession(
    room: FakeRoom,
    options: { taskId?: string; plannedSeconds?: number; runId?: string } = {},
  ): FakeRoomFocusSession {
    const task = tasks.find((entry) => entry.id === options.taskId);
    return {
      id: crypto.randomUUID(),
      context: {
        kind: 'room',
        roomId: room.id,
        focusRunId: options.runId ?? focus.runId ?? RAW_RUN_ID,
      },
      task: task === undefined ? null : { ...task, deleted: false },
      plannedSeconds: options.plannedSeconds ?? 1_500,
      focusedSeconds: 0,
      startedAt: new Date().toISOString(),
      status: 'in_progress',
      runningSince: null,
    };
  }

  function focusState() {
    return {
      focusRunId: focus.runId,
      participants: focus.participants,
      me: {
        participation:
          focus.session === null || focus.runId === null
            ? null
            : { sessionId: focus.session.id, focusRunId: focus.runId },
      },
      session: focus.session,
    };
  }

  function handleFocus(room: FakeRoom, request: RecordedRequest): Response {
    if (request.method === 'GET') {
      return jsonResponse(200, focusState());
    }
    if (request.method === 'POST') {
      const existing = focus.session ?? focus.other;
      if (existing !== null) {
        return jsonResponse(409, {
          error: {
            code: 'SESSION_IN_PROGRESS',
            message: 'Already in progress.',
            details: { session: existing },
          },
        });
      }
      if (focus.runId === null) {
        return errorResponse(409, 'NOT_FOCUS_PHASE', 'Not a focus phase.');
      }
      const taskId = parsedBody(request).taskId;
      focus.session = roomSession(room, typeof taskId === 'string' ? { taskId } : {});
      focus.participants = [...focus.participants, me()];
      return jsonResponse(201, { session: focus.session });
    }
    if (request.method === 'DELETE') {
      if (focus.session === null) {
        return focus.lastEnded === null
          ? errorResponse(404, 'NOT_FOUND', 'No session.')
          : jsonResponse(200, { session: focus.lastEnded });
      }
      const ended = {
        ...focus.session,
        status: 'abandoned',
        endedAt: new Date().toISOString(),
        abandonReason: 'opted_out',
      };
      Reflect.deleteProperty(ended, 'runningSince');
      focus.lastEnded = ended;
      focus.session = null;
      focus.participants = focus.participants.filter((entry) => entry.userId !== ME);
      return jsonResponse(200, { session: ended });
    }
    return errorResponse(404, 'NOT_FOUND', 'Unhandled fake focus route.');
  }

  function handle(request: RecordedRequest): Response {
    const overridden = override?.(request);
    if (overridden !== undefined) {
      return overridden;
    }
    const url = new URL(request.url, 'http://localhost');
    const path = url.pathname.slice(API_BASE_PATH.length);
    const segments = path.split('/').filter((segment) => segment.length > 0);

    if (path === authPaths.refresh) {
      return jsonResponse(200, refreshBody('fake-token'));
    }
    if (path === authPaths.logout) {
      return noContentResponse();
    }
    if (path === mePaths.self) {
      return jsonResponse(200, { user: userBody });
    }
    if (path === '/focus-sessions/current' && request.method === 'GET') {
      return jsonResponse(200, { session: focus.session ?? focus.other });
    }
    if (segments[0] === 'tasks' && request.method === 'GET') {
      const now = new Date().toISOString();
      return jsonResponse(200, {
        tasks: tasks.map((task) => ({ ...task, status: 'open', createdAt: now, updatedAt: now })),
        nextCursor: null,
      });
    }
    if (segments[0] !== 'rooms') {
      return errorResponse(404, 'NOT_FOUND', `Unhandled fake route ${request.method} ${path}`);
    }

    if (segments.length === 1 && request.method === 'GET') {
      const mine = rooms.filter(isMember);
      return jsonResponse(200, {
        rooms: mine.map((room) => ({ ...view(room), presentCount: room.presentCount })),
      });
    }
    if (segments.length === 1 && request.method === 'POST') {
      const body = parsedBody(request);
      const settings = body.timerSettings;
      const room = addRoom({
        name: String(body.name),
        isPrivate: body.isPrivate === true,
      });
      if (typeof settings === 'object' && settings !== null) {
        Object.assign(room.timerSettings, settings);
      }
      return jsonResponse(201, { room: view(room) });
    }
    if (segments[1] === 'by-code') {
      const code = decodeURIComponent(segments[2] ?? '')
        .replace(/\s+/gu, '')
        .toUpperCase();
      const room = rooms.find((entry) => entry.code === code);
      if (room === undefined) {
        return notFound();
      }
      if (room.hostId === ME || isMember(room)) {
        return jsonResponse(200, {
          access: room.hostId === ME ? 'host' : 'member',
          room: view(room),
          presentCount: room.presentCount,
        });
      }
      return jsonResponse(200, {
        access: room.isPrivate ? 'must_knock' : 'can_join',
        room: preview(room),
        presentCount: room.isPrivate ? null : room.presentCount,
      });
    }

    const room = rooms.find((entry) => entry.id === segments[1]);
    const action = segments[2];
    // Joining a public room is the one route a non-member may use.
    if (room !== undefined && action === 'membership' && request.method === 'POST') {
      if (room.isPrivate && !isMember(room)) {
        return errorResponse(403, 'KNOCK_REQUIRED', 'Knock first.');
      }
      if (!isMember(room)) {
        room.members.push(member(ME));
      }
      return jsonResponse(200, {
        membership: { roomId: room.id, userId: ME, joinedAt: new Date().toISOString() },
      });
    }
    if (room === undefined || !isMember(room)) {
      return notFound();
    }
    if (action === undefined && request.method === 'GET') {
      return jsonResponse(200, { room: view(room) });
    }
    if (action === 'members' && segments.length === 3 && request.method === 'GET') {
      return jsonResponse(200, {
        members: room.members.map((entry) => ({ ...entry, avatarUrl: null })),
      });
    }
    if (action === 'members' && request.method === 'DELETE') {
      if (room.hostId !== ME) {
        return errorResponse(403, 'NOT_HOST', 'Only the host can do that.');
      }
      room.members = room.members.filter((entry) => entry.userId !== segments[3]);
      return noContentResponse();
    }
    if (action === 'membership' && request.method === 'DELETE') {
      if (room.hostId === ME) {
        return errorResponse(409, 'HOST_CANNOT_LEAVE', 'The host cannot leave.');
      }
      room.members = room.members.filter((entry) => entry.userId !== ME);
      return noContentResponse();
    }
    if (action === 'focus-participation') {
      return handleFocus(room, request);
    }
    if (action === 'timer-settings' && request.method === 'PATCH') {
      if (room.hostId !== ME) {
        return errorResponse(403, 'NOT_HOST', 'Only the host can do that.');
      }
      Object.assign(room.timerSettings, parsedBody(request));
      return jsonResponse(200, { room: view(room) });
    }
    if (action === 'knocks' && request.method === 'POST') {
      if (room.hostId !== ME) {
        return errorResponse(403, 'NOT_HOST', 'Only the host can do that.');
      }
      const requesterId = segments[3] ?? '';
      if (segments[4] === 'approve') {
        room.members.push(member(requesterId));
        return jsonResponse(200, {
          membership: { roomId: room.id, userId: requesterId, joinedAt: new Date().toISOString() },
        });
      }
      return noContentResponse();
    }
    return errorResponse(404, 'NOT_FOUND', `Unhandled fake route ${request.method} ${path}`);
  }

  return {
    handle,
    rooms,
    addRoom,
    /** Open tasks of the signed-in user. */
    addTask: (title: string) => {
      const task = { id: crypto.randomUUID(), title };
      tasks.push(task);
      return task;
    },
    focus,
    roomSession,
    focusParticipant: me,
    view,
    setOverride: (next: typeof override) => {
      override = next;
    },
  };
}
