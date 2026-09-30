import { TASK_TITLE_MAX_LENGTH } from '@focus-flow/contracts';

import { ApiError, type ApiErrorCode } from '../../lib/api-client';

export const INVALID_TITLE = `Enter a title of 1 to ${String(TASK_TITLE_MAX_LENGTH)} characters.`;

/** Wording for task errors; anything else falls back to the API's own message. */
const OVERRIDES: Partial<Record<ApiErrorCode, string>> = {
  TASK_NOT_FOUND: 'That task no longer exists. The list has been refreshed.',
  TASK_NOT_OPEN: 'Only an open task can be your current task.',
  VALIDATION_FAILED: INVALID_TITLE,
  NETWORK: 'Focus Flow could not reach the server. Check your connection and try again.',
  MALFORMED_RESPONSE: 'The server sent an unexpected response. Please try again.',
  INTERNAL: 'Something went wrong on the server. Please try again.',
};

export function taskErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'Something went wrong. Please try again.';
  }
  return OVERRIDES[error.code] ?? error.message;
}

export function isTaskNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'TASK_NOT_FOUND';
}
