import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startTestHarness, stopTestHarness, type TestHarness } from '../../test/harness.js';
import { authIdentities, authSessions, roomMembers, rooms, users } from './schema.js';

// Database-level guarantees of the Phase 6 schema (migration 0003_create_rooms), checked
// against the real PostgreSQL 18 with the committed migrations applied. The rules the
// database cannot enforce alone (the host's membership row) are covered by the rooms tests.

const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const RESTRICT_VIOLATION = '23001';
const UNIQUE_VIOLATION = '23505';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

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

// A distinct valid code per call.
let codeCounter = 0;
const nextCode = (): string => {
  codeCounter += 1;
  const first = ALPHABET.charAt(codeCounter % ALPHABET.length);
  const second = ALPHABET.charAt(Math.floor(codeCounter / ALPHABET.length) % ALPHABET.length);
  return `${first}${second}2222`;
};

type RoomOverrides = Partial<typeof rooms.$inferInsert>;

const insertRoom = async (hostId: string, overrides: RoomOverrides = {}): Promise<string> => {
  const id = uuidv7();
  await db()
    .insert(rooms)
    .values({ id, code: nextCode(), name: 'Room', hostId, isPrivate: false, ...overrides });
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
  await db().delete(roomMembers);
  await db().delete(rooms);
  await db().delete(authIdentities);
  await db().delete(authSessions);
  await db().delete(users);
});

describe('rooms.code', () => {
  it('accepts exactly six characters of the alphabet', async () => {
    const host = await insertUser();
    expect(await pgErrorCode(insertRoom(host, { code: 'ABC234' }))).toBeUndefined();
    expect(await pgErrorCode(insertRoom(host, { code: 'ZZ9999' }))).toBeUndefined();
  });

  it.each([
    ['look-alike I', 'ABCI23'],
    ['look-alike L', 'ABCL23'],
    ['look-alike O', 'ABCO23'],
    ['look-alike 0', 'ABC023'],
    ['look-alike 1', 'ABC123'],
    ['lowercase', 'abc234'],
    ['five characters', 'ABC23'],
    ['seven characters', 'ABC2345'],
    ['empty', ''],
    ['a space', 'ABC 23'],
    ['a trailing newline', 'ABC234\n'],
  ])('rejects %s', async (_label, code) => {
    const host = await insertUser();
    expect(await pgErrorCode(insertRoom(host, { code }))).toBe(CHECK_VIOLATION);
  });

  it('is unique', async () => {
    const host = await insertUser();
    await insertRoom(host, { code: 'ABC234' });
    expect(await pgErrorCode(insertRoom(host, { code: 'ABC234' }))).toBe(UNIQUE_VIOLATION);
  });
});

describe('rooms.is_private and room_members.joined_at', () => {
  it('has no default for is_private: leaving it out fails', async () => {
    const host = await insertUser();
    const result = await pgErrorCode(
      db().execute(
        sql`insert into rooms (id, code, name, host_id) values (${uuidv7()}, 'KKK222', 'Room', ${host})`,
      ),
    );
    expect(result).toBe('23502');
  });

  it('defaults joined_at to the time of the insert', async () => {
    const host = await insertUser();
    const roomId = await insertRoom(host);
    const before = Date.now();
    await db().insert(roomMembers).values({ roomId, userId: host });
    const [row] = await db().select().from(roomMembers);
    expect(row?.joinedAt).toBeInstanceOf(Date);
    expect(Math.abs((row?.joinedAt.getTime() ?? 0) - before)).toBeLessThan(60_000);
  });
});

describe('rooms.name', () => {
  it('accepts 1 to 60 characters', async () => {
    const host = await insertUser();
    expect(await pgErrorCode(insertRoom(host, { name: 'a' }))).toBeUndefined();
    expect(await pgErrorCode(insertRoom(host, { name: 'a'.repeat(60) }))).toBeUndefined();
  });

  it('rejects 0 and 61 characters', async () => {
    const host = await insertUser();
    expect(await pgErrorCode(insertRoom(host, { name: '' }))).toBe(CHECK_VIOLATION);
    expect(await pgErrorCode(insertRoom(host, { name: 'a'.repeat(61) }))).toBe(CHECK_VIOLATION);
  });
});

