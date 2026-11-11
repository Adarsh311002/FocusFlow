import {
  type ErrorCode,
  roomChatSendRequestSchema,
  roomIdSchema,
  roomJoinRequestSchema,
  roomRequestSchema,
  roomTimerCommandRequestSchema,
  userIdSchema,
} from '@focus-flow/contracts';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { ZodType } from 'zod';

import type { Db } from '../../db/client.js';
import { redisTimeMs } from '../../platform/redis.js';
import type { SocketEmitter } from '../../platform/socket.js';
import type { PresenceCheck } from '../presence/store.js';
import { type AppSocket, roomRoom, userRoom } from '../realtime/types.js';
import { timerMachine } from '../room-timer/machine.js';
import type { RoomTimerService } from '../room-timer/types.js';
import type { ChatDedupe } from './chat.js';
import type { RoomFocusPort } from './focus-hooks.js';
import type { KnockStore } from './knocks.js';
import {
  CHAT_RATE,
  JOIN_RATE,
  KNOCK_CANCEL_RATE,
  KNOCK_RATE,
  type RateLimiter,
  TIMER_RATE,
} from './limiter.js';
import { findRoom, findRoomForMember, findUserProfiles, isRoomMember } from './queries.js';
import type { RoomPresence } from './room-presence.js';
import { buildSnapshot } from './snapshot.js';

// The client → server room events (docs/api/socket-events.md, M6–M8). Every handler:
// validates its payload with the contract schema, takes identity only from `socket.data`,
// answers through the acknowledgement (a missing callback is tolerated), and never throws:
// a known refusal becomes its error code, anything else is logged and answers INTERNAL.
// A socket's authority to act in a room is its Socket.IO room (`socket.rooms`), which
// REST eviction changes without touching `socket.data` (M5).

export class SocketAckError extends Error {
  readonly code: ErrorCode;
  /** Structured context for the client (e.g. the current timer on a conflict, RT6). */
  readonly details: object | undefined;

  constructor(code: ErrorCode, message: string, details?: object) {
    super(message);
    this.name = 'SocketAckError';
    this.code = code;
    this.details = details;
  }
}

export type RoomHandlerDeps = {
  readonly db: Db;
  readonly redis: Pick<Redis, 'time'>;
  readonly emitter: SocketEmitter;
  readonly logger: Logger;
  readonly presence: RoomPresence;
  readonly knocks: KnockStore;
  readonly limiter: RateLimiter;
  readonly chat: ChatDedupe;
  /** The shared room timer (Phase 7). */
  readonly timer: RoomTimerService;
  /** Room focus runs (Phase 8): the snapshot, reconnects and leaving on purpose. */
  readonly focus: RoomFocusPort;
  /** User-level presence (the host must be online to be knocked on, D20). */
  readonly checkUser: (userId: string) => Promise<PresenceCheck>;
  readonly maxPresent: number;
};

const isFunction = (value: unknown): value is (...args: unknown[]) => void =>
  typeof value === 'function';

/** Sends the acknowledgement if the client supplied a callback; never throws. */
export const reply = (ack: unknown, response: object): void => {
  if (!isFunction(ack)) {
    return;
  }
  try {
    ack(response);
  } catch {
    // A throwing callback on the other side is not this handler's failure.
  }
};

const parsePayload = <T>(schema: ZodType<T>, payload: unknown): T => {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new SocketAckError('VALIDATION_FAILED', 'Invalid payload.');
  }
  return parsed.data;
};

/** Runs a handler body and turns its result or failure into the acknowledgement. */
export const respondTo = async (
  logger: Logger,
  event: string,
  ack: unknown,
  work: () => Promise<object>,
): Promise<void> => {
  try {
    reply(ack, { ok: true, ...(await work()) });
  } catch (error) {
    if (error instanceof SocketAckError) {
      reply(ack, {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      });
      return;
    }
    logger.error({ err: error, event }, 'Room event failed');
    reply(ack, { ok: false, error: { code: 'INTERNAL', message: 'Something went wrong.' } });
  }
};

