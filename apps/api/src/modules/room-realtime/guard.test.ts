import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import type { Db } from '../../db/client.js';
import type { AppServer } from '../realtime/types.js';
import { dropNonMemberSockets } from './guard.js';

const ROOM = '0199a000-0000-7000-8000-0000000000a1';
const USER = '0199a000-0000-7000-8000-0000000000b1';

const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger;

const fakeSocket = (rooms: string[]) => ({
  id: 'socket-1',
  rooms: new Set(rooms),
  data: { userId: USER },
  leave: vi.fn(),
  emit: vi.fn(),
});

const fakeIo = (socket: ReturnType<typeof fakeSocket>): AppServer =>
  ({ of: () => ({ sockets: new Map([[socket.id, socket]]) }) }) as unknown as AppServer;

/** A `db.select().from().where()` chain answering `rows`, or throwing. */
const fakeDb = (answer: () => Promise<unknown>): Db =>
  ({
    select: () => ({ from: () => ({ where: answer }) }),
  }) as unknown as Db;

describe('dropNonMemberSockets', () => {
  it('takes a former member’s socket out of the room and tells it', async () => {
    const socket = fakeSocket([`room:${ROOM}`, `user:${USER}`]);

    const removed = await dropNonMemberSockets({
      io: fakeIo(socket),
      db: fakeDb(() => Promise.resolve([])),
      logger,
    });

    expect(removed).toBe(1);
    expect(socket.leave).toHaveBeenCalledWith(`room:${ROOM}`);
    expect(socket.emit).toHaveBeenCalledWith('room:member:removed', {
      roomId: ROOM,
      userId: USER,
      reason: 'removed',
    });
  });

  it('keeps the socket of a member', async () => {
    const socket = fakeSocket([`room:${ROOM}`]);

    const removed = await dropNonMemberSockets({
      io: fakeIo(socket),
      db: fakeDb(() => Promise.resolve([{ roomId: ROOM, userId: USER }])),
      logger,
    });

    expect(removed).toBe(0);
    expect(socket.leave).not.toHaveBeenCalled();
  });

  it('keeps every socket when the membership query fails (fail open)', async () => {
    const socket = fakeSocket([`room:${ROOM}`]);

    const removed = await dropNonMemberSockets({
      io: fakeIo(socket),
      db: fakeDb(() => Promise.reject(new Error('database unavailable'))),
      logger,
    });

    expect(removed).toBe(0);
    expect(socket.leave).not.toHaveBeenCalled();
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it('does not query at all when no socket is in a room', async () => {
    const socket = fakeSocket([`user:${USER}`]);
    const answer = vi.fn(() => Promise.resolve([]));

    expect(await dropNonMemberSockets({ io: fakeIo(socket), db: fakeDb(answer), logger })).toBe(0);
    expect(answer).not.toHaveBeenCalled();
  });
});
