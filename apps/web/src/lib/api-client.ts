import {
  API_BASE_PATH,
  errorBodySchema,
  type ErrorCode,
  healthPaths,
  type LivenessResponse,
  livenessResponseSchema,
  type ReadinessResponse,
  readinessResponseSchema,
} from '@focus-flow/contracts';
import type { z } from 'zod';

// Every request is relative: the browser talks to its own origin and the Vite dev
// server (or the production reverse proxy) forwards `/api` to the API. No host is
// ever hard-coded here.

const SERVICE_UNAVAILABLE = 503;

/**
 * Transport-level failures the API cannot describe itself, plus the shared
 * contract codes the API does send.
 */
export type ApiErrorCode = ErrorCode | 'NETWORK' | 'MALFORMED_RESPONSE';

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  /** HTTP status, or 0 when the request never reached the server. */
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ApiErrorCode, status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function requestUrl(path: string): string {
  return `${API_BASE_PATH}${path}`;
}

async function sendRequest(path: string, init?: RequestInit): Promise<Response> {
  // A plain object spread (`{ headers: {...}, ...init }`) would silently replace the
  // whole headers object — and drop this default — the moment any caller adds its own
  // headers (an auth token, a CSRF header). `Headers` merges correctly regardless of
  // which of the three `HeadersInit` shapes the caller passed.
  const headers = new Headers(init?.headers);
  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json');
  }

  try {
    return await fetch(requestUrl(path), {
      ...init,
      headers,
      // The refresh cookie is scoped to the API's own path (modules/auth/cookies.ts)
      // and is always requested through the same-origin dev proxy (vite.config.ts) or
      // a same-origin deployment, so `same-origin` is the correct — not merely
      // permissive — setting, and never needs to widen to `include`.
      credentials: 'same-origin',
    });
  } catch (cause) {
    throw new ApiError('NETWORK', 0, 'The API could not be reached.', cause);
  }
}

/**
 * `undefined` for a genuinely empty body (every 204 the API sends, since `express`
 * never writes a body for `res.status(204).end()`) — never attempts `response.json()`
 * against an empty string, which would otherwise throw and be misreported as a
 * malformed response instead of a valid no-content success.
 */
async function readJsonBody(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch (cause) {
    throw new ApiError(
      'MALFORMED_RESPONSE',
      response.status,
      'The API response body could not be read.',
      cause,
    );
  }
  if (text.length === 0) {
    return undefined;
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (cause) {
    throw new ApiError(
      'MALFORMED_RESPONSE',
      response.status,
      'The API returned a body that is not valid JSON.',
      cause,
    );
  }
  return body;
}

/** Turns a non-OK response into an `ApiError`, preferring the server's own envelope. */
function toApiError(status: number, body: unknown): ApiError {
  const parsed = errorBodySchema.safeParse(body);
  if (parsed.success) {
    const { code, message, details } = parsed.data.error;
    return new ApiError(code, status, message, details);
  }
  return new ApiError(
    'INTERNAL',
    status,
    `The API returned an unexpected error (HTTP ${status}).`,
    body,
  );
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown, status: number): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ApiError(
      'MALFORMED_RESPONSE',
      status,
      'The API returned a response in an unexpected shape.',
      result.error.issues,
    );
  }
  return result.data;
}

/**
 * Typed `fetch` for the API: non-OK responses always throw, successful ones are
 * validated against the shared contract schema before they reach the caller.
 */
export async function apiRequest<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const response = await sendRequest(path, init);
  const body = await readJsonBody(response);

  if (!response.ok) {
    throw toApiError(response.status, body);
  }

  return parseBody(schema, body, response.status);
}

/**
 * For endpoints documented as returning no body on success (every `204`, e.g. logout —
 * docs/api/rest.md). Never attempts to validate a response schema against an empty
 * body; a non-OK response is still parsed and thrown as a normal `ApiError`.
 */
export async function apiRequestNoContent(path: string, init?: RequestInit): Promise<void> {
  const response = await sendRequest(path, init);

  if (!response.ok) {
    const body = await readJsonBody(response);
    throw toApiError(response.status, body);
  }
}

export function fetchLiveness(): Promise<LivenessResponse> {
  return apiRequest<LivenessResponse>(healthPaths.liveness, livenessResponseSchema);
}

/**
 * Readiness is the one endpoint where a non-OK status is a valid answer: the API
 * replies 503 with the same body shape while a dependency is down. Both 200 and
 * 503 are parsed as data; anything else is a real error.
 */
export async function fetchReadiness(): Promise<ReadinessResponse> {
  const response = await sendRequest(healthPaths.readiness);
  const body = await readJsonBody(response);

  if (response.ok || response.status === SERVICE_UNAVAILABLE) {
    return parseBody<ReadinessResponse>(readinessResponseSchema, body, response.status);
  }

  throw toApiError(response.status, body);
}
