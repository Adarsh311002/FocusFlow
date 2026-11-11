import { roomFocusParticipantsEventSchema, roomIdSchema } from '@focus-flow/contracts';
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
