import {
  ROOM_FOCUS_SECONDS,
  ROOM_LONG_BREAK_SECONDS,
  ROOM_SHORT_BREAK_SECONDS,
  roomByCodePath,
  roomListResponseSchema,
  roomLookupResponseSchema,
  roomMembershipResponseSchema,
  roomMembersResponseSchema,
  roomPaths,
  roomResponseSchema,
  type RoomView,
} from '@focus-flow/contracts';
import { and, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startTestHarness, stopTestHarness, type TestHarness } from '../../../test/harness.js';
import {
  type ApiResult,
  callApi,
  errorCodeOf,
  type RoomsTestApp,
  startRoomsApp,
} from '../../../test/rooms.js';
import { signUpTestUser, type TestUser } from '../../../test/users.js';
import { focusSessions, roomMembers, rooms } from '../../db/schema.js';
import { generateRoomCode } from './code.js';
import type { RoomFocusDepartures } from './ports.js';

let harness: TestHarness | undefined;
let app: RoomsTestApp | undefined;
let codeSource: (() => string) | undefined;

/** Departures planned by the stand-in room focus module (see `focusDepartures` below). */
const departureLog: string[] = [];

/**
 * A stand-in for the room focus module with the same shape as the real one: it finds the
 * person's in-progress session in the room, abandons it INSIDE the transaction `commit`
 * receives, and reports the follow-up after the commit.
 */
const focusDepartures: RoomFocusDepartures = {
  beginDeparture: async (userId, roomId, reason) => {
    if (harness === undefined) {
      throw new Error('the API harness failed to start');
    }
    const [row] = await harness.db
      .select()
      .from(focusSessions)
      .where(
        and(
          eq(focusSessions.userId, userId),
          eq(focusSessions.roomId, roomId),
          eq(focusSessions.status, 'in_progress'),
        ),
      );
    if (row === undefined) {
      return undefined;
    }
    return {
      commit: async (tx) => {
        await tx
          .update(focusSessions)
          .set({ status: 'abandoned', abandonReason: reason, endedAt: new Date() })
          .where(eq(focusSessions.id, row.id));
      },
      afterCommit: () => {
        departureLog.push(`${userId}:${reason}`);
        return Promise.resolve();
      },
    };
  },
};

let alice: TestUser;
let bob: TestUser;
let carol: TestUser;

const requireHarness = (): TestHarness => {
  if (harness === undefined) {
    throw new Error('the API harness failed to start');
  }
  return harness;
};

const requireApp = (): RoomsTestApp => {
  if (app === undefined) {
    throw new Error('the rooms app failed to start');
  }
  return app;
};

const api = (user: TestUser | null, method: string, path: string, body?: unknown) =>
  callApi(requireApp().baseUrl, user, method, path, body);

const url = (template: string, roomId: string, userId?: string): string =>
  template.replace(':roomId', roomId).replace(':userId', userId ?? '');

const roomOf = (result: ApiResult): RoomView => roomResponseSchema.parse(result.body).room;

const createRoom = async (
  user: TestUser,
  options: { isPrivate?: boolean; name?: string; timerSettings?: unknown } = {},
): Promise<RoomView> => {
  const result = await api(user, 'POST', roomPaths.collection, {
    name: options.name ?? 'Study hall',
    isPrivate: options.isPrivate ?? false,
    ...(options.timerSettings === undefined ? {} : { timerSettings: options.timerSettings }),
  });
  expect(result.status).toBe(201);
  return roomOf(result);
};

const memberRows = async (roomId: string) =>
  requireHarness().db.select().from(roomMembers).where(eq(roomMembers.roomId, roomId));

const joinAs = async (user: TestUser, room: RoomView): Promise<void> => {
  const result = await api(user, 'POST', url(roomPaths.membership, room.id));
  expect([200, 201]).toContain(result.status);
};

/** Makes `user` a member of a private room the way the product does: a pending knock, approved. */
const approveInto = async (host: TestUser, user: TestUser, room: RoomView): Promise<void> => {
  const live = requireApp().live;
  live.failKnockState = false;
  live.pendingKnocks.add(`${room.id}:${user.userId}`);
  const result = await api(host, 'POST', url(roomPaths.approveKnock, room.id, user.userId));
  expect([200, 201]).toContain(result.status);
};

const resetLive = (): void => {
  const live = requireApp().live;
  live.calls.length = 0;
  live.pendingKnocks.clear();
  live.failPresentCounts = false;
  live.failKnockState = false;
  live.failAnnouncements = false;
  live.failResolveKnock = false;
  live.afterIsKnockPending = undefined;
  live.onAnnounceMemberJoined = undefined;
  live.beforeResolveKnock = undefined;
  departureLog.length = 0;
  live.counts.clear();
  const { spies } = requireApp();
  spies.error.mockClear();
  spies.warn.mockClear();
  spies.info.mockClear();
  spies.debug.mockClear();
};

beforeAll(async () => {
  harness = await startTestHarness();
  app = await startRoomsApp(harness, {
    generateCode: () => (codeSource ?? generateRoomCode)(),
    focus: focusDepartures,
  });
  alice = await signUpTestUser(harness, 'alice');
  bob = await signUpTestUser(harness, 'bob');
  carol = await signUpTestUser(harness, 'carol');
}, 120_000);

afterAll(async () => {
  if (app !== undefined) {
    await app.close();
  }
  if (harness !== undefined) {
    await stopTestHarness(harness);
  }
}, 60_000);

beforeEach(() => {
  resetLive();
});

describe('authentication', () => {
  const someRoom = uuidv7();
  const someUser = uuidv7();
  const routes: [string, string, unknown][] = [
    ['POST', roomPaths.collection, { name: 'x', isPrivate: false }],
    ['GET', roomPaths.collection, undefined],
    ['GET', roomByCodePath('ABC234'), undefined],
    ['GET', url(roomPaths.item, someRoom), undefined],
    ['PATCH', url(roomPaths.timerSettings, someRoom), { focusSeconds: 600 }],
    ['GET', url(roomPaths.members, someRoom), undefined],
    ['POST', url(roomPaths.membership, someRoom), undefined],
    ['DELETE', url(roomPaths.membership, someRoom), undefined],
    ['DELETE', url(roomPaths.member, someRoom, someUser), undefined],
    ['POST', url(roomPaths.approveKnock, someRoom, someUser), undefined],
    ['POST', url(roomPaths.rejectKnock, someRoom, someUser), undefined],
  ];

  it.each(routes)('%s %s without a token answers 401', async (method, path, body) => {
    const result = await api(null, method, path, body);
    expect(result.status).toBe(401);
  });
});

