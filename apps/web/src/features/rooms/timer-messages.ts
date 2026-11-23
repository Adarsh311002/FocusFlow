import type { RoomFailureAck } from '../realtime/room-events';
import { socketErrorMessage } from './room-messages';

/** The wording for a timer command the server refused or never answered. */
export const TIMER_VERSION_CONFLICT = 'The timer changed; here is the current state.';

export const TIMER_RESTORED = 'The timer was restored on the server; refreshing.';

const BY_CODE: Partial<Record<RoomFailureAck['error']['code'], string>> = {
  NOT_HOST: 'Permission denied: only the host can control the timer.',
  NOT_JOINED: 'You are not connected to this room right now. Wait for it to reconnect.',
  RATE_LIMITED: 'You are using the timer controls too quickly. Wait a moment and try again.',
  VERSION_CONFLICT: TIMER_VERSION_CONFLICT,
  INVALID_TRANSITION:
    'That is not possible with the timer as it is now. The current state is shown.',
  TIMEOUT:
    'The server did not answer in time. The timer may have changed; check the state shown and try again.',
  INTERNAL: 'Something went wrong on the server. Please try again.',
  OFFLINE: 'You are offline, so the timer cannot be changed. Wait for the connection.',
};

export function timerErrorMessage(failure: RoomFailureAck): string {
  return BY_CODE[failure.error.code] ?? socketErrorMessage(failure);
}
