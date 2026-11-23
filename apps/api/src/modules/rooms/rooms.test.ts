import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, roomCodeSchema } from '@focus-flow/contracts';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import type { Db } from '../../db/client.js';
import { generateRoomCode } from './code.js';
import type { RoomLive } from './ports.js';
import { createRoom, MAX_CODE_ATTEMPTS } from './service.js';
import { toMemberView, toRoomPreview, toRoomView } from './views.js';

const ROOM_ROW = {
  id: '01890f4e-7a3b-7000-8000-000000000001',
  code: 'ABC234',
  name: 'Study hall',
  hostId: '01890f4e-7a3b-7000-8000-000000000002',
  isPrivate: true,
  focusSeconds: 1500,
  shortBreakSeconds: 300,
  longBreakSeconds: 900,
  createdAt: new Date('2026-01-02T03:04:05.678Z'),
  updatedAt: new Date('2026-01-02T03:04:05.678Z'),
};

describe('generateRoomCode', () => {
  it('produces six characters of the alphabet that the contract accepts', () => {
    for (let index = 0; index < 500; index += 1) {
      const code = generateRoomCode();
      expect(code).toHaveLength(ROOM_CODE_LENGTH);
      for (const char of code) {
        expect(ROOM_CODE_ALPHABET).toContain(char);
      }
      expect(roomCodeSchema.safeParse(code).success).toBe(true);
    }
  });

  it('has no look-alike characters', () => {
    for (const char of 'ILO01') {
      expect(ROOM_CODE_ALPHABET).not.toContain(char);
    }
  });
});

describe('views', () => {
  it('maps a room row to a view without the persistence fields', () => {
    const view = toRoomView(ROOM_ROW);
    expect(view).toEqual({
      id: ROOM_ROW.id,
      code: 'ABC234',
      name: 'Study hall',
      isPrivate: true,
      hostId: ROOM_ROW.hostId,
      timerSettings: { focusSeconds: 1500, shortBreakSeconds: 300, longBreakSeconds: 900 },
      createdAt: '2026-01-02T03:04:05.678Z',
    });
    expect(Object.keys(view)).not.toContain('updatedAt');
  });

  it('the preview has exactly id, code, name and isPrivate', () => {
    expect(Object.keys(toRoomPreview(ROOM_ROW)).sort()).toEqual([
      'code',
      'id',
      'isPrivate',
      'name',
    ]);
  });

  it('marks the host in a member view', () => {
    const row = {
      userId: ROOM_ROW.hostId,
      displayName: 'Ada',
      avatarUrl: null,
      joinedAt: new Date('2026-01-02T00:00:00.000Z'),
    };
    expect(toMemberView(row, ROOM_ROW.hostId).isHost).toBe(true);
    expect(toMemberView(row, ROOM_ROW.id).isHost).toBe(false);
  });
});

describe('createRoom code retries', () => {
  const uniqueViolation = Object.assign(new Error('duplicate'), { code: '23505' });

  // A db whose transaction fails `failures` times with a unique violation, then succeeds.
  const fakeDb = (failures: number): { db: Db; attempts: () => number } => {
    let attempts = 0;
    const db = {
      transaction: (): Promise<unknown> => {
        attempts += 1;
        return attempts <= failures ? Promise.reject(uniqueViolation) : Promise.resolve(ROOM_ROW);
      },
    } as unknown as Db;
    return { db, attempts: () => attempts };
  };

  const deps = (db: Db, generateCode: () => string) => ({
    db,
    live: {} as RoomLive,
    logger: { error: vi.fn(), warn: vi.fn() } as unknown as Logger,
    generateCode,
  });

  const input = { name: 'Study hall', isPrivate: false };

  it('retries on a code collision and then succeeds', async () => {
    const { db, attempts } = fakeDb(2);
    const generate = vi.fn(() => 'ABC234');
    const room = await createRoom(deps(db, generate), 'user', input);
    expect(room.code).toBe('ABC234');
    expect(attempts()).toBe(3);
  });

  it('gives up after five attempts with a 503', async () => {
    const { db, attempts } = fakeDb(100);
    await expect(
      createRoom(
        deps(db, () => 'ABC234'),
        'user',
        input,
      ),
    ).rejects.toMatchObject({
      status: 503,
    });
    expect(attempts()).toBe(MAX_CODE_ATTEMPTS);
    expect(MAX_CODE_ATTEMPTS).toBe(5);
  });

  it('does not retry other errors, including a non-unique database error', async () => {
    let attempts = 0;
    const foreignKeyViolation = Object.assign(new Error('fk'), { code: '23503' });
    for (const failure of [new Error('boom'), foreignKeyViolation]) {
      attempts = 0;
      const db = {
        transaction: () => {
          attempts += 1;
          return Promise.reject(failure);
        },
      } as unknown as Db;
      await expect(
        createRoom(
          deps(db, () => 'ABC234'),
          'user',
          input,
        ),
      ).rejects.toBe(failure);
      expect(attempts).toBe(1);
    }
  });
});
