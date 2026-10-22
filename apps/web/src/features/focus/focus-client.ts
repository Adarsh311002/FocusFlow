import {
  currentFocusSessionResponseSchema,
  type FocusSessionId,
  focusSessionPath,
  focusSessionPaths,
  type FocusSessionResponse,
  focusSessionResponseSchema,
  type FocusSessionView,
  sessionInProgressDetailsSchema,
  type StartFocusSessionRequest,
} from '@focus-flow/contracts';

import { ApiError } from '../../lib/api-client';
import { authedApiRequest } from '../auth/auth-client';

// Typed calls for the solo focus routes (docs/api/rest.md "Focus sessions"). Every response
// is validated against the shared contract before it reaches a component.

async function sessionRequest(path: string, init: RequestInit): Promise<FocusSessionView> {
  const body = await authedApiRequest<FocusSessionResponse>(path, focusSessionResponseSchema, init);
  return body.session;
}

/** `POST /focus-sessions` (201). */
export function startFocusSession(request: StartFocusSessionRequest): Promise<FocusSessionView> {
  return sessionRequest(focusSessionPaths.collection, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
}

/** `GET /focus-sessions/current`: the in-progress session, or `null`. */
export async function getCurrentFocusSession(): Promise<FocusSessionView | null> {
  const body = await authedApiRequest(focusSessionPaths.current, currentFocusSessionResponseSchema);
  return body.session;
}

export function pauseFocusSession(id: FocusSessionId): Promise<FocusSessionView> {
  return sessionRequest(focusSessionPath(focusSessionPaths.pause, id), { method: 'POST' });
}

export function resumeFocusSession(id: FocusSessionId): Promise<FocusSessionView> {
  return sessionRequest(focusSessionPath(focusSessionPaths.resume, id), { method: 'POST' });
}

export function stopFocusSession(id: FocusSessionId): Promise<FocusSessionView> {
  return sessionRequest(focusSessionPath(focusSessionPaths.stop, id), { method: 'POST' });
}

/**
 * The existing session carried by a `409 SESSION_IN_PROGRESS`, or `null` for any other
 * error (or details that do not match the contract).
 */
export function sessionInProgressFrom(error: unknown): FocusSessionView | null {
  if (!(error instanceof ApiError) || error.code !== 'SESSION_IN_PROGRESS') {
    return null;
  }
  const parsed = sessionInProgressDetailsSchema.safeParse(error.details);
  return parsed.success ? parsed.data.session : null;
}
