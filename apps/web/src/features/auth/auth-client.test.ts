import { authPaths, CLIENT_HEADER_NAME, mePaths, userViewSchema } from '@focus-flow/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ApiError } from '../../lib/api-client';
import {
  authBody,
  errorResponse,
  jsonResponse,
  noContentResponse,
  parsedBody,
  refreshBody,
  requestsTo,
  stubFetch,
  userBody,
} from '../../test/api-stub';
import {
  authedApiRequest,
  fetchMe,
  login,
  logout,
  refresh,
  resetPendingRefresh,
  restoreSession,
  signup,
} from './auth-client';
import { clearAccessToken, getAccessToken, setAccessToken } from './token-store';

/** The `GET /me` envelope, composed from the published user schema (see auth-client.ts). */
const meEnvelopeSchema = z.object({ user: userViewSchema });

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the request to be rejected');
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearAccessToken();
  resetPendingRefresh();
});

describe('signup', () => {
  it('posts the credentials as JSON and returns the parsed auth response', async () => {
    const calls = stubFetch(() => jsonResponse(201, authBody('signup-token')));

    const result = await signup({
      email: 'ada@example.com',
      password: 'correct horse',
      displayName: 'Ada Lovelace',
    });

    expect(result.accessToken).toBe('signup-token');
    expect(result.user).toEqual(userBody);

    const request = requestsTo(calls, authPaths.signup)[0]!;
    expect(request.method).toBe('POST');
    expect(request.headers.get('content-type')).toBe('application/json');
    expect(parsedBody(request)).toEqual({
      email: 'ada@example.com',
      password: 'correct horse',
      displayName: 'Ada Lovelace',
    });
  });

  it('surfaces EMAIL_TAKEN as an ApiError', async () => {
    stubFetch(() => errorResponse(409, 'EMAIL_TAKEN', 'Email already registered.'));

    const error = await rejection(
      signup({ email: 'ada@example.com', password: 'correct horse', displayName: 'Ada' }),
    );

    expect(error.code).toBe('EMAIL_TAKEN');
    expect(error.status).toBe(409);
  });
});

describe('login', () => {
  it('posts email and password only', async () => {
    const calls = stubFetch(() => jsonResponse(200, authBody('login-token')));

    const result = await login({ email: 'ada@example.com', password: 'correct horse' });

    expect(result.accessToken).toBe('login-token');
    const request = requestsTo(calls, authPaths.login)[0]!;
    expect(parsedBody(request)).toEqual({ email: 'ada@example.com', password: 'correct horse' });
  });

  it('surfaces INVALID_CREDENTIALS as an ApiError', async () => {
    stubFetch(() => errorResponse(401, 'INVALID_CREDENTIALS', 'Invalid email or password.'));

    const error = await rejection(login({ email: 'ada@example.com', password: 'wrong pass' }));

    expect(error.code).toBe('INVALID_CREDENTIALS');
  });
});

describe('refresh', () => {
  it('sends no body, carries the client header, and stores the new token', async () => {
    const calls = stubFetch(() => jsonResponse(200, refreshBody('fresh-token')));

    await expect(refresh()).resolves.toEqual({
      status: 'refreshed',
      accessToken: 'fresh-token',
    });

    const request = requestsTo(calls, authPaths.refresh)[0]!;
    expect(request.method).toBe('POST');
    expect(request.body).toBeNull();
    expect(request.headers.get(CLIENT_HEADER_NAME)).not.toBeNull();
    expect(getAccessToken()).toBe('fresh-token');
  });

  it('treats a 401 SESSION_INVALID as "not signed in" rather than an error', async () => {
    stubFetch(() => errorResponse(401, 'SESSION_INVALID', 'Refresh session is invalid.'));

    await expect(refresh()).resolves.toEqual({
      status: 'no-session',
      reason: 'SESSION_INVALID',
    });
    expect(getAccessToken()).toBeNull();
  });

  it('treats a 401 SESSION_REVOKED the same way', async () => {
    setAccessToken('stale-token');
    stubFetch(() => errorResponse(401, 'SESSION_REVOKED', 'This session has been revoked.'));

    await expect(refresh()).resolves.toEqual({
      status: 'no-session',
      reason: 'SESSION_REVOKED',
    });
    // The stale token is dropped: it can no longer be refreshed.
    expect(getAccessToken()).toBeNull();
  });

  it('still rejects for a failure that is not about the session', async () => {
    stubFetch(() => errorResponse(500, 'INTERNAL', 'Internal server error'));

    const error = await rejection(refresh());

    expect(error.code).toBe('INTERNAL');
  });

  it('issues one network call for concurrent callers (single flight)', async () => {
    const calls = stubFetch(() => jsonResponse(200, refreshBody('shared-token')));

    const outcomes = await Promise.all([refresh(), refresh(), refresh()]);

    expect(requestsTo(calls, authPaths.refresh)).toHaveLength(1);
    for (const outcome of outcomes) {
      expect(outcome).toEqual({ status: 'refreshed', accessToken: 'shared-token' });
    }
  });

  it('starts a new flight once the previous one has settled', async () => {
    const calls = stubFetch(() => jsonResponse(200, refreshBody()));

    await refresh();
    await refresh();

    expect(requestsTo(calls, authPaths.refresh)).toHaveLength(2);
  });
});

