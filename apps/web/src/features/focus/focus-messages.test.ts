import { describe, expect, it } from 'vitest';

import { ApiError } from '../../lib/api-client';
import { focusErrorMessage } from './focus-messages';

const message = (code: ConstructorParameters<typeof ApiError>[0], status: number) =>
  focusErrorMessage(new ApiError(code, status, 'raw api message'));

describe('focusErrorMessage', () => {
  it('says nothing was changed for a 503, whatever its code', () => {
    expect(message('INTERNAL', 503)).toMatch(/changed nothing/);
    expect(message('NOT_FOUND', 503)).toMatch(/changed nothing/);
  });

  it('explains the focus-specific conflicts', () => {
    expect(message('NOT_CONNECTED', 409)).toMatch(/live connection/);
    expect(message('TASK_NOT_FOUND', 404)).toMatch(/no longer exists/);
    expect(message('TASK_NOT_OPEN', 409)).toMatch(/completed/);
    expect(message('SESSION_IN_PROGRESS', 409)).toMatch(/already have a focus session/);
  });

  it('has wording for network failure and a malformed response', () => {
    expect(message('NETWORK', 0)).toMatch(/could not reach/);
    expect(message('MALFORMED_RESPONSE', 200)).toMatch(/unexpected response/);
  });

  it('does not turn a gateway 429 or a generic 500 into the API message', () => {
    expect(message('INTERNAL', 429)).toMatch(/Too many requests/);
    expect(message('INTERNAL', 500)).toMatch(/Something went wrong on the server/);
  });

  it('falls back for errors that are not API errors', () => {
    expect(focusErrorMessage(new Error('boom'))).toBe('Something went wrong. Please try again.');
    expect(focusErrorMessage('x')).toBe('Something went wrong. Please try again.');
  });
});
