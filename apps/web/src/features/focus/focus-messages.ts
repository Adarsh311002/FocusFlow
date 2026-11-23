import { ApiError, type ApiErrorCode } from '../../lib/api-client';

/** The same wording the auth client uses for a session that is no longer usable. */
const SESSION_ENDED = 'Your session has ended. Please sign in again.';

const SERVER_ERROR = 'Something went wrong on the server. Please try again.';
// E7/E21: the server could not trust its presence data and changed nothing.
const SERVICE_UNDECIDED =
  'Focus Flow could not decide that right now and changed nothing. Please try again.';
const UNEXPECTED = 'Something went wrong. Please try again.';

/**
 * Wording for focus-session errors; anything else falls back to the API's own message.
 *
 * `INTERNAL` is deliberately not listed: api-client.ts also uses it for any non-OK response
 * that is not a contract error envelope (a gateway's 401, 403, 429), so the status is
 * consulted first. The same goes for 503, which the API sends with `INTERNAL`.
 */
const BY_CODE: Partial<Record<ApiErrorCode, string>> = {
  UNAUTHENTICATED: SESSION_ENDED,
  SESSION_INVALID: SESSION_ENDED,
  SESSION_REVOKED: 'You were signed out. Please sign in again.',
  SESSION_IN_PROGRESS: 'You already have a focus session in progress. It is shown below.',
  // Presence is what makes a session count, so the user has to be seen as connected.
  NOT_CONNECTED:
    'Focus Flow is still setting up your live connection. Wait a moment and try again.',
  TASK_NOT_FOUND: 'That task no longer exists. Pick another task or focus without one.',
  TASK_NOT_OPEN: 'That task is already completed. Reopen it or pick another task.',
  VALIDATION_FAILED: 'That focus session is not valid. Check the length and try again.',
  NOT_FOUND: 'That focus session no longer exists.',
  NETWORK: 'Focus Flow could not reach the server. Check your connection and try again.',
  MALFORMED_RESPONSE: 'The server sent an unexpected response. Please try again.',
};

const BY_STATUS: ReadonlyMap<number, string> = new Map([
  [401, SESSION_ENDED],
  [403, 'You do not have access to this focus session.'],
  [429, 'Too many requests. Please wait a moment and try again.'],
]);

export function focusErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return UNEXPECTED;
  }
  // A 503 wins over its code: whichever code it carries, nothing was changed (E7, E21).
  if (error.status === 503) {
    return SERVICE_UNDECIDED;
  }
  return (
    BY_CODE[error.code] ??
    BY_STATUS.get(error.status) ??
    (error.code === 'INTERNAL' ? SERVER_ERROR : error.message)
  );
}
