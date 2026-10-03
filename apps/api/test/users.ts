import { API_BASE_PATH, authPaths, authResponseSchema } from '@focus-flow/contracts';

import type { TestHarness } from './harness.js';

export const TEST_PASSWORD = 'a-long-enough-password';
const REFRESH_COOKIE_NAME = 'ff_refresh_token';

export type TestUser = {
  readonly userId: string;
  readonly email: string;
  readonly accessToken: string;
  /** The refresh cookie value of this session (for logout). */
  readonly refreshCookie: string;
};

const readRefreshCookie = (response: Response): string => {
  const entry = response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`${REFRESH_COOKIE_NAME}=`));
  const value = entry?.split(';')[0]?.slice(REFRESH_COOKIE_NAME.length + 1);
  if (value === undefined || value.length === 0) {
    throw new Error('the auth response set no refresh cookie');
  }
  return value;
};

const authenticate = async (
  harness: Pick<TestHarness, 'baseUrl'>,
  path: string,
  body: Record<string, string>,
  expectedStatus: number,
): Promise<TestUser> => {
  const response = await fetch(`${harness.baseUrl}${API_BASE_PATH}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (response.status !== expectedStatus) {
    throw new Error(`test auth request failed with HTTP ${String(response.status)}`);
  }
  const refreshCookie = readRefreshCookie(response);
  const parsed = authResponseSchema.parse(await response.json());
  return {
    userId: parsed.user.id,
    email: parsed.user.email,
    accessToken: parsed.accessToken,
    refreshCookie,
  };
};

/**
 * Signs a fresh user up through the real API and returns its access token, so feature
 * integration tests authenticate exactly the way a client does. Emails are unique per
 * call, so tests can create as many users as they need.
 */
export const signUpTestUser = (
  harness: Pick<TestHarness, 'baseUrl'>,
  label = 'user',
): Promise<TestUser> =>
  authenticate(
    harness,
    authPaths.signup,
    {
      email: `${label}-${Math.random().toString(36).slice(2)}@example.com`,
      password: TEST_PASSWORD,
      displayName: 'Test User',
    },
    201,
  );

/** A second, independent session (another device) for an existing test user. */
export const logInTestUser = (
  harness: Pick<TestHarness, 'baseUrl'>,
  user: TestUser,
): Promise<TestUser> =>
  authenticate(harness, authPaths.login, { email: user.email, password: TEST_PASSWORD }, 200);

/** Logs one session out through the real endpoint (cookie + client header). */
export const logOutTestUser = async (
  harness: Pick<TestHarness, 'baseUrl'>,
  user: TestUser,
): Promise<void> => {
  const response = await fetch(`${harness.baseUrl}${API_BASE_PATH}${authPaths.logout}`, {
    method: 'POST',
    headers: {
      Cookie: `${REFRESH_COOKIE_NAME}=${user.refreshCookie}`,
      'x-focus-flow-client': 'test',
    },
  });
  if (response.status !== 204) {
    throw new Error(`test logout failed with HTTP ${String(response.status)}`);
  }
};
