import {
  API_BASE_PATH,
  authPaths,
  errorBodySchema,
  healthPaths,
  roomByCodePath,
  roomPaths,
} from '@focus-flow/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestHarness, stopTestHarness, type TestHarness } from '../../../test/harness.js';
import { signUpTestUser, type TestUser } from '../../../test/users.js';

// REST rate limiting (Phase 9) against the real API and Redis, with limiting turned on
// (the harness turns it off by default).

let harness: TestHarness | undefined;
let alice: TestUser | undefined;
let bob: TestUser | undefined;

const need = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error('the harness failed to start');
  }
  return value;
};

const call = (
  method: string,
  path: string,
  options: { user?: TestUser; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> =>
  fetch(`${need(harness).baseUrl}${API_BASE_PATH}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(options.user === undefined
        ? {}
        : { authorization: `Bearer ${options.user.accessToken}` }),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

beforeAll(async () => {
  harness = await startTestHarness({ HTTP_RATE_LIMIT: 'on' });
  alice = await signUpTestUser(harness, 'alice');
  bob = await signUpTestUser(harness, 'bob');
}, 120_000);

afterAll(async () => {
  if (harness !== undefined) {
    await stopTestHarness(harness);
  }
});

describe('REST rate limiting', () => {
  it('limits room-code lookups per user, with Retry-After, and leaves other users alone', async () => {
    const user = need(alice);
    const statuses: number[] = [];
    let refused: Response | undefined;
    for (let attempt = 0; attempt < 31; attempt += 1) {
      const response = await call('GET', roomByCodePath('ABCDEF'), { user });
      statuses.push(response.status);
      if (response.status === 429) {
        refused = response;
      } else {
        await response.text();
      }
    }
    expect(statuses.slice(0, 30).every((status) => status === 404)).toBe(true);
    expect(statuses[30]).toBe(429);
    expect(Number(refused?.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(errorBodySchema.parse(await refused?.json()).error.code).toBe('RATE_LIMITED');

    const other = await call('GET', roomByCodePath('ABCDEF'), { user: need(bob) });
    expect(other.status).toBe(404);
    await other.text();
  });

  it('limits room creation per user (10 per hour)', async () => {
    const user = need(bob);
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await call('POST', roomPaths.collection, {
        user,
        body: { name: `Room ${String(attempt)}`, isPrivate: false },
      });
      statuses.push(response.status);
      await response.text();
    }
    expect(statuses.slice(0, 10).every((status) => status === 201)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('limits login attempts per client address (10 per minute)', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await call('POST', authPaths.login, {
        body: { email: 'nobody@example.com', password: 'wrong-password-123' },
      });
      statuses.push(response.status);
      await response.text();
    }
    expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('never limits the health checks', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await call('GET', healthPaths.liveness);
      expect(response.status).toBe(200);
      await response.text();
    }
  });
});
