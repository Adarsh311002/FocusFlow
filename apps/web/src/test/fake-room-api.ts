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

const CODES = ['ABC234', 'DEF567', 'GHJ789', 'KMN234', 'PQR567'];

/**
 * An in-memory stand-in for the room routes (docs/api/rest.md, "Rooms"), following the same
 * rules: a non-member sees `404 ROOM_NOT_FOUND`, the host cannot leave, public rooms are
 * joined idempotently, private ones answer `403 KNOCK_REQUIRED`. `setOverride` lets a test
 * answer a request itself (an error, a slow response) before the fake looks at it.
 */
export function createFakeRoomApi() {
  const rooms: FakeRoom[] = [];
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
    view,
    setOverride: (next: typeof override) => {
      override = next;
    },
  };
}
