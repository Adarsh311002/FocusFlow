import {
  type FocusSessionView,
  roomFocusCheckInEventSchema,
  roomFocusParticipantsEventSchema,
  roomIdSchema,
} from '@focus-flow/contracts';
import type { Logger } from 'pino';

import type { SocketEmitter } from '../../platform/socket.js';
import { roomRoom, userRoom } from '../realtime/types.js';
import type { RoomFocusChange, RoomFocusService } from '../room-focus/types.js';

// The events of room focus runs (RF12), sent after the PostgreSQL/Redis change committed and
// independent of each other: a failure is logged and never reaches the request or job that
// caused it. Both events are hints; clients heal a miss from the join snapshot or a REST read.

/** Sends `room:focus:participants` with the room's current run and participants. */
export const announceParticipants = async (
  service: Pick<RoomFocusService, 'participants'>,
  emitter: SocketEmitter,
  logger: Logger,
  roomId: string,
): Promise<void> => {
  try {
    const { focusRunId, participants, participantsVersion } = await service.participants(roomId);
    emitter.to(roomRoom(roomId)).emit(
      'room:focus:participants',
      roomFocusParticipantsEventSchema.parse({
        roomId: roomIdSchema.parse(roomId),
        focusRunId,
        participants,
        participantsVersion,
      }),
    );
  } catch (error) {
    logger.warn({ err: error, roomId }, 'Could not announce the room focus participants');
  }
};

/** Announces one committed change; never throws (RF12). */
export const createFocusChangeAnnouncer =
  (
    service: Pick<RoomFocusService, 'participants'>,
    emitter: SocketEmitter,
    logger: Logger,
  ): ((change: RoomFocusChange) => Promise<void>) =>
  async (change) => {
    if (change.kind === 'participants') {
      await announceParticipants(service, emitter, logger, change.roomId);
      return;
    }
    try {
      emitter.to(userRoom(change.userId)).emit('focus:session:updated', {
        session: change.session,
      });
    } catch (error) {
      logger.warn({ err: error, userId: change.userId }, 'Could not announce a focus session');
    }
  };

/**
 * Subscribes to the service's committed changes: a participant-list change goes to the room,
 * a session change to every tab of its owner (`focus:session:updated`, E6).
 */
export const attachFocusAnnouncers = (
  service: Pick<RoomFocusService, 'onChange' | 'participants'>,
  emitter: SocketEmitter,
  logger: Logger,
): void => {
  service.onChange(createFocusChangeAnnouncer(service, emitter, logger));
};

/** The part of the session changes this listener needs (focus-sessions/changes.ts). */
type SessionChanges = {
  readonly subscribe: (
    listener: (change: {
      readonly userId: string;
      readonly transition: string;
      readonly session: FocusSessionView;
    }) => void,
  ) => () => void;
};

/**
 * RI3: when a participant of a room run checks in, the room hears the outcome
 * (`room:focus:check-in`), so the page can show who finished. The note never leaves the
 * owner. A hint like the other room events: nothing about it is stored for the room.
 */
export const attachRoomCheckInAnnouncements = (
  changes: SessionChanges,
  emitter: SocketEmitter,
  logger: Logger,
): (() => void) =>
  changes.subscribe((change) => {
    const { session } = change;
    if (
      change.transition !== 'checked_in' ||
      session.status === 'in_progress' ||
      session.context.kind !== 'room' ||
      session.checkIn === null
    ) {
      return;
    }
    try {
      emitter.to(roomRoom(session.context.roomId)).emit(
        'room:focus:check-in',
        roomFocusCheckInEventSchema.parse({
          roomId: session.context.roomId,
          focusRunId: session.context.focusRunId,
          userId: change.userId,
          outcome: session.checkIn.outcome,
        }),
      );
    } catch (error) {
      logger.warn({ err: error, sessionId: session.id }, 'Could not announce a room check-in');
    }
  });