describe('rooms durations', () => {
  const bounds = [
    ['focusSeconds', 60, 14_400],
    ['shortBreakSeconds', 60, 3_600],
    ['longBreakSeconds', 60, 7_200],
  ] as const;

  it.each(bounds)('%s accepts its minimum and maximum', async (field, min, max) => {
    const host = await insertUser();
    expect(await pgErrorCode(insertRoom(host, { [field]: min }))).toBeUndefined();
    expect(await pgErrorCode(insertRoom(host, { [field]: max }))).toBeUndefined();
  });

  it.each(bounds)(
    '%s rejects one below the minimum and one above the maximum',
    async (field, min, max) => {
      const host = await insertUser();
      expect(await pgErrorCode(insertRoom(host, { [field]: min - 1 }))).toBe(CHECK_VIOLATION);
      expect(await pgErrorCode(insertRoom(host, { [field]: max + 1 }))).toBe(CHECK_VIOLATION);
    },
  );

  it('defaults to 25, 5 and 15 minutes', async () => {
    const host = await insertUser();
    const id = await insertRoom(host);
    const [row] = await db()
      .select()
      .from(rooms)
      .where(sql`${rooms.id} = ${id}`);
    expect(row).toMatchObject({
      focusSeconds: 1500,
      shortBreakSeconds: 300,
      longBreakSeconds: 900,
    });
  });
});

describe('rooms.host_id', () => {
  it('rejects a host that does not exist', async () => {
    expect(await pgErrorCode(insertRoom(uuidv7()))).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('restricts deleting a user who hosts a room', async () => {
    const host = await insertUser();
    await insertRoom(host);
    expect(
      await pgErrorCode(
        db()
          .delete(users)
          .where(sql`${users.id} = ${host}`),
      ),
    ).toBe(RESTRICT_VIOLATION);
  });
});

describe('room_members', () => {
  it('rejects a duplicate (room, user) pair', async () => {
    const host = await insertUser();
    const roomId = await insertRoom(host);
    await db().insert(roomMembers).values({ roomId, userId: host });
    expect(await pgErrorCode(db().insert(roomMembers).values({ roomId, userId: host }))).toBe(
      UNIQUE_VIOLATION,
    );
  });

  it('rejects an unknown room or user', async () => {
    const host = await insertUser();
    const roomId = await insertRoom(host);
    expect(
      await pgErrorCode(db().insert(roomMembers).values({ roomId: uuidv7(), userId: host })),
    ).toBe(FOREIGN_KEY_VIOLATION);
    expect(await pgErrorCode(db().insert(roomMembers).values({ roomId, userId: uuidv7() }))).toBe(
      FOREIGN_KEY_VIOLATION,
    );
  });

  it('cascades when the room is deleted', async () => {
    const host = await insertUser();
    const other = await insertUser();
    const roomId = await insertRoom(host);
    await db()
      .insert(roomMembers)
      .values([
        { roomId, userId: host },
        { roomId, userId: other },
      ]);

    await db()
      .delete(rooms)
      .where(sql`${rooms.id} = ${roomId}`);

    expect(await db().select().from(roomMembers)).toHaveLength(0);
  });

  it('cascades when a non-host member user is deleted', async () => {
    const host = await insertUser();
    const other = await insertUser();
    const roomId = await insertRoom(host);
    await db()
      .insert(roomMembers)
      .values([
        { roomId, userId: host },
        { roomId, userId: other },
      ]);

    await db()
      .delete(users)
      .where(sql`${users.id} = ${other}`);

    const remaining = await db().select().from(roomMembers);
    expect(remaining.map((row) => row.userId)).toEqual([host]);
  });
});

describe('indexes', () => {
  it('creates the named indexes', async () => {
    const result = await db().execute<{ indexname: string }>(
      sql`SELECT indexname FROM pg_indexes WHERE tablename IN ('rooms', 'room_members')`,
    );
    const names = result.rows.map((row) => row.indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        'pk_rooms',
        'uq_rooms_code',
        'ix_rooms_host_id',
        'pk_room_members',
        'ix_room_members_user_id_joined_at',
      ]),
    );
  });
});
