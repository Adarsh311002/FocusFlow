import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api-client';
import { errorResponse, jsonResponse, stubFetch } from '../../test/api-stub';
import { fakeSession } from '../../test/fake-focus-session-api';
import { resetPendingRefresh } from '../auth/auth-client';
import { clearAccessToken, setAccessToken } from '../auth/token-store';
import { getFocusSessionSummary, listFocusSessions } from './review-client';
import type { ReviewRange } from './review-range';

const RANGE: ReviewRange = { from: '2026-03-02', to: '2026-03-08', tz: 'America/Los_Angeles' };

const summaryBody = {
  completedCount: 1,
  completedFocusedSeconds: 1_500,
  totalFocusedSeconds: 1_500,
  days: [{ date: '2026-03-08', completedFocusedSeconds: 1_500, totalFocusedSeconds: 1_500 }],
};

beforeEach(() => {
  // A token in memory, so no request triggers the refresh-then-replay path.
  setAccessToken('access-token');
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearAccessToken();
  resetPendingRefresh();
});

describe('review client', () => {
  it('asks for the first history page with no query and a bearer token', async () => {
    const session = fakeSession();
    const calls = stubFetch(() => jsonResponse(200, { sessions: [session], nextCursor: null }));

    const page = await listFocusSessions();

    expect(page.sessions[0]?.id).toBe(session.id);
    expect(page.nextCursor).toBeNull();
    expect(calls[0]?.url).toBe('/api/v1/focus-sessions');
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.headers.get('Authorization')).toBe('Bearer access-token');
  });

  it('leaves out parameters that were passed as undefined', async () => {
    const calls = stubFetch(() => jsonResponse(200, { sessions: [], nextCursor: null }));

    await listFocusSessions({ cursor: undefined, limit: undefined });

    expect(calls[0]?.url).toBe('/api/v1/focus-sessions');
  });

  it('sends the cursor and the limit in the query', async () => {
    const calls = stubFetch(() => jsonResponse(200, { sessions: [], nextCursor: null }));

    await listFocusSessions({ cursor: 'c-01a0ed0d', limit: 25 });

    expect(calls[0]?.url).toBe('/api/v1/focus-sessions?cursor=c-01a0ed0d&limit=25');
  });

  it('asks for the summary with both dates and the time zone, encoded', async () => {
    const calls = stubFetch(() => jsonResponse(200, summaryBody));

    const summary = await getFocusSessionSummary(RANGE);

    expect(summary.days).toHaveLength(1);
    expect(summary.completedCount).toBe(1);
    expect(calls[0]?.url).toBe(
      '/api/v1/focus-sessions/summary?from=2026-03-02&to=2026-03-08&tz=America%2FLos_Angeles',
    );
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.headers.get('Authorization')).toBe('Bearer access-token');
  });

  it('rejects a history page that does not match the contract', async () => {
    // A completed session with no `endedAt`: the discriminated union forbids it.
    stubFetch(() =>
      jsonResponse(200, {
        sessions: [{ ...fakeSession(), endedAt: undefined }],
        nextCursor: null,
      }),
    );

    await expect(listFocusSessions()).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
      status: 200,
    });
  });

  it('rejects a summary whose day is not a calendar date', async () => {
    stubFetch(() =>
      jsonResponse(200, {
        ...summaryBody,
        days: [{ date: '08/03/2026', completedFocusedSeconds: 0, totalFocusedSeconds: 0 }],
      }),
    );

    await expect(getFocusSessionSummary(RANGE)).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
    });
  });

  it('rejects a summary with a fractional number of seconds', async () => {
    stubFetch(() => jsonResponse(200, { ...summaryBody, totalFocusedSeconds: 1_500.5 }));

    await expect(getFocusSessionSummary(RANGE)).rejects.toBeInstanceOf(ApiError);
  });

  it('surfaces a rejected query as a typed error', async () => {
    stubFetch(() => errorResponse(400, 'VALIDATION_FAILED', '`tz` must be an IANA time zone.'));

    await expect(getFocusSessionSummary(RANGE)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 400,
    });
  });
});