describe('POST /rooms', () => {
  it('creates a room with default settings and makes the creator the host and a member', async () => {
    resetLive();
    const result = await api(alice, 'POST', roomPaths.collection, {
      name: '  Study hall  ',
      isPrivate: false,
    });
    expect(result.status).toBe(201);
    const room = roomOf(result);
    expect(room).toMatchObject({
      name: 'Study hall',
      isPrivate: false,
      hostId: alice.userId,
      timerSettings: { focusSeconds: 1500, shortBreakSeconds: 300, longBreakSeconds: 900 },
    });
    expect(room.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/u);

    const rows = await memberRows(room.id);
    expect(rows.map((row) => row.userId)).toEqual([alice.userId]);

    const members = await api(alice, 'GET', url(roomPaths.members, room.id));
    const parsed = roomMembersResponseSchema.parse(members.body).members;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ userId: alice.userId, isHost: true });
    // Creating is not a live event.
    expect(requireApp().live.calls).toHaveLength(0);
  });

  it('accepts a name of exactly 1 and exactly 60 characters, trimming around it', async () => {
    expect((await createRoom(alice, { name: 'a' })).name).toBe('a');
    const sixty = 'b'.repeat(60);
    expect((await createRoom(alice, { name: sixty })).name).toBe(sixty);
    expect((await createRoom(alice, { name: `  ${sixty}  ` })).name).toBe(sixty);
  });

  it('refuses 61 characters even with spaces around them', async () => {
    const result = await api(alice, 'POST', roomPaths.collection, {
      name: `  ${'c'.repeat(61)}  `,
      isPrivate: false,
    });
    expect(result.status).toBe(400);
  });

  it('keeps the defaults for omitted durations', async () => {
    const room = await createRoom(alice, { timerSettings: { focusSeconds: 3000 } });
    expect(room.timerSettings).toEqual({
      focusSeconds: 3000,
      shortBreakSeconds: 300,
      longBreakSeconds: 900,
    });
  });

  it('accepts an explicit timerSettings object with all three durations at their bounds', async () => {
    const room = await createRoom(alice, {
      timerSettings: { focusSeconds: 60, shortBreakSeconds: 3600, longBreakSeconds: 7200 },
    });
    expect(room.timerSettings).toEqual({
      focusSeconds: 60,
      shortBreakSeconds: 3600,
      longBreakSeconds: 7200,
    });
  });

  it.each([
    ['an unknown hostId key', { name: 'x', isPrivate: false, hostId: uuidv7() }],
    ['an unknown userId key', { name: 'x', isPrivate: false, userId: uuidv7() }],
    ['a code key', { name: 'x', isPrivate: false, code: 'ABC234' }],
    ['an empty name', { name: '', isPrivate: false }],
    ['a blank name', { name: '   ', isPrivate: false }],
    ['a 61-character name', { name: 'a'.repeat(61), isPrivate: false }],
    ['a missing isPrivate', { name: 'x' }],
    ['a non-boolean isPrivate', { name: 'x', isPrivate: 'yes' }],
    [
      'a focus duration below 60',
      { name: 'x', isPrivate: false, timerSettings: { focusSeconds: 59 } },
    ],
    [
      'a short break above 3600',
      { name: 'x', isPrivate: false, timerSettings: { shortBreakSeconds: 3601 } },
    ],
    ['an unknown timer key', { name: 'x', isPrivate: false, timerSettings: { pomodoros: 4 } }],
    [
      'a fractional duration',
      { name: 'x', isPrivate: false, timerSettings: { focusSeconds: 90.5 } },
    ],
  ])('rejects %s with 400', async (_label, body) => {
    const before = await requireHarness().db.select().from(rooms);
    const result = await api(alice, 'POST', roomPaths.collection, body);
    expect(result.status).toBe(400);
    expect(errorCodeOf(result)).toBe('VALIDATION_FAILED');
    expect(await requireHarness().db.select().from(rooms)).toHaveLength(before.length);
  });

  it('retries a code collision with a new code', async () => {
    const taken = await createRoom(alice);
    const fresh = generateRoomCode();
    const sequence = [taken.code, taken.code, fresh];
    codeSource = () => sequence.shift() ?? generateRoomCode();
    try {
      const room = await createRoom(bob);
      expect(room.code).toBe(fresh);
      expect(room.code).not.toBe(taken.code);
    } finally {
      codeSource = undefined;
    }
  });

  it('answers 503 and leaves no room or membership after five collisions', async () => {
    const taken = await createRoom(alice);
    const roomsBefore = await requireHarness().db.select().from(rooms);
    const membersBefore = await requireHarness().db.select().from(roomMembers);
    let attempts = 0;
    codeSource = () => {
      attempts += 1;
      return taken.code;
    };
    try {
      const result = await api(bob, 'POST', roomPaths.collection, {
        name: 'x',
        isPrivate: false,
      });
      expect(result.status).toBe(503);
      expect(attempts).toBe(5);
    } finally {
      codeSource = undefined;
    }
    expect(await requireHarness().db.select().from(rooms)).toHaveLength(roomsBefore.length);
    expect(await requireHarness().db.select().from(roomMembers)).toHaveLength(membersBefore.length);
  });

  it('creates concurrent rooms with forced code collisions, each with a distinct code', async () => {
    const forced = generateRoomCode();
    let calls = 0;
    codeSource = () => {
      calls += 1;
      return calls <= 5 ? forced : generateRoomCode();
    };
    try {
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          api(carol, 'POST', roomPaths.collection, { name: 'race', isPrivate: false }),
        ),
      );
      expect(results.map((result) => result.status)).toEqual([201, 201, 201, 201, 201]);
      const codes = results.map((result) => roomOf(result).code);
      expect(new Set(codes).size).toBe(5);
      for (const result of results) {
        const room = roomOf(result);
        expect((await memberRows(room.id)).map((row) => row.userId)).toEqual([carol.userId]);
      }
    } finally {
      codeSource = undefined;
    }
  });
});

describe('GET /rooms', () => {
  it('lists the rooms of the caller, most recently joined first, with presentCount', async () => {
    const zed = await signUpTestUser(requireHarness(), 'zed');
    const mine = await createRoom(zed, { name: 'mine' });
    const publicOne = await createRoom(alice, { name: 'alice public' });
    const privateOne = await createRoom(alice, { name: 'alice private', isPrivate: true });
    await createRoom(alice, { name: 'not zed' });
    await joinAs(zed, publicOne);
    await approveInto(alice, zed, privateOne);

    resetLive();
    requireApp().live.counts.set(publicOne.id, 3);
    const result = await api(zed, 'GET', roomPaths.collection);
    expect(result.status).toBe(200);
    const list = roomListResponseSchema.parse(result.body).rooms;
    expect(list.map((room) => room.id)).toEqual([privateOne.id, publicOne.id, mine.id]);
    expect(list.map((room) => room.presentCount)).toEqual([0, 3, 0]);
    expect(list[0]).toMatchObject({ hostId: alice.userId, isPrivate: true });
  });

  it('answers an empty list for a user with no rooms', async () => {
    const empty = await signUpTestUser(requireHarness(), 'empty');
    const result = await api(empty, 'GET', roomPaths.collection);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ rooms: [] });
  });

  it('answers with presentCount 0 when the live side fails, and logs it', async () => {
    const zed = await signUpTestUser(requireHarness(), 'zed');
    const room = await createRoom(zed);
    resetLive();
    requireApp().live.failPresentCounts = true;
    const result = await api(zed, 'GET', roomPaths.collection);
    expect(result.status).toBe(200);
    expect(roomListResponseSchema.parse(result.body).rooms).toMatchObject([
      { id: room.id, presentCount: 0 },
    ]);
    expect(requireApp().spies.warn).toHaveBeenCalled();
  });

  it('rejects an unsupported scope and unknown query keys', async () => {
    expect((await api(alice, 'GET', '/rooms?scope=public')).status).toBe(400);
    expect((await api(alice, 'GET', '/rooms?scope=mine&userId=x')).status).toBe(400);
    expect((await api(alice, 'GET', '/rooms?scope=mine')).status).toBe(200);
  });
});

