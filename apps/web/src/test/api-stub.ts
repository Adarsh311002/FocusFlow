import type { ErrorCode } from '@focus-flow/contracts';
import { vi } from 'vitest';
import { z } from 'zod';

const jsonObjectSchema = z.record(z.string(), z.unknown());

/**
 * A real `Response`, not a hand-rolled partial mock: api-client.ts reads the body via
 * `.text()`, and only a real `Response` behaves correctly for every case, including an
 * empty (204) body.
 */
export type StubResponse = Response;

/** What a stubbed `fetch` saw, in a shape assertions can read directly. */
export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string | null;
}

export type RequestHandler = (request: RecordedRequest) => StubResponse | Promise<StubResponse>;

/**
 * Replaces the global `fetch` and returns the live list of requests it received, so a
 * test can assert both on what was sent and on how many times. `vi.unstubAllGlobals()`
 * in an `afterEach` puts the real `fetch` back, matching `system-status.test.tsx`.
 */
export function stubFetch(handler: RequestHandler): RecordedRequest[] {
  const calls: RecordedRequest[] = [];

  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const request: RecordedRequest = {
      url: input,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null,
    };
    calls.push(request);
    return await handler(request);
  });

  return calls;
}

export function jsonResponse(status: number, body: unknown): StubResponse {
  return new Response(JSON.stringify(body), { status });
}

/** A 204: an empty body, exactly as a browser sees it. */
export function noContentResponse(): StubResponse {
  return new Response(null, { status: 204 });
}

export function errorResponse(status: number, code: ErrorCode, message = 'Request failed.') {
  return jsonResponse(status, { error: { code, message } });
}

export function requestsTo(calls: readonly RecordedRequest[], path: string): RecordedRequest[] {
  return calls.filter((call) => call.url.endsWith(path));
}

/** Parsed through a schema rather than cast, so no `any` escapes into the assertions. */
export function parsedBody(request: RecordedRequest): Record<string, unknown> {
  return request.body === null ? {} : jsonObjectSchema.parse(JSON.parse(request.body));
}

/**
 * The raw JSON bodies the API sends, kept unbranded so tests never cast a string into a
 * `UserId` — the schemas do that when the client parses the response.
 */
export const userBody = {
  id: '3f1c4b0a-5b6d-4e2f-9a8b-7c6d5e4f3a2b',
  email: 'ada@example.com',
  emailVerified: false,
  displayName: 'Ada Lovelace',
  avatarUrl: null,
  identities: [],
};

export const accessTokenExpiresAt = '2030-01-01T00:00:00.000Z';

export function authBody(accessToken = 'access-token-1') {
  return { user: userBody, accessToken, accessTokenExpiresAt };
}

export function refreshBody(accessToken = 'refreshed-token-1') {
  return { accessToken, accessTokenExpiresAt };
}
