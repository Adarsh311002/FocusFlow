import {
  authPaths,
  type AuthResponse,
  authResponseSchema,
  CLIENT_HEADER_NAME,
  type LoginRequest,
  mePaths,
  type MeResponse,
  meResponseSchema,
  type RefreshResponse,
  refreshResponseSchema,
  type SignupRequest,
  type UserView,
} from '@focus-flow/contracts';
import { type z } from 'zod';

import { ApiError, apiRequest, apiRequestNoContent } from '../../lib/api-client';
import { clearAccessToken, getAccessToken, setAccessToken } from './token-store';

const UNAUTHORIZED = 401;

type HeaderRecord = Record<string, string>;

/**
 * Any non-empty value satisfies the API: the header's presence is the CSRF signal (a
 * cross-site form post cannot set a custom header), not its contents.
 */
const CLIENT_HEADER_VALUE = 'web';

const JSON_HEADERS: HeaderRecord = { 'Content-Type': 'application/json' };
const CLIENT_HEADERS: HeaderRecord = { [CLIENT_HEADER_NAME]: CLIENT_HEADER_VALUE };

/** Merges auth-specific headers (a bearer token, the CSRF client header) onto a request. */
function withHeaders(init: RequestInit | undefined, extra: HeaderRecord): RequestInit {
  const headers = new Headers(init?.headers);
  for (const [name, value] of Object.entries(extra)) {
    headers.set(name, value);
  }
  return { ...init, headers };
}

function jsonPost(body: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(body) };
}

/** The codes that all mean the same thing to the client: there is no usable session. */
const sessionEndedCodes = ['UNAUTHENTICATED', 'SESSION_INVALID', 'SESSION_REVOKED'] as const;
export type SessionEndedCode = (typeof sessionEndedCodes)[number];

function sessionEndedReason(error: unknown): SessionEndedCode | null {
  if (!(error instanceof ApiError)) {
    return null;
  }
  return sessionEndedCodes.find((code) => code === error.code) ?? null;
}

function sessionEndedError(reason: SessionEndedCode): ApiError {
  const message =
    reason === 'SESSION_REVOKED'
      ? 'You were signed out. Please sign in again.'
      : 'Your session has ended. Please sign in again.';
  return new ApiError(reason, UNAUTHORIZED, message);
}

type SessionEndedListener = (reason: SessionEndedCode) => void;
const sessionEndedListeners = new Set<SessionEndedListener>();

/**
 * Lets `auth-context.tsx` learn about a session ending even when it happens away from
 * any component that called `login`/`signup` — for example a background query that
 * discovers mid-session that the refresh cookie no longer names a live session.
 * Without this, React state would keep showing `'authenticated'` with a stale user
 * until something else happened to re-render.
 */
export function onSessionEnded(listener: SessionEndedListener): () => void {
  sessionEndedListeners.add(listener);
  return () => sessionEndedListeners.delete(listener);
}

/**
 * Ends the session everywhere in the app (for example when a socket handshake is refused
 * with SESSION_REVOKED): listeners (the AuthProvider) sign the UI out and clear caches.
 */
export function notifySessionEnded(reason: SessionEndedCode): void {
  for (const listener of sessionEndedListeners) {
    listener(reason);
  }
}

export function signup(input: SignupRequest): Promise<AuthResponse> {
  return apiRequest<AuthResponse>(
    authPaths.signup,
    authResponseSchema,
    withHeaders(jsonPost(input), JSON_HEADERS),
  );
}

export function login(input: LoginRequest): Promise<AuthResponse> {
  return apiRequest<AuthResponse>(
    authPaths.login,
    authResponseSchema,
    withHeaders(jsonPost(input), JSON_HEADERS),
  );
}

/**
 * What `POST /auth/refresh` means to the caller. A 401 is not a failure here: for a
 * first-time visitor it is the expected answer, and the app must not treat it as a
 * crash. Anything else (a 500, a network outage) still rejects.
 */
export type RefreshOutcome =
  | { readonly status: 'refreshed'; readonly accessToken: string }
  | { readonly status: 'no-session'; readonly reason: SessionEndedCode };

async function requestRefresh(): Promise<RefreshOutcome> {
  try {
    // No request body: the httpOnly cookie the browser attaches is the credential.
    const body = await apiRequest<RefreshResponse>(
      authPaths.refresh,
      refreshResponseSchema,
      withHeaders({ method: 'POST' }, CLIENT_HEADERS),
    );
    return { status: 'refreshed', accessToken: body.accessToken };
  } catch (error) {
    const reason = sessionEndedReason(error);
    if (reason === null) {
      throw error;
    }
    return { status: 'no-session', reason };
  }
}

