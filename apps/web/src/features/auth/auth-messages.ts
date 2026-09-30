import { ApiError, type ApiErrorCode } from '../../lib/api-client';

/**
 * Wording the forms show. Only codes whose server message would leak implementation
 * detail or read badly are overridden; anything else falls back to the API's own
 * message, which the contract already defines as user-facing.
 */
const OVERRIDES: Partial<Record<ApiErrorCode, string>> = {
  EMAIL_TAKEN: 'An account already exists for that email address.',
  // The API deliberately answers the same way for an unknown email and a wrong
  // password, so this message must not distinguish them either.
  INVALID_CREDENTIALS: 'That email address and password do not match an account.',
  VALIDATION_FAILED: 'Please check the details you entered and try again.',
  NETWORK: 'Focus Flow could not reach the server. Check your connection and try again.',
  MALFORMED_RESPONSE: 'The server sent an unexpected response. Please try again.',
  INTERNAL: 'Something went wrong on the server. Please try again.',
};

export function authErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'Something went wrong. Please try again.';
  }
  return OVERRIDES[error.code] ?? error.message;
}
