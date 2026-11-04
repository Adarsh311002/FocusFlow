import {
  CHAT_BODY_MAX_LENGTH,
  ROOM_CODE_LENGTH,
  ROOM_NAME_MAX_LENGTH,
} from '@focus-flow/contracts';

import { ApiError, type ApiErrorCode } from '../../lib/api-client';
import type { RoomFailureAck } from '../realtime/room-events';

export const INVALID_ROOM_NAME = `Enter a room name of 1 to ${String(ROOM_NAME_MAX_LENGTH)} characters.`;
export const INVALID_ROOM_CODE = `A room code has ${String(ROOM_CODE_LENGTH)} letters and numbers. Check it and try again.`;
export const INVALID_CHAT_BODY = `Write a message of 1 to ${String(CHAT_BODY_MAX_LENGTH)} characters.`;

const SESSION_ENDED = 'Your session has ended. Please sign in again.';
const OFFLINE = 'Focus Flow could not reach the server. Check your connection and try again.';
const SERVER_ERROR = 'Something went wrong on the server. Please try again.';

/**
 * One wording for every room code, whether it came from REST or from a socket
 * acknowledgement (the same closed union, docs/api/socket-events.md). Codes without an
 * entry fall back to the server's own message.
 */
const BY_CODE: Partial<Record<ApiErrorCode | RoomFailureAck['error']['code'], string>> = {
  UNAUTHENTICATED: SESSION_ENDED,
  SESSION_INVALID: SESSION_ENDED,
  SESSION_REVOKED: 'You were signed out. Please sign in again.',
  ROOM_NOT_FOUND: 'No room was found. It may have been removed, or you are not a member.',
  NOT_A_MEMBER: 'You are not a member of this room.',
  NOT_JOINED: 'You are not connected to this room right now. Reconnecting…',
  NOT_HOST: 'Only the host can do that.',
  HOST_CANNOT_LEAVE: 'The host cannot leave their own room.',
  CANNOT_REMOVE_HOST: 'The host cannot be removed from the room.',
  KNOCK_REQUIRED: 'This room is private. Ask the host to let you in.',
  KNOCK_EXPIRED: 'That request has expired. Ask the person to knock again.',
  NOT_PRIVATE: 'This room is not private, so there is no need to ask. Try joining it.',
  ALREADY_MEMBER: 'You are already a member of this room.',
  HOST_OFFLINE: 'The host is not online right now, so they cannot answer. Try again later.',
  ROOM_FULL: 'This room is full right now. Try again in a little while.',
  RATE_LIMITED: 'You are doing that too often. Wait a moment and try again.',
  VALIDATION_FAILED: 'That was not accepted. Check what you entered and try again.',
  NETWORK: OFFLINE,
  OFFLINE: 'You are offline, so this could not be sent. Wait for the connection and try again.',
  TIMEOUT: 'The server did not answer in time. Please try again.',
  MALFORMED_RESPONSE: 'The server sent an unexpected response. Please try again.',
  INTERNAL: SERVER_ERROR,
};

const BY_STATUS: ReadonlyMap<number, string> = new Map([
  [401, SESSION_ENDED],
  [429, 'You are doing that too often. Wait a moment and try again.'],
]);

export function roomErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'Something went wrong. Please try again.';
  }
  // A body that is not a contract envelope (a gateway's 429 page) arrives as `INTERNAL`
  // with its status, so the status is consulted first for those.
  if (error.code === 'INTERNAL') {
    return BY_STATUS.get(error.status) ?? SERVER_ERROR;
  }
  return BY_CODE[error.code] ?? error.message;
}

/** The wording for a failed socket acknowledgement. */
export function socketErrorMessage(failure: RoomFailureAck): string {
  return BY_CODE[failure.error.code] ?? failure.error.message;
}

export const isApiErrorCode = (error: unknown, code: ApiErrorCode): boolean =>
  error instanceof ApiError && error.code === code;