/**
 * Single-flight: refresh rotates the cookie server-side, so two concurrent calls would
 * make the second one look like token reuse and revoke the whole session. Every caller
 * that arrives while a refresh is in flight awaits the same promise.
 */
let pendingRefresh: Promise<RefreshOutcome> | null = null;

export function refresh(): Promise<RefreshOutcome> {
  pendingRefresh ??= requestRefresh()
    .then((outcome) => {
      setAccessToken(outcome.status === 'refreshed' ? outcome.accessToken : null);
      return outcome;
    })
    .finally(() => {
      pendingRefresh = null;
    });
  return pendingRefresh;
}

/** Test seam: resets the module state a browser would drop on reload. */
export function resetPendingRefresh(): void {
  pendingRefresh = null;
}

/**
 * Idempotent server-side (always 204, even when no session exists), so the only job
 * left here is to drop the in-memory token — which happens even if the call fails, so
 * the UI can never be stuck looking signed in.
 */
export async function logout(): Promise<void> {
  try {
    await apiRequestNoContent(authPaths.logout, withHeaders({ method: 'POST' }, CLIENT_HEADERS));
  } finally {
    clearAccessToken();
  }
}

function sendAuthed<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const token = getAccessToken();
  const authorization: HeaderRecord = token === null ? {} : { Authorization: `Bearer ${token}` };
  return apiRequest<T>(path, schema, withHeaders(init, authorization));
}

function sendAuthedNoContent(path: string, init?: RequestInit): Promise<void> {
  const token = getAccessToken();
  const authorization: HeaderRecord = token === null ? {} : { Authorization: `Bearer ${token}` };
  return apiRequestNoContent(path, withHeaders(init, authorization));
}

/**
 * `apiRequest` for endpoints behind `Authorization: Bearer`. Attaches the in-memory
 * token, and on a 401 `UNAUTHENTICATED` refreshes once and replays the request exactly
 * once — never in a loop. If the refresh itself finds no session, the in-memory token
 * is dropped and the caller sees a session-ended `ApiError`.
 */
export function authedApiRequest<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  return withSessionRetry(() => sendAuthed(path, schema, init));
}

/** `authedApiRequest` for endpoints that answer `204` with no body (e.g. deleting a task). */
export function authedApiRequestNoContent(path: string, init?: RequestInit): Promise<void> {
  return withSessionRetry(() => sendAuthedNoContent(path, init));
}

/**
 * The shared session handling of both authenticated request helpers. `attempt` reads the
 * in-memory token each time it runs, so the replay after a refresh uses the new token.
 */
async function withSessionRetry<T>(attempt: () => Promise<T>): Promise<T> {
  if (getAccessToken() === null) {
    // Nothing cached (a fresh page load): establish a token before the first attempt.
    const outcome = await refresh();
    if (outcome.status === 'no-session') {
      throw sessionEndedError(outcome.reason);
    }
  }

  try {
    return await attempt();
  } catch (error) {
    if (!(error instanceof ApiError)) {
      throw error;
    }
    if (error.code === 'SESSION_REVOKED') {
      // Revoked is terminal: refreshing would only be told the same thing.
      clearAccessToken();
      notifySessionEnded('SESSION_REVOKED');
      throw error;
    }
    if (error.code !== 'UNAUTHENTICATED') {
      throw error;
    }

    const outcome = await refresh();
    if (outcome.status === 'no-session') {
      notifySessionEnded(outcome.reason);
      throw sessionEndedError(outcome.reason);
    }
    return await attempt();
  }
}

export async function fetchMe(): Promise<UserView> {
  const body = await authedApiRequest<MeResponse>(mePaths.self, meResponseSchema);
  return body.user;
}

/**
 * The one way to answer "is this browser signed in?" after a reload: the access token
 * is gone, so the refresh cookie is asked. A logged-out visitor is the normal case, so
 * every API-level failure resolves to `null` instead of rejecting — landing on the sign-in
 * page is the right outcome for both "never signed in" and "the API is having a bad day".
 */
export async function restoreSession(): Promise<UserView | null> {
  try {
    const outcome = await refresh();
    if (outcome.status === 'no-session') {
      return null;
    }
    return await fetchMe();
  } catch (error) {
    if (error instanceof ApiError) {
      clearAccessToken();
      return null;
    }
    throw error;
  }
}
