import { ApiError, type ApiErrorCode } from '../../lib/api-client';

/** The same wording the auth client uses for a session that is no longer usable. */
const SESSION_ENDED = 'Your session has ended. Please sign in again.';

const SERVER_ERROR = 'Something went wrong on the server. Please try again.';
const UNEXPECTED = 'Something went wrong. Please try again.';

/**
 * Wording for review errors; anything else falls back to the API's own message.
 *
 * `INTERNAL` is deliberately not listed here: api-client.ts also uses that code for any
 * non-OK response whose body is not a contract error envelope — a gateway's 401, 403 or
 * 429 page — so the status is consulted before falling back to the server-error wording.
 */
const BY_CODE: Partial<Record<ApiErrorCode, string>> = {
  UNAUTHENTICATED: SESSION_ENDED,
  SESSION_INVALID: SESSION_ENDED,
  SESSION_REVOKED: 'You were signed out. Please sign in again.',
  // The only inputs the page sends are the range, the limit and a cursor, so a rejected
  // request means this page's state is unusable rather than anything the user typed.
  VALIDATION_FAILED: 'Focus Flow could not load this period. Please reload the page.',
  NOT_FOUND: 'Focus Flow could not load this period. Please reload the page.',
  NETWORK: 'Focus Flow could not reach the server. Check your connection and try again.',
  MALFORMED_RESPONSE: 'The server sent an unexpected response. Please try again.',
};

/**
 * Statuses the review requests can come back with without a contract code of their own:
 * a 401 or 403 from in front of the API, and a 429 once rate limiting is in place (a
 * tracked follow-up). Without these, api-client.ts's own technical text ("The API
 * returned an unexpected error (HTTP 429).") would be shown to the user.
 */
const BY_STATUS: ReadonlyMap<number, string> = new Map([
  [401, SESSION_ENDED],
  [403, 'You do not have access to this focus history.'],
  [429, 'Too many requests. Please wait a moment and try again.'],
]);

export function reviewErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return UNEXPECTED;
  }
  return (
    BY_CODE[error.code] ??
    BY_STATUS.get(error.status) ??
    (error.code === 'INTERNAL' ? SERVER_ERROR : error.message)
  );
}
