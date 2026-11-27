import {
  API_BASE_PATH,
  buddiesResponseSchema,
  errorBodySchema,
  roomRecapResponseSchema,
  roomScheduleResponseSchema,
  roomSchedulesResponseSchema,
  upcomingSessionsResponseSchema,
} from '@focus-flow/contracts';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestHarness, stopTestHarness, type TestHarness } from '../../../test/harness.js';
import { closeAllSockets, connectSocket, recordEvents } from '../../../test/sockets.js';
import { signUpTestUser, type TestUser } from '../../../test/users.js';
import { focusSessions } from '../../db/schema.js';
import { generateRoomCode } from '../rooms/code.js';
import { insertMembershipIfAbsent, insertRoom } from '../rooms/queries.js';

// Wave 4 against the real API: buddies (BD1–BD4), schedules (SC1–SC3), recap (RR1–RR2).

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

const codeOf = (result: ApiResult) => [
  result.status,
  errorBodySchema.parse(result.body).error.code,
];

const buddies = async (user: TestUser) =>
  buddiesResponseSchema.parse((await call(user, 'GET', '/buddies?tz=UTC')).body);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  harness = await startTestHarness();
}, 180_000);

afterAll(async () => {
  closeAllSockets();
  if (harness !== undefined) {
    await stopTestHarness(harness);
  }
}, 60_000);

describe('focus buddies', () => {
  it('asks by code, accepts, shares only streak, week and "focusing now", and nudges', async () => {
    const h = requireHarness();
    const ada = await signUpTestUser(h, 'ada');
    const ben = await signUpTestUser(h, 'ben');
    const benCode = (await buddies(ben)).code;
    expect(benCode).toMatch(/^[A-Z2-9]{8}$/);
    // The code is stable.
    expect((await buddies(ben)).code).toBe(benCode);

    expect(codeOf(await call(ada, 'POST', '/buddies', { code: 'ZZZZZZZZ' }))).toEqual([
      404,
      'BUDDY_CODE_UNKNOWN',
    ]);
    const asked = await call(ada, 'POST', '/buddies', { code: benCode.toLowerCase() });
    expect(asked.body).toEqual({ status: 'requested' });
    expect((await buddies(ada)).outgoing.map((entry) => entry.userId)).toEqual([ben.userId]);
    expect((await buddies(ben)).incoming.map((entry) => entry.userId)).toEqual([ada.userId]);

    // Not buddies yet: no nudge.
    expect(codeOf(await call(ada, 'POST', `/buddies/${ben.userId}/nudge`))).toEqual([
      404,
      'NOT_BUDDIES',
    ]);
    expect((await call(ben, 'POST', `/buddies/${ada.userId}/accept`)).status).toBe(204);

    const started = new Date(Date.now() - 2 * 3_600_000);
    await h.db.insert(focusSessions).values({
      id: uuidv7(),
      userId: ben.userId,
      status: 'completed',
      plannedSeconds: 1_500,
      focusedSeconds: 1_500,
      startedAt: started,
      endedAt: new Date(started.getTime() + 1_500_000),
    });
    const [benAsSeen] = (await buddies(ada)).buddies;
    expect(benAsSeen).toMatchObject({
      userId: ben.userId,
      focusingNow: false,
      currentStreak: 1,
      weekFocusedSeconds: 1_500,
    });

    const socket = await connectSocket(h.baseUrl, ben.accessToken);
    const nudges = recordEvents<{ fromUserId: string }>(socket, 'buddy:nudge');
    expect((await call(ada, 'POST', `/buddies/${ben.userId}/nudge`)).status).toBe(204);
    for (let tries = 0; nudges.length === 0 && tries < 40; tries += 1) {
      await sleep(50);
    }
    expect(nudges.map((event) => event.fromUserId)).toEqual([ada.userId]);
    expect(codeOf(await call(ada, 'POST', `/buddies/${ben.userId}/nudge`))).toEqual([
      429,
      'RATE_LIMITED',
    ]);

    expect((await call(ben, 'DELETE', `/buddies/${ada.userId}`)).status).toBe(204);
    expect((await buddies(ada)).buddies).toEqual([]);
  });

  it('makes buddies at once when the other person had already asked', async () => {
    const h = requireHarness();
    const cleo = await signUpTestUser(h, 'cleo');
    const dan = await signUpTestUser(h, 'dan');
    await call(cleo, 'POST', '/buddies', { code: (await buddies(dan)).code });
    const back = await call(dan, 'POST', '/buddies', { code: (await buddies(cleo)).code });
    expect(back.body).toEqual({ status: 'buddies' });
    expect((await buddies(cleo)).buddies.map((entry) => entry.userId)).toEqual([dan.userId]);
    // Your own code is never a buddy.
    expect(
      codeOf(await call(dan, 'POST', '/buddies', { code: (await buddies(dan)).code })),
    ).toEqual([404, 'BUDDY_CODE_UNKNOWN']);
  });
});