describe('GET /rooms/by-code/:code', () => {
  it('tells the host, a member, a joiner and a knocker apart', async () => {
    const publicRoom = await createRoom(alice, { name: 'open' });
    const privateRoom = await createRoom(alice, { name: 'closed', isPrivate: true });
    await joinAs(bob, publicRoom);

    const lookup = async (user: TestUser, code: string) =>
      roomLookupResponseSchema.parse((await api(user, 'GET', roomByCodePath(code))).body);

    expect(await lookup(alice, publicRoom.code)).toMatchObject({
      access: 'host',
      room: { id: publicRoom.id, hostId: alice.userId },
    });
    expect(await lookup(bob, publicRoom.code)).toMatchObject({ access: 'member' });
    expect(await lookup(carol, publicRoom.code)).toMatchObject({ access: 'can_join' });
    expect(await lookup(carol, privateRoom.code)).toMatchObject({
      access: 'must_knock',
      presentCount: null,
    });
    expect(await lookup(alice, privateRoom.code)).toMatchObject({ access: 'host' });
  });

  it('shows a non-member exactly the preview and nothing else', async () => {
    const privateRoom = await createRoom(alice, { name: 'closed', isPrivate: true });
    const publicRoom = await createRoom(alice, { name: 'open' });
    for (const room of [privateRoom, publicRoom]) {
      const result = await api(carol, 'GET', roomByCodePath(room.code));
      const body = result.body as { room: Record<string, unknown> };
      expect(Object.keys(body.room).sort()).toEqual(['code', 'id', 'isPrivate', 'name']);
      expect(body.room).toEqual({
        id: room.id,
        code: room.code,
        name: room.name,
        isPrivate: room.isPrivate,
      });
    }
  });

  it('reports the present count of a public room to a joiner, 0 when live fails', async () => {
    const room = await createRoom(alice);
    resetLive();
    requireApp().live.counts.set(room.id, 2);
    const ok = roomLookupResponseSchema.parse(
      (await api(carol, 'GET', roomByCodePath(room.code))).body,
    );
    expect(ok.presentCount).toBe(2);
    requireApp().live.failPresentCounts = true;
    const degraded = await api(carol, 'GET', roomByCodePath(room.code));
    expect(degraded.status).toBe(200);
    expect(roomLookupResponseSchema.parse(degraded.body).presentCount).toBe(0);
  });

  it('forgives case and whitespace in the typed code', async () => {
    const room = await createRoom(alice);
    const typed = `${room.code.slice(0, 3).toLowerCase()} ${room.code.slice(3)}`;
    const result = await api(carol, 'GET', roomByCodePath(typed));
    expect(result.status).toBe(200);
    expect(roomLookupResponseSchema.parse(result.body).room.id).toBe(room.id);
  });

  it('rejects an unknown query key with 400 and still serves the plain request', async () => {
    const room = await createRoom(alice);
    const bad = await api(carol, 'GET', `${roomByCodePath(room.code)}?userId=${alice.userId}`);
    expect(bad.status).toBe(400);
    expect(errorCodeOf(bad)).toBe('VALIDATION_FAILED');
    expect((await api(carol, 'GET', roomByCodePath(room.code))).status).toBe(200);
  });

  it('shows access "member" to a member of a private room', async () => {
    const room = await createRoom(alice, { isPrivate: true });
    await approveInto(alice, bob, room);
    const lookup = roomLookupResponseSchema.parse(
      (await api(bob, 'GET', roomByCodePath(room.code))).body,
    );
    expect(lookup.access).toBe('member');
    expect(lookup.room).toMatchObject({ id: room.id, hostId: alice.userId });
  });

  it('answers 404 for an unknown code and 400 for a malformed one', async () => {
    const unknown = await api(carol, 'GET', roomByCodePath('ZZZZZ9'));
    expect(unknown.status).toBe(404);
    expect(errorCodeOf(unknown)).toBe('ROOM_NOT_FOUND');
    for (const bad of ['ABC', 'ABCDEFG', 'ABCIO0', 'ab-234']) {
      const result = await api(carol, 'GET', roomByCodePath(bad));
      expect(result.status).toBe(400);
      expect(errorCodeOf(result)).toBe('VALIDATION_FAILED');
    }
  });
});

describe('GET /rooms/:roomId', () => {
  it('is for members only; everyone else gets the same 404 as for a missing room', async () => {
    const privateRoom = await createRoom(alice, { isPrivate: true });
    const publicRoom = await createRoom(alice);
    await joinAs(bob, publicRoom);

    expect((await api(alice, 'GET', url(roomPaths.item, privateRoom.id))).status).toBe(200);
    expect(roomOf(await api(bob, 'GET', url(roomPaths.item, publicRoom.id))).id).toBe(
      publicRoom.id,
    );

    const foreignPrivate = await api(carol, 'GET', url(roomPaths.item, privateRoom.id));
    const foreignPublic = await api(carol, 'GET', url(roomPaths.item, publicRoom.id));
    const missing = await api(carol, 'GET', url(roomPaths.item, uuidv7()));
    for (const result of [foreignPrivate, foreignPublic, missing]) {
      expect(result.status).toBe(404);
      expect(errorCodeOf(result)).toBe('ROOM_NOT_FOUND');
    }
    expect(foreignPrivate.body).toEqual(missing.body);
    expect(foreignPublic.body).toEqual(missing.body);
  });

  it('rejects a malformed room id with 400', async () => {
    const result = await api(alice, 'GET', '/rooms/not-a-uuid');
    expect(result.status).toBe(400);
  });
});

