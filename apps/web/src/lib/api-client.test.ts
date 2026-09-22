import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, fetchLiveness, fetchReadiness } from './api-client';

/** Only the parts of `Response` that the api-client actually reads. */
type StubResponse = Pick<Response, 'ok' | 'status'> & { json: () => Promise<unknown> };

function respond(status: number, body: unknown): StubResponse {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

function stubFetch(response: StubResponse | Error): void {
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
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError('Unexpected token <')),
      }),
    );

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
