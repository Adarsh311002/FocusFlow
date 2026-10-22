import { API_BASE_PATH, authPaths, focusSessionPaths, mePaths } from '@focus-flow/contracts';

import {
  errorResponse,
  jsonResponse,
  type RecordedRequest,
  refreshBody,
  userBody,
} from './api-stub';

/** A session body as the API sends it (unbranded; the client's schemas brand it). */
export type FakeSession = {
  id: string;
  context: { kind: 'solo' };
  task: { id: string; title: string; deleted: boolean } | null;
  plannedSeconds: number;
  focusedSeconds: number;
  startedAt: string;
} & (
  | { status: 'in_progress'; runningSince: string | null }
  | { status: 'completed'; endedAt: string }
  | { status: 'abandoned'; endedAt: string; abandonReason: 'stopped' | 'grace_expired' | 'expired' }
);

export type FakeSummaryDay = {
  date: string;
  completedFocusedSeconds: number;
  totalFocusedSeconds: number;
};

export type FakeSummary = {
  completedCount: number;
  completedFocusedSeconds: number;
  totalFocusedSeconds: number;
  days: FakeSummaryDay[];
};

let sequence = 0;

/** A completed 25-minute session by default; `overrides` shape the rest. */
export function fakeSession(overrides: Partial<FakeSession> = {}): FakeSession {
  sequence += 1;
  const base = {
    id: crypto.randomUUID(),
    context: { kind: 'solo' as const },
    task: { id: crypto.randomUUID(), title: `Task ${String(sequence)}`, deleted: false },
    plannedSeconds: 1_500,
    focusedSeconds: 1_500,
    startedAt: '2026-03-09T10:00:00.000Z',
    status: 'completed' as const,
    endedAt: '2026-03-09T10:25:00.000Z',
  };
  const session = { ...base, ...overrides } as FakeSession;
  if (session.status === 'in_progress') {
    // An in-progress session has no end yet; drop the default's.
    Reflect.deleteProperty(session, 'endedAt');
  }
  return session;
}

export const emptySummary = (days: readonly string[] = []): FakeSummary => ({
  completedCount: 0,
  completedFocusedSeconds: 0,
  totalFocusedSeconds: 0,
  days: days.map((date) => ({ date, completedFocusedSeconds: 0, totalFocusedSeconds: 0 })),
});

/**
 * A small in-memory stand-in for the review routes (docs/api/rest.md "Focus sessions"):
 * sessions are listed in the order given (newest started first), paged by an opaque
 * cursor; the summary answers whatever the test set.
 */
export function createFakeFocusSessionApi(options: { pageSize?: number } = {}) {
  const sessions: FakeSession[] = [];
  let summary: FakeSummary = emptySummary();

  function handle(request: RecordedRequest): Response {
    const url = new URL(request.url, 'http://localhost');
    const path = url.pathname.slice(API_BASE_PATH.length);

    if (path === authPaths.refresh) {
      return jsonResponse(200, refreshBody('fake-token'));
    }
    if (path === mePaths.self) {
      return jsonResponse(200, { user: userBody });
    }
    if (path === focusSessionPaths.summary && request.method === 'GET') {
      return jsonResponse(200, summary);
    }
    if (path === focusSessionPaths.collection && request.method === 'GET') {
      const limit = Number(url.searchParams.get('limit') ?? options.pageSize ?? 50);
      const cursor = url.searchParams.get('cursor');
      const start =
        cursor === null ? 0 : sessions.findIndex((session) => `c-${session.id}` === cursor) + 1;
      const page = sessions.slice(start, start + limit);
      const more = start + limit < sessions.length;
      const last = page.at(-1);
      return jsonResponse(200, {
        sessions: page,
        nextCursor: more && last !== undefined ? `c-${last.id}` : null,
      });
    }
    return errorResponse(404, 'NOT_FOUND', `Unhandled fake route ${request.method} ${path}`);
  }

  return {
    handle,
    sessions,
    setSummary: (next: FakeSummary) => {
      summary = next;
    },
  };
}