describe('PATCH /rooms/:roomId/timer-settings', () => {
  it('lets the host change some durations, saves them and announces the new settings', async () => {
    const room = await createRoom(alice);
    resetLive();
    const result = await api(alice, 'PATCH', url(roomPaths.timerSettings, room.id), {
      focusSeconds: 3000,
      longBreakSeconds: 1200,
    });
    expect(result.status).toBe(200);
    expect(roomOf(result).timerSettings).toEqual({
      focusSeconds: 3000,
      shortBreakSeconds: 300,
      longBreakSeconds: 1200,
    });
    const [row] = await requireHarness().db.select().from(rooms).where(eq(rooms.id, room.id));
    expect(row).toMatchObject({
      focusSeconds: 3000,
      shortBreakSeconds: 300,
      longBreakSeconds: 1200,
    });
    expect(requireApp().live.calls).toEqual([
      {
        name: 'announceSettingsUpdated',
        args: [room.id, { focusSeconds: 3000, shortBreakSeconds: 300, longBreakSeconds: 1200 }],
      },
    ]);
  });

  it('still answers 200 and logs when the announcement fails', async () => {
    const room = await createRoom(alice);
    resetLive();
    requireApp().live.failAnnouncements = true;
    const result = await api(alice, 'PATCH', url(roomPaths.timerSettings, room.id), {
      shortBreakSeconds: 600,
    });
    expect(result.status).toBe(200);
    expect(roomOf(result).timerSettings.shortBreakSeconds).toBe(600);
    expect(requireApp().spies.error).toHaveBeenCalled();
  });

  it('answers 403 NOT_HOST to a member and 404 to a non-member or a missing room, changing nothing', async () => {
    const room = await createRoom(alice);
    await joinAs(bob, room);
    resetLive();

    const member = await api(bob, 'PATCH', url(roomPaths.timerSettings, room.id), {
      focusSeconds: 600,
    });
    expect(member.status).toBe(403);
    expect(errorCodeOf(member)).toBe('NOT_HOST');

    const stranger = await api(carol, 'PATCH', url(roomPaths.timerSettings, room.id), {
      focusSeconds: 600,
    });
    expect(stranger.status).toBe(404);
    expect(errorCodeOf(stranger)).toBe('ROOM_NOT_FOUND');

    const missing = await api(carol, 'PATCH', url(roomPaths.timerSettings, uuidv7()), {
      focusSeconds: 600,
    });
    expect(missing.status).toBe(404);

    expect(requireApp().live.calls).toHaveLength(0);
    const [row] = await requireHarness().db.select().from(rooms).where(eq(rooms.id, room.id));
    expect(row?.focusSeconds).toBe(1500);
  });

  const bounds = [
    ['focusSeconds', ROOM_FOCUS_SECONDS],
    ['shortBreakSeconds', ROOM_SHORT_BREAK_SECONDS],
    ['longBreakSeconds', ROOM_LONG_BREAK_SECONDS],
  ] as const;

  it.each(bounds)(
    'accepts %s at its minimum and maximum and refuses one beyond',
    async (field, range) => {
      const room = await createRoom(alice);
      const patch = (value: number) =>
        api(alice, 'PATCH', url(roomPaths.timerSettings, room.id), { [field]: value });
      const stored = async () => {
        const [row] = await requireHarness().db.select().from(rooms).where(eq(rooms.id, room.id));
        return row?.[field];
      };

      expect((await patch(range.min)).status).toBe(200);
      expect(await stored()).toBe(range.min);
      expect((await patch(range.max)).status).toBe(200);
      expect(await stored()).toBe(range.max);

      for (const value of [range.min - 1, range.max + 1]) {
        resetLive();
        const refused = await patch(value);
        expect(refused.status, `${field}=${String(value)}`).toBe(400);
        expect(errorCodeOf(refused)).toBe('VALIDATION_FAILED');
        expect(requireApp().live.calls).toHaveLength(0);
        expect(await stored()).toBe(range.max);
      }
    },
  );

  it.each([
    ['an empty body', {}],
    ['an unknown key', { focusSeconds: 600, hostId: uuidv7() }],
    ['an out-of-range duration', { focusSeconds: 20_000 }],
    ['a non-integer duration', { focusSeconds: 600.5 }],
    ['a string duration', { focusSeconds: '600' }],
  ])('rejects %s with 400 and announces nothing', async (_label, body) => {
    const room = await createRoom(alice);
    resetLive();
    const result = await api(alice, 'PATCH', url(roomPaths.timerSettings, room.id), body);
    expect(result.status).toBe(400);
    expect(requireApp().live.calls).toHaveLength(0);
  });
});

describe('GET /rooms/:roomId/members', () => {
  it('lists members by join time, marks the host and never exposes email', async () => {
    const room = await createRoom(alice, { isPrivate: false });
    await joinAs(bob, room);
    await joinAs(carol, room);

    const result = await api(bob, 'GET', url(roomPaths.members, room.id));
    expect(result.status).toBe(200);
    const members = roomMembersResponseSchema.parse(result.body).members;
    expect(members.map((member) => member.userId)).toEqual([
      alice.userId,
      bob.userId,
      carol.userId,
    ]);
    expect(members.map((member) => member.isHost)).toEqual([true, false, false]);
    expect(Object.keys(members[0] ?? {}).sort()).toEqual([
      'avatarUrl',
      'displayName',
      'isHost',
      'joinedAt',
      'userId',
    ]);
    expect(JSON.stringify(result.body)).not.toContain('@example.com');
  });

  it('answers 404 to non-members and for a missing room', async () => {
    const room = await createRoom(alice, { isPrivate: true });
    expect((await api(carol, 'GET', url(roomPaths.members, room.id))).status).toBe(404);
    expect((await api(carol, 'GET', url(roomPaths.members, uuidv7()))).status).toBe(404);
  });
});

