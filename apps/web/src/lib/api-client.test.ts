import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, apiRequestNoContent, fetchLiveness, fetchReadiness } from './api-client';

/**
 * A real `Response` (not a hand-rolled partial mock): api-client.ts reads the body via
 * `.text()`, and only a real `Response` behaves correctly for every case below,
 * including an empty body.
 */
function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function stubFetch(response: Response | Error): void {
  vi.stubGlobal('fetch', () =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
  );
}

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
});

describe('api-client', () => {
  it('returns a validated body for a successful response', async () => {
    stubFetch(respond(200, { status: 'ok' }));

    await expect(fetchLiveness()).resolves.toEqual({ status: 'ok' });
  });

  it('reports a NETWORK error when the request cannot reach the API', async () => {
    stubFetch(new TypeError('Failed to fetch'));

    const error = await rejection(fetchLiveness());

    expect(error.code).toBe('NETWORK');
    expect(error.status).toBe(0);
  });

  it('reports MALFORMED_RESPONSE when the body is not JSON', async () => {
    stubFetch(new Response('<html>not json</html>', { status: 200 }));

    const error = await rejection(fetchLiveness());

    expect(error.code).toBe('MALFORMED_RESPONSE');
    expect(error.status).toBe(200);
  });

  it('reports MALFORMED_RESPONSE when a 200 body does not match the contract', async () => {
    stubFetch(respond(200, { status: 'degraded' }));

    const error = await rejection(fetchLiveness());

    expect(error.code).toBe('MALFORMED_RESPONSE');
  });

  it('keeps the server error code and message from the shared envelope', async () => {
    stubFetch(respond(404, { error: { code: 'NOT_FOUND', message: 'No route matches GET /x' } }));

    const error = await rejection(fetchLiveness());

    expect(error.code).toBe('NOT_FOUND');
    expect(error.status).toBe(404);
    expect(error.message).toBe('No route matches GET /x');
  });

  it('falls back to INTERNAL when an error response has no envelope', async () => {
    stubFetch(respond(500, '<html>Bad gateway</html>'));

    const error = await rejection(fetchLiveness());

    expect(error.code).toBe('INTERNAL');
    expect(error.status).toBe(500);
    expect(error.details).toBe('<html>Bad gateway</html>');
  });
});

describe('fetchReadiness', () => {
  it('treats 503 as a valid answer, not an error', async () => {
    const body = { status: 'not_ready', checks: { postgres: 'ok', redis: 'unavailable' } };
    stubFetch(respond(503, body));

    await expect(fetchReadiness()).resolves.toEqual(body);
  });

  it('still throws for any other failing status', async () => {
    stubFetch(respond(500, { error: { code: 'INTERNAL', message: 'Internal server error' } }));

    const error = await rejection(fetchReadiness());

    expect(error.code).toBe('INTERNAL');
    expect(error.status).toBe(500);
  });

  it('rejects a 503 whose body is not the readiness shape', async () => {
    stubFetch(respond(503, { error: { code: 'INTERNAL', message: 'x' } }));

    const error = await rejection(fetchReadiness());

    expect(error.code).toBe('MALFORMED_RESPONSE');
  });
});

describe('apiRequestNoContent', () => {
  it('resolves without reading a body on 204', async () => {
    stubFetch(new Response(null, { status: 204 }));

    await expect(apiRequestNoContent('/anything')).resolves.toBeUndefined();
  });

  it('still throws a normal ApiError for a non-OK response', async () => {
    stubFetch(respond(401, { error: { code: 'UNAUTHENTICATED', message: 'no token' } }));

    const error = await rejection(apiRequestNoContent('/anything'));

    expect(error.code).toBe('UNAUTHENTICATED');
    expect(error.status).toBe(401);
  });
});
