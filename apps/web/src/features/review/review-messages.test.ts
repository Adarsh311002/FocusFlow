import { describe, expect, it } from 'vitest';

import { ApiError } from '../../lib/api-client';
import { reviewErrorMessage } from './review-messages';

const SESSION_ENDED = 'Your session has ended. Please sign in again.';
const SERVER_ERROR = 'Something went wrong on the server. Please try again.';
const UNEXPECTED = 'Something went wrong. Please try again.';

describe('reviewErrorMessage', () => {
  it.each([
    ['UNAUTHENTICATED', 401, SESSION_ENDED],
    ['SESSION_INVALID', 401, SESSION_ENDED],
    ['SESSION_REVOKED', 401, 'You were signed out. Please sign in again.'],
    ['VALIDATION_FAILED', 400, 'Focus Flow could not load this period. Please reload the page.'],
    ['NOT_FOUND', 404, 'Focus Flow could not load this period. Please reload the page.'],
    ['INTERNAL', 500, SERVER_ERROR],
    ['NETWORK', 0, 'Focus Flow could not reach the server. Check your connection and try again.'],
    ['MALFORMED_RESPONSE', 200, 'The server sent an unexpected response. Please try again.'],
  ] as const)('replaces the raw message for %s', (code, status, expected) => {
    // The raw text stands in for whatever the server (or api-client.ts) wrote.
    expect(reviewErrorMessage(new ApiError(code, status, 'raw technical text'))).toBe(expected);
  });

  it.each([
    [401, SESSION_ENDED],
    [403, 'You do not have access to this focus history.'],
    [429, 'Too many requests. Please wait a moment and try again.'],
  ])('maps HTTP %i even when the body carried no contract code', (status, expected) => {
    // api-client.ts turns a body it cannot parse as an error envelope into `INTERNAL`
    // with the real status, which is how a gateway's 401/403/429 arrives here.
    const raw = `The API returned an unexpected error (HTTP ${String(status)}).`;
    const error = new ApiError('INTERNAL', status, raw);

    expect(reviewErrorMessage(error)).toBe(expected);
  });

  it('keeps the API message for a code with no override', () => {
    expect(
      reviewErrorMessage(new ApiError('SESSION_IN_PROGRESS', 409, 'A session is already running.')),
    ).toBe('A session is already running.');
  });

  it.each([
    ['a plain Error', new Error('boom')],
    ['a thrown string', 'boom'],
    ['nothing at all', undefined],
  ])('answers the generic wording for %s', (_name, error: unknown) => {
    expect(reviewErrorMessage(error)).toBe(UNEXPECTED);
  });
});
