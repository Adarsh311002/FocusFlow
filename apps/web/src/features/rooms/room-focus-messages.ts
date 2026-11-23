import { ApiError } from '../../lib/api-client';
import { focusErrorMessage } from '../focus/focus-messages';
import { roomErrorMessage } from './room-messages';

/** Wording for the opt-in / opt-out answers (RF4, RF8); the server's code decides, never us. */
const BY_CODE: Partial<Record<ApiError['code'], string>> = {
  RUN_CHANGED:
    'The focus run changed while you were joining (the host reset or switched the timer). Check the timer and join again.',
  RUN_ENDING:
    'This focus phase is about to end, so there is too little time left to join. Join the next one.',
  NOT_PRESENT:
    'You need to be in the room and connected to join. Wait for the room to reconnect, then try again.',
  NOT_FOCUS_PHASE: 'You can only join during a focus phase. Wait for the next one.',
  SESSION_IN_PROGRESS:
    'You already have a focus session in progress (on your own or in another room). Finish or leave it first.',
  NOT_A_MEMBER: 'You are not a member of this room, so you cannot join its focus run.',
  ROOM_NOT_FOUND: 'This room could not be found, or you are not a member of it.',
  NOT_SOLO_SESSION: 'That session belongs to a room. Manage it from the room.',
};

export function roomFocusErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'Something went wrong. Please try again.';
  }
  // A 503 means the server could not decide and changed nothing (E21): say so.
  if (error.status === 503) {
    return focusErrorMessage(error);
  }
  const own = BY_CODE[error.code];
  if (own !== undefined) {
    return own;
  }
  if (error.code === 'TASK_NOT_FOUND' || error.code === 'TASK_NOT_OPEN') {
    return focusErrorMessage(error);
  }
  return roomErrorMessage(error);
}