describe('POST /rooms/:roomId/membership', () => {
  it('creates a public membership once (201) and is idempotent afterwards (200)', async () => {
    const room = await createRoom(alice);
    resetLive();

    const first = await api(bob, 'POST', url(roomPaths.membership, room.id));
    expect(first.status).toBe(201);
    const membership = roomMembershipResponseSchema.parse(first.body).membership;
    expect(membership).toMatchObject({ roomId: room.id, userId: bob.userId });

    const second = await api(bob, 'POST', url(roomPaths.membership, room.id));
    expect(second.status).toBe(200);
    expect(roomMembershipResponseSchema.parse(second.body).membership.joinedAt).toBe(
      membership.joinedAt,
    );

    const live = requireApp().live;
    expect(live.names()).toEqual(['announceMemberJoined']);
    expect(live.calls[0]?.args).toMatchObject([
      room.id,
      { userId: bob.userId, isHost: false, displayName: 'Test User' },
    ]);
  });

  it('answers 200 for the host without announcing', async () => {
    const room = await createRoom(alice);
    resetLive();
    const result = await api(alice, 'POST', url(roomPaths.membership, room.id));
    expect(result.status).toBe(200);
    expect(requireApp().live.calls).toHaveLength(0);
  });

  it('refuses a private room to a non-member with 403 KNOCK_REQUIRED and creates nothing', async () => {
    const room = await createRoom(alice, { isPrivate: true });
    resetLive();
    const result = await api(bob, 'POST', url(roomPaths.membership, room.id));
    expect(result.status).toBe(403);
    expect(errorCodeOf(result)).toBe('KNOCK_REQUIRED');
    expect(await memberRows(room.id)).toHaveLength(1);
    expect(requireApp().live.calls).toHaveLength(0);
  });

  it('answers 200 to a member of a private room', async () => {
    const room = await createRoom(alice, { isPrivate: true });
    await approveInto(alice, bob, room);
    resetLive();
    const result = await api(bob, 'POST', url(roomPaths.membership, room.id));
    expect(result.status).toBe(200);
    expect(requireApp().live.calls).toHaveLength(0);
  });

  it('answers 404 for a missing room and 400 for a bad id', async () => {
    expect((await api(bob, 'POST', url(roomPaths.membership, uuidv7()))).status).toBe(404);
    expect((await api(bob, 'POST', '/rooms/nope/membership')).status).toBe(400);
  });

  it('still answers success and logs when the announcement fails', async () => {
    const room = await createRoom(alice);
    resetLive();
    requireApp().live.failAnnouncements = true;
    const result = await api(bob, 'POST', url(roomPaths.membership, room.id));
    expect(result.status).toBe(201);
    expect(requireApp().spies.error).toHaveBeenCalled();
    expect(await memberRows(room.id)).toHaveLength(2);
  });

  it('with ten parallel joins creates one row: one 201, nine 200, one announcement', async () => {
    const room = await createRoom(alice);
    resetLive();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => api(carol, 'POST', url(roomPaths.membership, room.id))),
    );
    const statuses = results.map((result) => result.status).sort((a, b) => a - b);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 201]);
    expect(await memberRows(room.id)).toHaveLength(2);
    expect(
      requireApp()
        .live.names()
        .filter((name) => name === 'announceMemberJoined'),
    ).toHaveLength(1);
  });

  it('keeps a join, its announcement and a removal in order when the removal lands in between', async () => {
    const room = await createRoom(alice);
    const live = requireApp().live;
    // The join is committed; before its announcement goes out the host removes Bob.
    live.onAnnounceMemberJoined = async () => {
      live.onAnnounceMemberJoined = undefined;
      const removal = await api(alice, 'DELETE', url(roomPaths.member, room.id, bob.userId));
      expect(removal.status).toBe(204);
    };
    const join = await api(bob, 'POST', url(roomPaths.membership, room.id));
    expect(join.status).toBe(201);
    expect((await memberRows(room.id)).map((row) => row.userId)).toEqual([alice.userId]);
    expect(live.names()).toEqual(['announceMemberJoined', 'announceMemberRemoved']);
    expect(requireApp().spies.error).not.toHaveBeenCalled();
  });

  it('leaves a member row exactly when the join ran after the removal, announced consistently', async () => {
    const live = requireApp().live;
    for (let round = 0; round < 12; round += 1) {
      const room = await createRoom(alice);
      await joinAs(bob, room);
      resetLive();
      const [join, removal] = await Promise.all([
        api(bob, 'POST', url(roomPaths.membership, room.id)),
        api(alice, 'DELETE', url(roomPaths.member, room.id, bob.userId)),
      ]);
      expect([200, 201, 404]).toContain(join.status);
      expect(removal.status).toBe(204);

      const rows = await memberRows(room.id);
      const bobIsMember = rows.some((row) => row.userId === bob.userId);
      expect(rows.some((row) => row.userId === alice.userId)).toBe(true);
      // A 201 means Bob's row was absent, so the removal had already run: the row is his.
      // A 200 or 404 means the row existed when the join looked, so the removal deleted it.
      expect(bobIsMember).toBe(join.status === 201);
      expect(live.names().filter((name) => name === 'announceMemberRemoved')).toHaveLength(1);
      expect(live.names().filter((name) => name === 'announceMemberJoined')).toHaveLength(
        join.status === 201 ? 1 : 0,
      );
    }
  });

  it('lets a removed user rejoin a public room, but not a private one without a new approval', async () => {
    const publicRoom = await createRoom(alice);
    await joinAs(bob, publicRoom);
    await api(alice, 'DELETE', url(roomPaths.member, publicRoom.id, bob.userId));
    expect((await api(bob, 'POST', url(roomPaths.membership, publicRoom.id))).status).toBe(201);

    const privateRoom = await createRoom(alice, { isPrivate: true });
    await approveInto(alice, bob, privateRoom);
    expect(
      (await api(alice, 'DELETE', url(roomPaths.member, privateRoom.id, bob.userId))).status,
    ).toBe(204);
    const rejoin = await api(bob, 'POST', url(roomPaths.membership, privateRoom.id));
    expect(rejoin.status).toBe(403);
    expect(errorCodeOf(rejoin)).toBe('KNOCK_REQUIRED');
    expect((await memberRows(privateRoom.id)).some((row) => row.userId === bob.userId)).toBe(false);
  });

  it('after a removal the room is gone for the user except as a lookup preview', async () => {
    const room = await createRoom(alice, { isPrivate: true });
    await approveInto(alice, bob, room);
    await api(alice, 'DELETE', url(roomPaths.member, room.id, bob.userId));

    const removedLookup = roomLookupResponseSchema.parse(
      (await api(bob, 'GET', roomByCodePath(room.code))).body,
    );
    expect(removedLookup.access).toBe('must_knock');
    expect(removedLookup.presentCount).toBeNull();
    const hostLookup = roomLookupResponseSchema.parse(
      (await api(alice, 'GET', roomByCodePath(room.code))).body,
    );
    expect(hostLookup.access).toBe('host');
    const read = await api(bob, 'GET', url(roomPaths.item, room.id));
    expect(read.status).toBe(404);
    expect(errorCodeOf(read)).toBe('ROOM_NOT_FOUND');

    const publicRoom = await createRoom(alice);
    await joinAs(bob, publicRoom);
    await api(alice, 'DELETE', url(roomPaths.member, publicRoom.id, bob.userId));
    expect(
      roomLookupResponseSchema.parse((await api(bob, 'GET', roomByCodePath(publicRoom.code))).body)
        .access,
    ).toBe('can_join');
    expect((await api(bob, 'GET', url(roomPaths.item, publicRoom.id))).status).toBe(404);
  });
});

describe('DELETE /rooms/:roomId/membership', () => {
  it('lets a member leave, announces once and is repeatable', async () => {
    const room = await createRoom(alice);
    await joinAs(bob, room);
    resetLive();

    const first = await api(bob, 'DELETE', url(roomPaths.membership, room.id));
    expect(first.status).toBe(204);
    expect(await memberRows(room.id)).toHaveLength(1);
    expect(requireApp().live.calls).toEqual([
      { name: 'announceMemberRemoved', args: [room.id, bob.userId, 'left'] },
    ]);

    const second = await api(bob, 'DELETE', url(roomPaths.membership, room.id));
    expect(second.status).toBe(204);
    expect(requireApp().live.calls).toHaveLength(1);
  });

  it('refuses the host with 409 HOST_CANNOT_LEAVE', async () => {
    const room = await createRoom(alice);
    resetLive();
    const result = await api(alice, 'DELETE', url(roomPaths.membership, room.id));
    expect(result.status).toBe(409);
    expect(errorCodeOf(result)).toBe('HOST_CANNOT_LEAVE');
    expect(await memberRows(room.id)).toHaveLength(1);
    expect(requireApp().live.calls).toHaveLength(0);
  });

  it('answers 204 without revealing anything to a non-member or for a missing room', async () => {
    const room = await createRoom(alice, { isPrivate: true });
    resetLive();
    expect((await api(carol, 'DELETE', url(roomPaths.membership, room.id))).status).toBe(204);
    expect((await api(carol, 'DELETE', url(roomPaths.membership, uuidv7()))).status).toBe(204);
    expect(requireApp().live.calls).toHaveLength(0);
    expect(await memberRows(room.id)).toHaveLength(1);
  });

  it("does not delete another user's membership: DELETE acts on the caller only", async () => {
    const room = await createRoom(bob);
    await joinAs(carol, room);
    await joinAs(alice, room);
    const bobRow = (await memberRows(room.id)).find((row) => row.userId === bob.userId);
    expect(bobRow).toBeDefined();
    resetLive();

    expect((await api(carol, 'DELETE', url(roomPaths.membership, room.id))).status).toBe(204);
    const remaining = await memberRows(room.id);
    expect(remaining.map((row) => row.userId).sort()).toEqual([alice.userId, bob.userId].sort());
    expect(remaining.find((row) => row.userId === bob.userId)).toEqual(bobRow);
    expect(requireApp().live.calls).toEqual([
      { name: 'announceMemberRemoved', args: [room.id, carol.userId, 'left'] },
    ]);
  });

  it('can rejoin a public room after leaving', async () => {
    const room = await createRoom(alice);
    await joinAs(bob, room);
    await api(bob, 'DELETE', url(roomPaths.membership, room.id));
    expect((await api(bob, 'POST', url(roomPaths.membership, room.id))).status).toBe(201);
  });
});

