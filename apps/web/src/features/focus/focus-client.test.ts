import { focusSessionIdSchema, taskIdSchema } from '@focus-flow/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api-client';
import { errorResponse, jsonResponse, stubFetch } from '../../test/api-stub';
import { fakeSession } from '../../test/fake-focus-session-api';
import { resetPendingRefresh } from '../auth/auth-client';
import { clearAccessToken, setAccessToken } from '../auth/token-store';
import {
  getCurrentFocusSession,
  pauseFocusSession,
  resumeFocusSession,
  sessionInProgressFrom,
  startFocusSession,
  stopFocusSession,
} from './focus-client';

const SESSION_ID = focusSessionIdSchema.parse('01a0ed0d-55de-7d1b-8495-82fb5050d815');
const TASK_ID = taskIdSchema.parse('01a0ed0d-55de-7d1b-8495-82fb5050d816');
const running = () =>
  fakeSession({
    id: SESSION_ID,
    status: 'in_progress',
    focusedSeconds: 0,
    runningSince: '2026-03-09T10:00:00.000Z',
  });

beforeEach(() => {
  // A token in memory, so no request triggers the refresh-then-replay path.
  setAccessToken('access-token');
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearAccessToken();
  resetPendingRefresh();
});

describe('focus client', () => {
  it('starts a session with exactly the JSON body it was given and a bearer token', async () => {
    const calls = stubFetch(() => jsonResponse(201, { session: running() }));

    const session = await startFocusSession({ plannedSeconds: 1_500, taskId: TASK_ID });

    expect(session.id).toBe(SESSION_ID);
    expect(calls[0]?.url).toBe('/api/v1/focus-sessions');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers.get('Content-Type')).toBe('application/json');
    expect(calls[0]?.headers.get('Authorization')).toBe('Bearer access-token');
    expect(JSON.parse(calls[0]?.body ?? 'null')).toEqual({
      plannedSeconds: 1_500,
      taskId: TASK_ID,
    });
  });

  it('leaves taskId out of the body when there is none', async () => {
    const calls = stubFetch(() => jsonResponse(201, { session: running() }));

    await startFocusSession({ plannedSeconds: 900 });

    expect(calls[0]?.body).toBe('{"plannedSeconds":900}');
  });

  it('reads the current session, which may be null', async () => {
    stubFetch(() => jsonResponse(200, { session: null }));
    expect(await getCurrentFocusSession()).toBeNull();

    const calls = stubFetch(() => jsonResponse(200, { session: running() }));
    expect((await getCurrentFocusSession())?.status).toBe('in_progress');
    expect(calls[0]?.url).toBe('/api/v1/focus-sessions/current');
    expect(calls[0]?.method).toBe('GET');
  });

  it.each([
    ['pause', pauseFocusSession],
    ['resume', resumeFocusSession],
    ['stop', stopFocusSession],
  ] as const)('%s posts to the session path with no body', async (action, call) => {
    const calls = stubFetch(() => jsonResponse(200, { session: running() }));

    await call(SESSION_ID);

    expect(calls[0]?.url).toBe(`/api/v1/focus-sessions/${SESSION_ID}/${action}`);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toBeNull();
  });

  it('rejects a response that breaks the contract', async () => {
    stubFetch(() => jsonResponse(200, { session: { id: 'not-a-uuid', status: 'in_progress' } }));

    await expect(pauseFocusSession(SESSION_ID)).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
    });
  });

  it('surfaces API errors with their code and status', async () => {
    stubFetch(() => errorResponse(409, 'NOT_CONNECTED', 'Not connected.'));

    await expect(resumeFocusSession(SESSION_ID)).rejects.toMatchObject({
      code: 'NOT_CONNECTED',
      status: 409,
    });
  });

  describe('sessionInProgressFrom', () => {
    it('returns the existing session carried by SESSION_IN_PROGRESS', async () => {
      stubFetch(() =>
        jsonResponse(409, {
          error: {
            code: 'SESSION_IN_PROGRESS',
            message: 'Already.',
            details: { session: running() },
          },
        }),
      );

      const error = await startFocusSession({ plannedSeconds: 900 }).catch(
        (cause: unknown) => cause,
      );

      expect(sessionInProgressFrom(error)?.id).toBe(SESSION_ID);
    });

    it('returns null for other codes, bad details and non-API errors', () => {
      expect(sessionInProgressFrom(new ApiError('NOT_CONNECTED', 409, 'x'))).toBeNull();
      expect(
        sessionInProgressFrom(new ApiError('SESSION_IN_PROGRESS', 409, 'x', { session: 'nope' })),
      ).toBeNull();
      expect(sessionInProgressFrom(new ApiError('SESSION_IN_PROGRESS', 409, 'x'))).toBeNull();
      expect(sessionInProgressFrom(new Error('boom'))).toBeNull();
    });
  });
});
