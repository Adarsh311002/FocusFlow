import { roomIdSchema, userIdSchema } from '@focus-flow/contracts';
import type { Logger } from 'pino';

import type { Db } from '../../db/client.js';
import type { AppServer } from '../realtime/types.js';
import { findMemberPairs } from './queries.js';

// The backstop for a lost eviction (F1). Removing a member is persisted first and then
// announced; the announcement reaches the member's sockets through a fire-and-forget
// Redis publish that can be lost. Without this, a removed member's socket would stay in
// the Socket.IO room, and the heartbeat sync (which compares sockets with Redis only)
// would even keep its presence entry alive. Every sync therefore first checks the room
// memberships of the sockets it is about to keep, with one PostgreSQL query, and takes the
// sockets of ex-members out of their rooms; the sync that follows then removes their
// presence and announces the departure.
//
// A failing query changes nothing (fail open): a database blip must never evict anyone.

/** Takes this instance's sockets of non-members out of their room; how many it removed. */
export const dropNonMemberSockets = async (deps: {
  readonly io: AppServer;
  readonly db: Db;
  readonly logger: Logger;
}): Promise<number> => {
  const { io, db, logger } = deps;
  const candidates = new Map<string, { socketId: string; roomId: string; userId: string }>();
  for (const socket of io.of('/').sockets.values()) {
    for (const name of socket.rooms) {
      if (name.startsWith('room:')) {
        candidates.set(`${socket.id}|${name}`, {
          socketId: socket.id,
          roomId: name.slice('room:'.length),
          userId: socket.data.userId,
        });
      }
    }
  }
  if (candidates.size === 0) {
    return 0;
  }

  let members: Set<string>;
  try {
    members = await findMemberPairs(db, [...candidates.values()]);
  } catch (error) {
    logger.warn({ err: error }, 'Could not verify room memberships; keeping every socket');
    return 0;
  }

  // Only sockets that were already in the room before the query are judged by it.
  let removed = 0;
  for (const [key, { socketId, roomId, userId }] of candidates) {
    if (members.has(`${roomId}:${userId}`)) {
      continue;
    }
    const socket = io.of('/').sockets.get(socketId);
    const name = key.slice(key.indexOf('|') + 1);
    if (socket === undefined || !socket.rooms.has(name)) {
      continue;
    }
    void socket.leave(name);
    socket.emit('room:member:removed', {
      roomId: roomIdSchema.parse(roomId),
      userId: userIdSchema.parse(userId),
      reason: 'removed',
    });
    removed += 1;
  }
  if (removed > 0) {
    logger.warn({ removed }, 'Removed sockets of former members from their rooms');
  }
  return removed;
};