export const registerRoomHandlers = (socket: AppSocket, deps: RoomHandlerDeps): void => {
  const { db, redis, emitter, logger, presence, knocks, limiter, chat, timer, focus } = deps;
  const { userId } = socket.data;
  // Rooms in which this socket recorded presence; its disconnect removes exactly these.
  const recorded = new Set<string>();

  const ref = (roomId: string) => ({ roomId, userId, socketId: socket.id });
  const inRoom = (roomId: string): boolean => socket.rooms.has(roomRoom(roomId));
  const forget = (roomId: string): void => {
    recorded.delete(roomId);
    socket.data.joinedRooms = socket.data.joinedRooms.filter((id) => id !== roomId);
  };

  const undoJoin = async (roomId: string): Promise<void> => {
    forget(roomId);
    await Promise.allSettled([socket.leave(roomRoom(roomId)), presence.leave(ref(roomId))]);
  };

  const join = async (request: unknown): Promise<object> => {
    const { roomId } = parsePayload(roomJoinRequestSchema, request);
    if (!(await limiter.consume(JOIN_RATE, userId))) {
      throw new SocketAckError('RATE_LIMITED', 'You are joining rooms too often.');
    }
    const room = await findRoomForMember(db, roomId, userId);
    if (room === undefined) {
      throw new SocketAckError('NOT_A_MEMBER', 'You are not a member of this room.');
    }

    const wasInRoom = inRoom(roomId);
    if (!wasInRoom) {
      const present = (await presence.present([roomId])).get(roomId) ?? [];
      if (!present.some((user) => user.userId === userId) && present.length >= deps.maxPresent) {
        throw new SocketAckError('ROOM_FULL', 'This room is full.');
      }
      // The Socket.IO room first: an event sent after the presence list is read below is
      // never missed.
      await socket.join(roomRoom(roomId));
    }
    let becamePresent: boolean;
    try {
      // The cap is enforced again, atomically with the write (F5): the read above only
      // spares most refused joins from entering the Socket.IO room at all.
      const joined = await presence.join(
        {
          ...ref(roomId),
          displayName: socket.data.displayName,
          avatarUrl: socket.data.avatarUrl,
        },
        deps.maxPresent,
      );
      if (joined.full) {
        throw new SocketAckError('ROOM_FULL', 'This room is full.');
      }
      becamePresent = joined.first;
    } catch (error) {
      if (!wasInRoom) {
        await socket.leave(roomRoom(roomId));
      }
      throw error;
    }
    recorded.add(roomId);
    if (!socket.data.joinedRooms.includes(roomId)) {
      socket.data.joinedRooms.push(roomId);
    }
    if (!socket.connected) {
      // The socket went away while joining: its disconnect handler may have run before the
      // entry above existed.
      await undoJoin(roomId);
      throw new SocketAckError('NOT_JOINED', 'The connection closed.');
    }
    // Removal commits before its eviction runs: a membership that ended while this join
    // was in flight is caught here, or by the eviction.
    if (!(await isRoomMember(db, roomId, userId))) {
      await undoJoin(roomId);
      throw new SocketAckError('NOT_A_MEMBER', 'You are not a member of this room.');
    }

    // The person is present in the room again: a participant of the run who was in their
    // disconnect grace is reconnected before the snapshot is read, so it shows them connected
    // (RF7). Only when this socket made them present: another tab already did otherwise. A
    // failure is logged: the join stands, and the grace job re-checks presence itself.
    if (becamePresent) {
      try {
        await focus.userJoinedRoom(userId, roomId);
      } catch (error) {
        logger.warn({ err: error, roomId, userId }, 'Could not record a room focus reconnect');
      }
    }

    // Everything slow is read first and the presence list last (F3): the socket is already
    // in the Socket.IO room, so any change after the presence read reaches it as an event,
    // and the snapshot is never older than an event the client has applied.
    // A failure while assembling the snapshot (a Redis blip, a malformed timer) must not
    // leave a half-joined socket: the join is undone before the error is reported.
    try {
      const pending = room.hostId === userId ? await knocks.list(roomId) : [];
      const knockers = await findUserProfiles(
        db,
        pending.map((knock) => knock.userId),
      );
      // The timer is created on first access (RT1). Read before the presence list: a change
      // after this read reaches the socket (already in the Socket.IO room) as an event with a
      // higher version, which the client applies over the snapshot.
      const current = await timer.get(roomId);
      if (current === undefined) {
        throw new SocketAckError('ROOM_NOT_FOUND', 'This room does not exist.');
      }
      const focusSnapshot = await focus.snapshot(userId, roomId);
      const [presentByRoom, serverNowMs] = await Promise.all([
        presence.present([roomId]),
        redisTimeMs(redis),
      ]);
      return {
        snapshot: buildSnapshot({
          room,
          viewerId: userId,
          present: presentByRoom.get(roomId) ?? [],
          knocks: pending,
          knockers,
          timer: timerMachine.toView(roomId, current.state),
          focus: focusSnapshot,
          serverNowMs,
        }),
      };
    } catch (error) {
      if (!wasInRoom) {
        await undoJoin(roomId);
      }
      throw error;
    }
  };

  const leave = async (request: unknown): Promise<object> => {
    const { roomId } = parsePayload(roomRequestSchema, request);
    if (!inRoom(roomId)) {
      throw new SocketAckError('NOT_JOINED', 'You have not joined this room.');
    }
    // Leaving on purpose ends the person's focus participation (RF8, `left_room`), in
    // PostgreSQL first and before the presence goes. Only when this is their last socket in
    // the room: closing one of several tabs is not leaving. A failure answers an error and
    // changes nothing, so the client can retry.
    const hasOtherSocket = await presence.hasOtherSocket(ref(roomId));
    if (!hasOtherSocket) {
      await focus.depart(userId, roomId, 'left_room');
    }
    await socket.leave(roomRoom(roomId));
    forget(roomId);
    const left = await presence.leave(ref(roomId));
    if (left.last && hasOtherSocket) {
      // The other tab left at the same time: neither saw the other. Depart is idempotent.
      try {
        await focus.depart(userId, roomId, 'left_room');
      } catch (error) {
        logger.warn({ err: error, roomId, userId }, 'Could not end the room focus participation');
      }
    }
    return {};
  };

  const knock = async (request: unknown): Promise<object> => {
    const { roomId } = parsePayload(roomRequestSchema, request);
    if (!(await limiter.consume(KNOCK_RATE, userId))) {
      throw new SocketAckError('RATE_LIMITED', 'You are knocking too often. Try again shortly.');
    }
    const room = await findRoom(db, roomId);
    if (room === undefined) {
      throw new SocketAckError('ROOM_NOT_FOUND', 'This room does not exist.');
    }
    if (!room.isPrivate) {
      throw new SocketAckError('NOT_PRIVATE', 'This room is public; join it directly.');
    }
    if (await isRoomMember(db, roomId, userId)) {
      throw new SocketAckError('ALREADY_MEMBER', 'You are already a member of this room.');
    }
    if (!(await deps.checkUser(room.hostId)).online) {
      throw new SocketAckError('HOST_OFFLINE', 'The host is not online.');
    }
    const expiresAtMs = await knocks.add(roomId, userId);
    emitter.to(userRoom(room.hostId)).emit('room:knock:received', {
      roomId: roomIdSchema.parse(roomId),
      requester: {
        userId,
        displayName: socket.data.displayName,
        avatarUrl: socket.data.avatarUrl,
      },
      expiresAtMs,
    });
    return { expiresAtMs };
  };

  const cancelKnock = async (request: unknown): Promise<object> => {
    const { roomId } = parsePayload(roomRequestSchema, request);
    if (!(await limiter.consume(KNOCK_CANCEL_RATE, userId))) {
      throw new SocketAckError('RATE_LIMITED', 'You are cancelling knocks too often.');
    }
    const room = await findRoom(db, roomId);
    if (room === undefined) {
      throw new SocketAckError('ROOM_NOT_FOUND', 'This room does not exist.');
    }
    if (await knocks.remove(roomId, userId)) {
      emitter.to(userRoom(room.hostId)).emit('room:knock:removed', {
        roomId: roomIdSchema.parse(roomId),
        userId,
        reason: 'cancelled',
      });
    }
    return {};
  };

  const sendChat = async (request: unknown): Promise<object> => {
    const { roomId, clientMessageId, body } = parsePayload(roomChatSendRequestSchema, request);
    if (!inRoom(roomId)) {
      throw new SocketAckError('NOT_JOINED', 'You have not joined this room.');
    }
    // The socket's room is only a cache of the membership (F1): a removed member whose
    // eviction was lost would still be in it. One primary-key lookup decides; a database
    // failure answers INTERNAL (fail closed).
    if (!(await isRoomMember(db, roomId, userId))) {
      await undoJoin(roomId);
      throw new SocketAckError('NOT_A_MEMBER', 'You are not a member of this room.');
    }
    // A retry of a delivered message is answered with its ids, not rate limited and not
    // delivered again.
    const known = await chat.find(userId, roomId, clientMessageId);
    if (known !== undefined) {
      return known;
    }
    if (!(await limiter.consume(CHAT_RATE, userId))) {
      throw new SocketAckError('RATE_LIMITED', 'You are sending messages too fast.');
    }
    const claim = await chat.claim(userId, roomId, clientMessageId);
    if (!claim.claimed) {
      return claim.duplicate;
    }
    emitter.to(roomRoom(roomId)).emit('room:chat:message', {
      roomId: roomIdSchema.parse(roomId),
      messageId: claim.ids.messageId,
      clientMessageId,
      sender: { userId: userIdSchema.parse(userId), displayName: socket.data.displayName },
      body,
      sentAtMs: claim.ids.sentAtMs,
    });
    return claim.ids;
  };

  const timerCommand = async (request: unknown): Promise<object> => {
    const { roomId, command } = parsePayload(roomTimerCommandRequestSchema, request);
    // A socket outside the room learns and changes nothing.
    if (!inRoom(roomId)) {
      throw new SocketAckError('NOT_JOINED', 'You have not joined this room.');
    }
    if (!(await limiter.consume(TIMER_RATE, userId))) {
      throw new SocketAckError('RATE_LIMITED', 'You are sending timer commands too fast.');
    }
    // The host is decided by PostgreSQL on every command (RT5), never by the socket.
    const room = await findRoom(db, roomId);
    if (room === undefined) {
      throw new SocketAckError('ROOM_NOT_FOUND', 'This room does not exist.');
    }
    if (room.hostId !== userId) {
      throw new SocketAckError('NOT_HOST', 'Only the host can control the timer.');
    }
    const outcome = await timer.command(roomId, command);
    if (outcome.ok) {
      return { timer: timerMachine.toView(roomId, outcome.state), serverNowMs: outcome.nowMs };
    }
    if (outcome.code === 'ROOM_NOT_FOUND') {
      throw new SocketAckError('ROOM_NOT_FOUND', outcome.message);
    }
    throw new SocketAckError(
      outcome.code,
      outcome.message,
      outcome.state === undefined || outcome.nowMs === undefined
        ? undefined
        : { timer: timerMachine.toView(roomId, outcome.state), serverNowMs: outcome.nowMs },
    );
  };

  socket.on('room:join', (request, ack) => {
    void respondTo(logger, 'room:join', ack, () => join(request));
  });
  socket.on('room:leave', (request, ack) => {
    void respondTo(logger, 'room:leave', ack, () => leave(request));
  });
  socket.on('room:knock', (request, ack) => {
    void respondTo(logger, 'room:knock', ack, () => knock(request));
  });
  socket.on('room:knock:cancel', (request, ack) => {
    void respondTo(logger, 'room:knock:cancel', ack, () => cancelKnock(request));
  });
  socket.on('room:chat:send', (request, ack) => {
    void respondTo(logger, 'room:chat:send', ack, () => sendChat(request));
  });

  socket.on('room:timer:command', (request, ack) => {
    void respondTo(logger, 'room:timer:command', ack, () => timerCommand(request));
  });

  socket.on('disconnect', () => {
    for (const roomId of recorded) {
      presence.leave(ref(roomId)).catch((error: unknown) => {
        logger.warn({ err: error, roomId, userId }, 'Could not remove room presence');
      });
    }
    recorded.clear();
  });
};
