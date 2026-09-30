import { API_BASE_PATH, authPaths, authResponseSchema } from '@focus-flow/contracts';

import type { TestHarness } from './harness.js';

export type TestUser = {
  readonly userId: string;
  readonly email: string;
  readonly accessToken: string;
};

/**
 * Signs a fresh user up through the real API and returns its access token, so feature
 * integration tests authenticate exactly the way a client does. Emails are unique per
 * call, so tests can create as many users as they need.
 */
export const signUpTestUser = async (harness: TestHarness, label = 'user'): Promise<TestUser> => {
  const email = `${label}-${Math.random().toString(36).slice(2)}@example.com`;
  const response = await fetch(`${harness.baseUrl}${API_BASE_PATH}${authPaths.signup}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'a-long-enough-password', displayName: 'Test User' }),
  });
  if (response.status !== 201) {
    throw new Error(`test signup failed with HTTP ${String(response.status)}`);
  }
  const body = authResponseSchema.parse(await response.json());
  return { userId: body.user.id, email, accessToken: body.accessToken };
};
