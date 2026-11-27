import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startTestHarness, stopTestHarness, type TestHarness } from '../../test/harness.js';
import { authIdentities, authSessions, roomBlocks, roomMembers, rooms, users } from './schema.js';

// Database-level guarantees of migration 0005 (room_blocks, users.daily_goal_seconds),
// checked against the real PostgreSQL with the committed migrations applied.

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

let harness: TestHarness | undefined;

const db = () => {
  if (harness === undefined) {
    throw new Error('the API harness failed to start');
  }
  return harness.db;
};

const pgErrorCode = async (query: Promise<unknown>): Promise<string | undefined> => {
  try {
    await query;
  } catch (error) {
    let current: unknown = error;
    while (typeof current === 'object' && current !== null) {
      if ('code' in current && typeof current.code === 'string') {
        return current.code;
      }
      current = 'cause' in current ? current.cause : undefined;
    }
    return 'unknown-error';
  }
  return undefined;
};

const insertUser = async (): Promise<string> => {
  const id = uuidv7();
  await db()
    .insert(users)
    .values({
      id,
      email: `user-${id}@example.com`,
      displayName: 'User',
      passwordHash: 'not-a-real-hash',
      emailVerifiedAt: null,
    });
  return id;
};

const insertRoom = async (hostId: string): Promise<string> => {
  const id = uuidv7();
  await db().insert(rooms).values({ id, code: 'ABC234', name: 'Room', hostId, isPrivate: false });
  return id;
};

beforeAll(async () => {
  harness = await startTestHarness();
}, 120_000);

afterAll(async () => {
  if (harness !== undefined) {
    await stopTestHarness(harness);
  }
}, 60_000);

beforeEach(async () => {
  await db().delete(roomBlocks);
  await db().delete(roomMembers);
  await db().delete(rooms);
  await db().delete(authIdentities);
  await db().delete(authSessions);
  await db().delete(users);
});

describe('users.daily_goal_seconds', () => {
  it('defaults to two hours and accepts only 300 to 43200 seconds', async () => {
    const id = await insertUser();
    const [row] = await db().select().from(users).where(eq(users.id, id));
    expect(row?.dailyGoalSeconds).toBe(7_200);

    const set = (value: number) =>
      pgErrorCode(db().update(users).set({ dailyGoalSeconds: value }).where(eq(users.id, id)));
    expect(await set(300)).toBeUndefined();
    expect(await set(43_200)).toBeUndefined();
    expect(await set(299)).toBe(CHECK_VIOLATION);
    expect(await set(43_201)).toBe(CHECK_VIOLATION);
  });
});

describe('room_blocks', () => {
  it('allows one block per person per room and requires a real room and user', async () => {
    const host = await insertUser();
    const person = await insertUser();
    const room = await insertRoom(host);
    const block = (roomId: string, userId: string) =>
      pgErrorCode(db().insert(roomBlocks).values({ id: uuidv7(), roomId, userId }));

    expect(await block(room, person)).toBeUndefined();
    expect(await block(room, person)).toBe(UNIQUE_VIOLATION);
    expect(await block(uuidv7(), person)).toBe(FOREIGN_KEY_VIOLATION);
    expect(await block(room, uuidv7())).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('is removed with its user', async () => {
    const host = await insertUser();
    const person = await insertUser();
    const room = await insertRoom(host);
    await db().insert(roomBlocks).values({ id: uuidv7(), roomId: room, userId: person });
    await db().delete(users).where(eq(users.id, person));
    expect(await db().select().from(roomBlocks)).toEqual([]);
  });
});