describe('logout', () => {
  it('posts with the client header, tolerates the empty 204 body, and drops the token', async () => {
    setAccessToken('live-token');
    const calls = stubFetch(() => noContentResponse());

    await expect(logout()).resolves.toBeUndefined();

    const request = requestsTo(calls, authPaths.logout)[0]!;
    expect(request.method).toBe('POST');
    expect(request.body).toBeNull();
    expect(request.headers.get(CLIENT_HEADER_NAME)).not.toBeNull();
    expect(getAccessToken()).toBeNull();
  });

  it('drops the token even when the call fails', async () => {
    setAccessToken('live-token');
    stubFetch(() => errorResponse(500, 'INTERNAL', 'Internal server error'));

    const error = await rejection(logout());

    expect(error.code).toBe('INTERNAL');
    expect(getAccessToken()).toBeNull();
  });
});

describe('fetchMe', () => {
  it('sends the bearer token and returns the user', async () => {
    setAccessToken('live-token');
    const calls = stubFetch(() => jsonResponse(200, { user: userBody }));

    await expect(fetchMe()).resolves.toEqual(userBody);

    const request = requestsTo(calls, mePaths.self)[0]!;
    expect(request.headers.get('authorization')).toBe('Bearer live-token');
  });

  it('refreshes first when no token is cached yet', async () => {
    const calls = stubFetch((request) =>
      request.url.endsWith(authPaths.refresh)
        ? jsonResponse(200, refreshBody('after-reload'))
        : jsonResponse(200, { user: userBody }),
    );

    await expect(fetchMe()).resolves.toEqual(userBody);

    expect(requestsTo(calls, authPaths.refresh)).toHaveLength(1);
    expect(requestsTo(calls, mePaths.self)[0]!.headers.get('authorization')).toBe(
      'Bearer after-reload',
    );
  });

  it('refreshes once and replays the request after a 401 UNAUTHENTICATED', async () => {
    setAccessToken('expired-token');
    let meAttempts = 0;
    const calls = stubFetch((request) => {
      if (request.url.endsWith(authPaths.refresh)) {
        return jsonResponse(200, refreshBody('renewed'));
      }
      meAttempts += 1;
      return meAttempts === 1
        ? errorResponse(401, 'UNAUTHENTICATED', 'Access token expired.')
        : jsonResponse(200, { user: userBody });
    });

    await expect(fetchMe()).resolves.toEqual(userBody);

    const meRequests = requestsTo(calls, mePaths.self);
    expect(meRequests).toHaveLength(2);
    expect(meRequests[0]!.headers.get('authorization')).toBe('Bearer expired-token');
    expect(meRequests[1]!.headers.get('authorization')).toBe('Bearer renewed');
    expect(requestsTo(calls, authPaths.refresh)).toHaveLength(1);
  });

  it('retries exactly once and never loops', async () => {
    setAccessToken('expired-token');
    const calls = stubFetch((request) =>
      request.url.endsWith(authPaths.refresh)
        ? jsonResponse(200, refreshBody('renewed'))
        : errorResponse(401, 'UNAUTHENTICATED', 'Access token expired.'),
    );

    const error = await rejection(fetchMe());

    expect(error.code).toBe('UNAUTHENTICATED');
    expect(requestsTo(calls, mePaths.self)).toHaveLength(2);
    expect(requestsTo(calls, authPaths.refresh)).toHaveLength(1);
  });

  it('gives up and clears the token when the refresh finds no session', async () => {
    setAccessToken('expired-token');
    stubFetch((request) =>
      request.url.endsWith(authPaths.refresh)
        ? errorResponse(401, 'SESSION_INVALID', 'Refresh session is invalid.')
        : errorResponse(401, 'UNAUTHENTICATED', 'Access token expired.'),
    );

    const error = await rejection(fetchMe());

    expect(error.code).toBe('SESSION_INVALID');
    expect(getAccessToken()).toBeNull();
  });

  it('does not attempt a refresh when the session was revoked', async () => {
    setAccessToken('live-token');
    const calls = stubFetch(() =>
      errorResponse(401, 'SESSION_REVOKED', 'This session has been revoked.'),
    );

    const error = await rejection(fetchMe());

    expect(error.code).toBe('SESSION_REVOKED');
    expect(requestsTo(calls, authPaths.refresh)).toHaveLength(0);
    expect(getAccessToken()).toBeNull();
  });
});