describe('DELETE /rooms/:roomId/members/:userId', () => {
  it('lets the host remove a member, announces "removed" once and is repeatable', async () => {
    const room = await createRoom(alice);
    await joinAs(bob, room);
    resetLive();

    const first = await api(alice, 'DELETE', url(roomPaths.member, room.id, bob.userId));
    expect(first.status).toBe(204);
    expect(requireApp().live.calls).toEqual([
      { name: 'announceMemberRemoved', args: [room.id, bob.userId, 'removed'] },
    ]);
    expect((await memberRows(room.id)).map((row) => row.userId)).toEqual([alice.userId]);

    const second = await api(alice, 'DELETE', url(roomPaths.member, room.id, bob.userId));
    expect(second.status).toBe(204);
    expect(requireApp().live.calls).toHaveLength(1);
  });

  it('removing a user who was never a member answers 204 and announces nothing', async () => {
    const room = await createRoom(alice);
    resetLive();
    expect((await api(alice, 'DELETE', url(roomPaths.member, room.id, carol.userId))).status).toBe(
      204,
    );
    expect((await api(alice, 'DELETE', url(roomPaths.member, room.id, uuidv7()))).status).toBe(204);
    expect(requireApp().live.calls).toHaveLength(0);
  });

  it('refuses to remove the host with 409 CANNOT_REMOVE_HOST', async () => {
    const room = await createRoom(alice);
    resetLive();
    const result = await api(alice, 'DELETE', url(roomPaths.member, room.id, alice.userId));
    expect(result.status).toBe(409);
    expect(errorCodeOf(result)).toBe('CANNOT_REMOVE_HOST');
    expect(await memberRows(room.id)).toHaveLength(1);
    expect(requireApp().live.calls).toHaveLength(0);
  });

  it('answers 403 NOT_HOST to a member and 404 to a non-member or a missing room', async () => {
    const room = await createRoom(alice);
    await joinAs(bob, room);
    await joinAs(carol, room);
    resetLive();

    const member = await api(bob, 'DELETE', url(roomPaths.member, room.id, carol.userId));
    expect(member.status).toBe(403);
    expect(errorCodeOf(member)).toBe('NOT_HOST');

    const outsider = await signUpTestUser(requireHarness(), 'outsider');
    const stranger = await api(outsider, 'DELETE', url(roomPaths.member, room.id, carol.userId));
    expect(stranger.status).toBe(404);
    expect(errorCodeOf(stranger)).toBe('ROOM_NOT_FOUND');
    expect(
      (await api(outsider, 'DELETE', url(roomPaths.member, uuidv7(), carol.userId))).status,
    ).toBe(404);

    expect(await memberRows(room.id)).toHaveLength(3);
    expect(requireApp().live.calls).toHaveLength(0);
  });

  it('rejects a malformed user id with 400', async () => {
    const room = await createRoom(alice);
    expect((await api(alice, 'DELETE', `/rooms/${room.id}/members/nope`)).status).toBe(400);
  });

  it('still answers 204 and logs when the announcement fails', async () => {
    const room = await createRoom(alice);
    await joinAs(bob, room);
    resetLive();
    requireApp().live.failAnnouncements = true;
    expect((await api(alice, 'DELETE', url(roomPaths.member, room.id, bob.userId))).status).toBe(
      204,
    );
    expect(requireApp().spies.error).toHaveBeenCalled();
  });
});

