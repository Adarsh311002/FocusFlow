import { describe, expect, it } from 'vitest';

import { ApiError } from '../../lib/api-client';
import { roomFocusErrorMessage } from './room-focus-messages';

const error = (
  code: ConstructorParameters<typeof ApiError>[0],
  status = 409,
  message = 'Server.',
) => new ApiError(code, status, message);

describe('roomFocusErrorMessage', () => {
  it.each([
    ['RUN_CHANGED', /run changed/],
    ['RUN_ENDING', /about to end/],
    ['NOT_PRESENT', /in the room and connected/],
    ['NOT_FOCUS_PHASE', /focus phase/],
    ['SESSION_IN_PROGRESS', /already have a focus session/],
    ['NOT_A_MEMBER', /not a member/],
    ['TASK_NOT_FOUND', /task no longer exists/],
    ['TASK_NOT_OPEN', /already completed/],
  ] as const)('explains %s in plain words', (code, pattern) => {
    expect(roomFocusErrorMessage(error(code))).toMatch(pattern);
  });

  it('says a 503 changed nothing', () => {
    expect(roomFocusErrorMessage(error('INTERNAL', 503))).toMatch(/changed nothing/);
  });

  it('falls back to the room wording for other codes and to a generic line for non-API errors', () => {
    expect(roomFocusErrorMessage(error('RATE_LIMITED', 429))).toMatch(/too often/);
    expect(roomFocusErrorMessage(new Error('boom'))).toBe(
      'Something went wrong. Please try again.',
    );
  });
});