describe('authedApiRequest single flight', () => {
  it('refreshes once when two authenticated requests start with no token', async () => {
    const calls = stubFetch((request) =>
      request.url.endsWith(authPaths.refresh)
        ? jsonResponse(200, refreshBody('one-and-only'))
        : jsonResponse(200, { user: userBody }),
    );

    const [first, second] = await Promise.all([fetchMe(), fetchMe()]);

    expect(requestsTo(calls, authPaths.refresh)).toHaveLength(1);
    expect(requestsTo(calls, mePaths.self)).toHaveLength(2);
    expect(first).toEqual(userBody);
    expect(second).toEqual(userBody);
  });

  it('refreshes once when two in-flight requests both come back 401', async () => {
    setAccessToken('expired-token');
    // The first attempt from each of the two callers is rejected; their replays succeed.
    let meAttempts = 0;
    const calls = stubFetch((request) => {
      if (request.url.endsWith(authPaths.refresh)) {
        return jsonResponse(200, refreshBody('renewed'));
      }
      meAttempts += 1;
      return meAttempts <= 2
        ? errorResponse(401, 'UNAUTHENTICATED', 'Access token expired.')
        : jsonResponse(200, { user: userBody });
    });

    await Promise.all([fetchMe(), fetchMe()]);

    expect(requestsTo(calls, authPaths.refresh)).toHaveLength(1);
    expect(requestsTo(calls, mePaths.self)).toHaveLength(4);
  });
});

describe('authedApiRequest', () => {
  it('lets a caller add its own headers without losing the bearer token', async () => {
    setAccessToken('live-token');
    const calls = stubFetch(() => jsonResponse(200, { user: userBody }));

    await authedApiRequest(mePaths.self, meEnvelopeSchema, {
      headers: { 'X-Trace': 'abc' },
    });

    const request = requestsTo(calls, mePaths.self)[0]!;
    expect(request.headers.get('authorization')).toBe('Bearer live-token');
    expect(request.headers.get('x-trace')).toBe('abc');
    expect(request.headers.get('accept')).toBe('application/json');
  });
});

describe('restoreSession', () => {
  it('returns the user when the refresh cookie still names a live session', async () => {
    const calls = stubFetch((request) =>
      request.url.endsWith(authPaths.refresh)
        ? jsonResponse(200, refreshBody('restored'))
        : jsonResponse(200, { user: userBody }),
    );

    await expect(restoreSession()).resolves.toEqual(userBody);
    expect(requestsTo(calls, authPaths.refresh)).toHaveLength(1);
  });

  it('resolves to null for a visitor with no session, without throwing', async () => {
    stubFetch(() => errorResponse(401, 'SESSION_INVALID', 'Refresh session is invalid.'));

    await expect(restoreSession()).resolves.toBeNull();
    expect(getAccessToken()).toBeNull();
  });

  it('resolves to null when the API is failing, rather than crashing the app', async () => {
    stubFetch(() => errorResponse(500, 'INTERNAL', 'Internal server error'));

    await expect(restoreSession()).resolves.toBeNull();
  });
});