describe('POST /rooms/:roomId/knocks/:userId/approve', () => {
  const knock = (roomId: string, userId: string): void => {
    requireApp().live.pendingKnocks.add(`${roomId}:${userId}`);
  };

  it('approves a pending knock: membership created, knock resolved, member announced', async () => {
    const room = await createRoom(alice, { isPrivate: true });
    resetLive();
    knock(room.id, bob.userId);

    const result = await api(alice, 'POST', url(roomPaths.approveKnock, room.id, bob.userId));
    expect(result.status).toBe(201);
    expect(roomMembershipResponseSchema.parse(result.body).membership).toMatchObject({
      roomId: room.id,
      userId: bob.userId,
    });
    expect((await memberRows(room.id)).map((row) => row.userId).sort()).toEqual(
      [alice.userId, bob.userId].sort(),
    );
    expect(requireApp().live.names()).toEqual([
      'isKnockPending',
      'resolveKnock',
      'announceMemberJoined',
    ]);
    expect(requireApp().live.calls[1]?.args).toEqual([
      room.id,
      alice.userId,
      bob.userId,
      'approved',
    ]);

    // Bob can now read the room and join again idempotently.
    expect((await api(bob, 'GET', url(roomPaths.item, room.id))).status).toBe(200);
    expect((await api(bob, 'POST', url(roomPaths.membership, room.id))).status).toBe(200);
  });

  it('answers 200 for an existing member without needing a pending knock', async () => {
    const room = await createRoom(alice, { isPrivate: true });
    await approveInto(alice, bob, room);
    resetLive();
    const result = await api(alice, 'POST', url(roomPaths.approveKnock, room.id, bob.userId));
    expect(result.status).toBe(200);
    expect(requireApp().live.names()).not.toContain('announceMemberJoined');
    expect(requireApp().live.names()).not.toContain('isKnockPending');
  });

  it('answers 410 KNOCK_EXPIRED when no knock is pending and changes nothing', async () => {
    const room = await createRoom(alice, { isPrivate: true });
    resetLive();
    const result = await api(alice, 'POST', url(roomPaths.approveKnock, room.id, bob.userId));
    expect(result.status).toBe(410);
    expect(errorCodeOf(result)).toBe('KNOCK_EXPIRED');
    expect(await memberRows(room.id)).toHaveLength(1);
    expect(requireApp().live.names()).toEqual(['isKnockPending']);
  });

  it('answers 410 for a pending knock of a user that does not exist', async () => {
    const room = await createRoom(alice, { isPrivate: true });
    resetLive();
    const ghost = uuidv7();
    knock(room.id, ghost);
    const result = await api(alice, 'POST', url(roomPaths.approveKnock, room.id, ghost));
    expect(result.status).toBe(410);
    expect(await memberRows(room.id)).toHaveLength(1);
  });

  it('answers 503 and changes nothing when the knock state cannot be read', async () => {
    const room = await createRoom(alice, { isPrivate: true });
    resetLive();
    knock(room.id, bob.userId);
    requireApp().live.failKnockState = true;
    const result = await api(alice, 'POST', url(roomPaths.approveKnock, room.id, bob.userId));
    expect(result.status).toBe(503);
    expect(await memberRows(room.id)).toHaveLength(1);
    expect(requireApp().live.names()).toEqual(['isKnockPending']);
  });

  it('answers 409 NOT_PRIVATE for a public room', async () => {
    const room = await createRoom(alice);
    resetLive();
    knock(room.id, bob.userId);
    const result = await api(alice, 'POST', url(roomPaths.approveKnock, room.id, bob.userId));
    expect(result.status).toBe(409);
    expect(errorCodeOf(result)).toBe('NOT_PRIVATE');
    expect(await memberRows(room.id)).toHaveLength(1);
    expect(requireApp().live.calls).toHaveLength(0);
  });

  it('answers 403 NOT_HOST to a member and 404 to a non-member or a missing room', async () => {
    const room = await createRoom(alice, { isPrivate: true });
    await approveInto(alice, bob, room);
    resetLive();
    knock(room.id, carol.userId);

    const member = await api(bob, 'POST', url(roomPaths.approveKnock, room.id, carol.userId));
    expect(member.status).toBe(403);
    expect(errorCodeOf(member)).toBe('NOT_HOST');
    const stranger = await api(carol, 'POST', url(roomPaths.approveKnock, room.id, carol.userId));
    expect(stranger.status).toBe(404);
    expect(errorCodeOf(stranger)).toBe('ROOM_NOT_FOUND');
    const missing = await api(alice, 'POST', url(roomPaths.approveKnock, uuidv7(), carol.userId));
    expect(missing.status).toBe(404);

    expect(await memberRows(room.id)).toHaveLength(2);
    expect(requireApp().live.calls).toHaveLength(0);
  });

  it('with two parallel approvals creates one membership: one 201, one 200, one announcement', async () => {
    const room = await createRoom(alice, { isPrivate: true });
    knock(room.id, carol.userId);
    const results = await Promise.all([
      api(alice, 'POST', url(roomPaths.approveKnock, room.id, carol.userId)),
      api(alice, 'POST', url(roomPaths.approveKnock, room.id, carol.userId)),
    ]);
    expect(results.map((result) => result.status).sort((a, b) => a - b)).toEqual([200, 201]);
    for (const result of results) {
      expect(roomMembershipResponseSchema.parse(result.body).membership.userId).toBe(carol.userId);
    }
    expect((await memberRows(room.id)).filter((row) => row.userId === carol.userId)).toHaveLength(
      1,
    );
    expect(requireApp().live.pendingKnocks.has(`${room.id}:${carol.userId}`)).toBe(false);
    expect(
      requireApp()
        .live.names()
        .filter((name) => name === 'announceMemberJoined'),
    ).toHaveLength(1);
  });

  it('keeps the rejection when a reject wins between the check and the insert: 410, no membership, no announcement', async () => {
    const room = await createRoom(alice, { isPrivate: true });
    const live = requireApp().live;
    knock(room.id, bob.userId);
    // The host's approve has read "pending"; before it inserts, another click rejects.
    live.afterIsKnockPending = async () => {
      live.afterIsKnockPending = undefined;
      const rejected = await api(alice, 'POST', url(roomPaths.rejectKnock, room.id, bob.userId));
      expect(rejected.status).toBe(204);
    };
    const approve = await api(alice, 'POST', url(roomPaths.approveKnock, room.id, bob.userId));
    expect(approve.status).toBe(410);
    expect(errorCodeOf(approve)).toBe('KNOCK_EXPIRED');
    expect(await memberRows(room.id)).toHaveLength(1);
    expect(live.names()).not.toContain('announceMemberJoined');
    // The reject removed the knock; the approve's own removal found nothing.
    expect(
      live.calls.filter((call) => call.name === 'resolveKnock').map((call) => call.args[3]),
    ).toEqual(['rejected', 'approved']);
    expect((await api(bob, 'GET', url(roomPaths.item, room.id))).status).toBe(404);
  });

  it('keeps the approval when the approve wins: the later reject changes nothing', async () => {
    const room = await createRoom(alice, { isPrivate: true });
    knock(room.id, bob.userId);
    expect(
      (await api(alice, 'POST', url(roomPaths.approveKnock, room.id, bob.userId))).status,
    ).toBe(201);
    expect((await api(alice, 'POST', url(roomPaths.rejectKnock, room.id, bob.userId))).status).toBe(
      204,
    );
    expect((await memberRows(room.id)).some((row) => row.userId === bob.userId)).toBe(true);
  });

  it('answers 410 and leaves no membership when the knock expires between the check and the removal', async () => {
    const room = await createRoom(alice, { isPrivate: true });
    const live = requireApp().live;
    knock(room.id, bob.userId);
    live.afterIsKnockPending = () => {
      live.pendingKnocks.clear(); // the TTL ran out
      return Promise.resolve();
    };
    const approve = await api(alice, 'POST', url(roomPaths.approveKnock, room.id, bob.userId));
    expect(approve.status).toBe(410);
    expect(await memberRows(room.id)).toHaveLength(1);
    expect(live.names()).not.toContain('announceMemberJoined');
  });

  describe('when the approve loses the knock to a reject after the membership was created', () => {
    // One in-progress session per user: start each test without the previous one's.
    beforeEach(async () => {
      await requireHarness().db.delete(focusSessions);
    });

    const openFocusSession = async (roomId: string, user: TestUser): Promise<string> => {
      const id = uuidv7();
      await requireHarness().db.insert(focusSessions).values({
        id,
        userId: user.userId,
        status: 'in_progress',
        roomId,
        focusRunId: uuidv7(),
        plannedSeconds: 1500,
        focusedSeconds: 0,
        startedAt: new Date(),
      });
      return id;
    };

    const sessionOf = async (id: string) =>
      (await requireHarness().db.select().from(focusSessions).where(eq(focusSessions.id, id)))[0];

    it('takes the same departure path as a removal: membership gone, focus session abandoned, sockets evicted', async () => {
      const room = await createRoom(alice, { isPrivate: true });
      const live = requireApp().live;
      knock(room.id, bob.userId);
      let sessionId = '';
      live.beforeResolveKnock = async () => {
        live.beforeResolveKnock = undefined;
        // The requester became a member a moment ago and has already opted into the run;
        // meanwhile a reject removes the knock first.
        sessionId = await openFocusSession(room.id, bob);
        live.pendingKnocks.delete(`${room.id}:${bob.userId}`);
      };

      const approve = await api(alice, 'POST', url(roomPaths.approveKnock, room.id, bob.userId));
      expect(approve.status).toBe(410);
      expect(errorCodeOf(approve)).toBe('KNOCK_EXPIRED');

      expect((await memberRows(room.id)).some((row) => row.userId === bob.userId)).toBe(false);
      expect(await sessionOf(sessionId)).toMatchObject({
        status: 'abandoned',
        abandonReason: 'removed',
      });
      expect(departureLog).toEqual([`${bob.userId}:removed`]);
      expect(live.calls.filter((call) => call.name === 'announceMemberRemoved')).toEqual([
        { name: 'announceMemberRemoved', args: [room.id, bob.userId, 'removed'] },
      ]);
      expect(live.names()).not.toContain('announceMemberJoined');
    });

    it('still answers the rejection when announcing the removal fails', async () => {
      const room = await createRoom(alice, { isPrivate: true });
      const live = requireApp().live;
      knock(room.id, bob.userId);
      live.beforeResolveKnock = () => {
        live.beforeResolveKnock = undefined;
        live.pendingKnocks.delete(`${room.id}:${bob.userId}`);
        live.failAnnouncements = true;
        return Promise.resolve();
      };
      const approve = await api(alice, 'POST', url(roomPaths.approveKnock, room.id, bob.userId));
      expect(approve.status).toBe(410);
      expect((await memberRows(room.id)).some((row) => row.userId === bob.userId)).toBe(false);
      expect(requireApp().spies.error).toHaveBeenCalledWith(
        expect.objectContaining({ what: 'announceMemberRemoved', roomId: room.id }),
        'Room live follow-up failed after commit',
      );
    });

    it('keeps a membership this call did not create, and leaves its focus session alone', async () => {
      const room = await createRoom(alice, { isPrivate: true });
      const live = requireApp().live;
      knock(room.id, bob.userId);
      let sessionId = '';
      live.afterIsKnockPending = async () => {
        live.afterIsKnockPending = undefined;
        // A concurrent approve (another process) created the membership and resolved the knock.
        await requireHarness().db.insert(roomMembers).values({
          roomId: room.id,
          userId: bob.userId,
        });
        sessionId = await openFocusSession(room.id, bob);
        live.pendingKnocks.delete(`${room.id}:${bob.userId}`);
      };
      const approve = await api(alice, 'POST', url(roomPaths.approveKnock, room.id, bob.userId));
      expect(approve.status).toBe(200);
      expect((await memberRows(room.id)).some((row) => row.userId === bob.userId)).toBe(true);
      expect((await sessionOf(sessionId))?.status).toBe('in_progress');
      expect(live.names()).not.toContain('announceMemberRemoved');
      expect(departureLog).toEqual([]);
    });

    it('does not touch the requester when the approve wins', async () => {
      const room = await createRoom(alice, { isPrivate: true });
      const live = requireApp().live;
      knock(room.id, bob.userId);
      let sessionId = '';
      live.beforeResolveKnock = async () => {
        live.beforeResolveKnock = undefined;
        sessionId = await openFocusSession(room.id, bob);
      };
      const approve = await api(alice, 'POST', url(roomPaths.approveKnock, room.id, bob.userId));
      expect(approve.status).toBe(201);
      expect((await memberRows(room.id)).some((row) => row.userId === bob.userId)).toBe(true);
      expect((await sessionOf(sessionId))?.status).toBe('in_progress');
      expect(live.names()).not.toContain('announceMemberRemoved');
      expect(departureLog).toEqual([]);
    });
  });

  it('still answers success, logs and announces when resolving the knock fails after the commit', async () => {
    const room = await createRoom(alice, { isPrivate: true });
    knock(room.id, bob.userId);
    const live = requireApp().live;
    live.failResolveKnock = true;
    const result = await api(alice, 'POST', url(roomPaths.approveKnock, room.id, bob.userId));
    expect(result.status).toBe(201);
    expect(await memberRows(room.id)).toHaveLength(2);
    expect(requireApp().spies.error).toHaveBeenCalledTimes(1);
    expect(requireApp().spies.error).toHaveBeenCalledWith(
      expect.objectContaining({ what: 'resolveKnock', roomId: room.id }),
      'Room live follow-up failed after commit',
    );
    expect(live.names()).toContain('announceMemberJoined');
  });
});