const makeRoom = async () => {
  const h = requireHarness();
  const [host, member, outsider] = await Promise.all([
    signUpTestUser(h, 'host'),
    signUpTestUser(h, 'member'),
    signUpTestUser(h, 'outsider'),
  ]);
  const room = await insertRoom(h.db, {
    id: uuidv7(),
    code: generateRoomCode(),
    name: 'Study hall',
    hostId: host.userId,
    isPrivate: false,
    focusSeconds: 1500,
    shortBreakSeconds: 300,
    longBreakSeconds: 900,
  });
  await insertMembershipIfAbsent(h.db, room.id, host.userId);
  await insertMembershipIfAbsent(h.db, room.id, member.userId);
  return { roomId: room.id, host, member, outsider };
};

describe('scheduled room sessions', () => {
  it('lets the host plan sessions that members see, and lists the next 24 hours', async () => {
    const { roomId, host, member, outsider } = await makeRoom();
    const inAnHour = new Date(Date.now() + 3_600_000).toISOString();
    const created = await call(host, 'POST', `/rooms/${roomId}/schedules`, {
      title: '  Morning deep work  ',
      startsAt: inAnHour,
      durationMinutes: 50,
      repeatsWeekly: true,
    });
    expect(created.status).toBe(201);
    const schedule = roomScheduleResponseSchema.parse(created.body).schedule;
    expect(schedule).toMatchObject({ title: 'Morning deep work', nextStartsAt: inAnHour });

    const listed = roomSchedulesResponseSchema.parse(
      (await call(member, 'GET', `/rooms/${roomId}/schedules`)).body,
    );
    expect(listed.schedules.map((entry) => entry.id)).toEqual([schedule.id]);
    const upcoming = upcomingSessionsResponseSchema.parse(
      (await call(member, 'GET', '/me/upcoming-sessions')).body,
    );
    expect(upcoming.sessions.map((entry) => [entry.roomName, entry.title])).toEqual([
      ['Study hall', 'Morning deep work'],
    ]);

    expect(
      codeOf(
        await call(member, 'POST', `/rooms/${roomId}/schedules`, {
          title: 'Mine',
          startsAt: inAnHour,
          durationMinutes: 25,
        }),
      ),
    ).toEqual([403, 'NOT_HOST']);
    expect(codeOf(await call(outsider, 'GET', `/rooms/${roomId}/schedules`))).toEqual([
      404,
      'ROOM_NOT_FOUND',
    ]);
    expect(
      codeOf(
        await call(host, 'POST', `/rooms/${roomId}/schedules`, {
          title: 'Past',
          startsAt: new Date(Date.now() - 60_000).toISOString(),
          durationMinutes: 25,
        }),
      ),
    ).toEqual([400, 'VALIDATION_FAILED']);

    expect((await call(host, 'DELETE', `/rooms/${roomId}/schedules/${schedule.id}`)).status).toBe(
      204,
    );
    expect(
      roomSchedulesResponseSchema.parse(
        (await call(member, 'GET', `/rooms/${roomId}/schedules`)).body,
      ).schedules,
    ).toEqual([]);
  });
});

describe('the room recap', () => {
  it('sums the last 7 days of the room and counts its streak, for members only', async () => {
    const h = requireHarness();
    const { roomId, host, member, outsider } = await makeRoom();
    const seed = async (user: TestUser, daysAgo: number, outcome: 'done' | null) => {
      const startedAt = new Date(Date.now() - daysAgo * 86_400_000 - 3_600_000);
      await h.db.insert(focusSessions).values({
        id: uuidv7(),
        userId: user.userId,
        roomId,
        focusRunId: uuidv7(),
        status: 'completed',
        plannedSeconds: 1_500,
        focusedSeconds: 1_500,
        startedAt,
        endedAt: new Date(startedAt.getTime() + 1_500_000),
        checkInOutcome: outcome,
        checkedInAt: outcome === null ? null : new Date(startedAt.getTime() + 1_600_000),
      });
    };
    await seed(member, 0, 'done');
    await seed(member, 1, null);
    await seed(host, 1, null);
    await seed(host, 20, null);

    const recap = roomRecapResponseSchema.parse(
      (await call(host, 'GET', `/rooms/${roomId}/recap?tz=UTC`)).body,
    );
    expect(recap.totals).toEqual({
      focusedSeconds: 4_500,
      completedSessions: 3,
      intentionsDone: 1,
    });
    expect(recap.roomStreak).toBe(2);
    expect(recap.people.map((person) => [person.userId, person.completedSessions])).toEqual([
      [member.userId, 2],
      [host.userId, 1],
    ]);
    expect(codeOf(await call(outsider, 'GET', `/rooms/${roomId}/recap?tz=UTC`))).toEqual([
      404,
      'ROOM_NOT_FOUND',
    ]);
  });
});
