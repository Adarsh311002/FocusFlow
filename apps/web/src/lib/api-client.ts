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
  try {
    return await fetch(requestUrl(path), {
      headers: { Accept: 'application/json' },
      ...init,
      // Cookie-based sessions arrive in a later phase; same-origin is the safe default.
      credentials: 'same-origin',
    });
  } catch (cause) {
    throw new ApiError('NETWORK', 0, 'The API could not be reached.', cause);
  }
}

async function readJsonBody(response: Response): Promise<unknown> {
  let body: unknown;
  try {
    body = await response.json();
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