describe('POST /rooms/:roomId/knocks/:userId/reject', () => {
  it('rejects a knock with 204, repeatably, creating no membership', async () => {
    const room = await createRoom(alice, { isPrivate: true });
    resetLive();
    requireApp().live.pendingKnocks.add(`${room.id}:${bob.userId}`);

    expect((await api(alice, 'POST', url(roomPaths.rejectKnock, room.id, bob.userId))).status).toBe(
      204,
    );
    expect((await api(alice, 'POST', url(roomPaths.rejectKnock, room.id, bob.userId))).status).toBe(
      204,
    );
    expect(requireApp().live.calls.map((call) => call.args[3])).toEqual(['rejected', 'rejected']);
    expect(await memberRows(room.id)).toHaveLength(1);
    expect(requireApp().live.names()).not.toContain('announceMemberJoined');
  });

  it('answers 204 for a public room too, creating nothing', async () => {
    const room = await createRoom(alice);
    expect((await api(alice, 'POST', url(roomPaths.rejectKnock, room.id, bob.userId))).status).toBe(
      204,
    );
    expect(await memberRows(room.id)).toHaveLength(1);
    expect(requireApp().live.names()).not.toContain('announceMemberJoined');
  });

  it('answers 503 and changes nothing when the live side is unreachable', async () => {
    const room = await createRoom(alice, { isPrivate: true });
    resetLive();
    requireApp().live.failKnockState = true;
    const result = await api(alice, 'POST', url(roomPaths.rejectKnock, room.id, bob.userId));
    expect(result.status).toBe(503);
    expect(await memberRows(room.id)).toHaveLength(1);
  });

  it('answers 403 NOT_HOST to a member and 404 to a non-member or a missing room', async () => {
    const room = await createRoom(alice, { isPrivate: true });
    await approveInto(alice, bob, room);
    resetLive();

    const member = await api(bob, 'POST', url(roomPaths.rejectKnock, room.id, carol.userId));
    expect(member.status).toBe(403);
    expect(errorCodeOf(member)).toBe('NOT_HOST');
    expect((await api(carol, 'POST', url(roomPaths.rejectKnock, room.id, bob.userId))).status).toBe(
      404,
    );
    expect(
      (await api(alice, 'POST', url(roomPaths.rejectKnock, uuidv7(), bob.userId))).status,
    ).toBe(404);
    expect(requireApp().live.calls).toHaveLength(0);
  });
});

describe('cross-user isolation on a private room', () => {
  it('shows an outsider nothing and lets them change nothing', async () => {
    const room = await createRoom(alice, { isPrivate: true, name: 'secret plans' });
    await approveInto(alice, bob, room);
    resetLive();

    const attempts: [string, string, unknown][] = [
      ['GET', url(roomPaths.item, room.id), undefined],
      ['PATCH', url(roomPaths.timerSettings, room.id), { focusSeconds: 600 }],
      ['GET', url(roomPaths.members, room.id), undefined],
      ['DELETE', url(roomPaths.member, room.id, bob.userId), undefined],
      ['POST', url(roomPaths.approveKnock, room.id, carol.userId), undefined],
      ['POST', url(roomPaths.rejectKnock, room.id, bob.userId), undefined],
    ];
    for (const [method, path, body] of attempts) {
      const result = await api(carol, method, path, body);
      expect(result.status, `${method} ${path}`).toBe(404);
      expect(errorCodeOf(result)).toBe('ROOM_NOT_FOUND');
      expect(JSON.stringify(result.body)).not.toContain('secret plans');
    }

    const join = await api(carol, 'POST', url(roomPaths.membership, room.id));
    expect(join.status).toBe(403);
    expect(errorCodeOf(join)).toBe('KNOCK_REQUIRED');
    expect((await api(carol, 'DELETE', url(roomPaths.membership, room.id))).status).toBe(204);

    const list = roomListResponseSchema.parse((await api(carol, 'GET', roomPaths.collection)).body);
    expect(list.rooms.map((entry) => entry.id)).not.toContain(room.id);

    expect(await memberRows(room.id)).toHaveLength(2);
    expect(
      requireApp()
        .live.names()
        .filter((name) => name !== 'presentCounts'),
    ).toEqual([]);
    const [row] = await requireHarness().db.select().from(rooms).where(eq(rooms.id, room.id));
    expect(row?.focusSeconds).toBe(1500);
  });
});

describe('the real runtime', () => {
  it('serves the room flow end to end through the application wiring', async () => {
    const base = requireHarness().baseUrl;
    const host = await signUpTestUser(requireHarness(), 'host');
    const guest = await signUpTestUser(requireHarness(), 'guest');

    const created = await callApi(base, host, 'POST', roomPaths.collection, {
      name: 'Wired',
      isPrivate: false,
    });
    expect(created.status).toBe(201);
    const room = roomOf(created);

    const lookup = await callApi(base, guest, 'GET', roomByCodePath(room.code));
    expect(roomLookupResponseSchema.parse(lookup.body).access).toBe('can_join');
    expect((await callApi(base, guest, 'POST', url(roomPaths.membership, room.id))).status).toBe(
      201,
    );
    const list = await callApi(base, guest, 'GET', roomPaths.collection);
    expect(roomListResponseSchema.parse(list.body).rooms.map((entry) => entry.id)).toEqual([
      room.id,
    ]);
    expect((await callApi(base, guest, 'DELETE', url(roomPaths.membership, room.id))).status).toBe(
      204,
    );
    expect((await callApi(base, guest, 'GET', url(roomPaths.item, room.id))).status).toBe(404);
  });
});
