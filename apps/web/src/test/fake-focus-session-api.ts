import {
  API_BASE_PATH,
  authPaths,
  calendarDatesFrom,
  focusSessionListResponseSchema,
  focusSessionPaths,
  focusSessionResponseSchema,
  focusSessionSummaryQuerySchema,
  focusSessionSummaryResponseSchema,
  mePaths,
  startFocusSessionRequestSchema,
} from '@focus-flow/contracts';

import {
  accessTokenExpiresAt,
  errorResponse,
  jsonResponse,
  noContentResponse,
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

export type FakeAction = 'start' | 'current' | 'pause' | 'resume' | 'stop';

/** What the fake needs to know about a task; the task fake's rows can be mapped onto it. */
export type FakeTaskLookup = (
  id: string,
) => { title: string; completed: boolean; deleted: boolean } | undefined;

export type Gate = { wait: Promise<void>; open: () => void };

/** Resolves `wait` once `open()` is called: holds a request in flight so a test sees it pending. */
export function createGate(): Gate {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** The local calendar date of an instant in `timeZone` (what the real summary does, V7). */
function localDate(instantMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(instantMs));
}

/** The second person of the sign-out → sign-in-as-someone-else tests. */
const OTHER_USER = { id: '9b2d7c1e-3a4f-4c5d-8e6f-0a1b2c3d4e5f', email: 'grace@example.com' };

type InProgress = FakeSession & { status: 'in_progress' };

/**
 * A small in-memory stand-in for the focus session routes (docs/api/rest.md "Focus
 * sessions"). Requests and responses are checked with the real contract schemas, and the
 * behaviour follows apps/api/src/modules/focus-sessions/service.ts: 201 on start,
 * `409 SESSION_IN_PROGRESS` with the existing session as `details`, `404 TASK_NOT_FOUND`,
 * `409 TASK_NOT_OPEN`, `409 NOT_CONNECTED`, and pause/resume/stop that answer `200` with
 * the session unchanged once it has ended (E11). Sessions are listed newest started first;
 * history, `current` and the (optionally derived) summary stay consistent with each other,
 * so a journey can be tested end to end.
 */
export function createFakeFocusSessionApi(
  options: {
    pageSize?: number;
    findTask?: FakeTaskLookup;
    now?: (() => number) | undefined;
  } = {},
) {
  const sessions: FakeSession[] = [];
  let summary: FakeSummary | undefined = emptySummary();
  let connected = true;
  const failures = new Map<FakeAction, Array<() => Response>>();
  const now = options.now ?? (() => Date.now());

  const inProgress = (): InProgress | undefined =>
    sessions.find((session): session is InProgress => session.status === 'in_progress');

  /** Checked with the real schema before it leaves, so a malformed fake fails loudly. */
  const sessionBody = (session: FakeSession) => focusSessionResponseSchema.parse({ session });

  /** Whole seconds of the running stretch, rounded down like the server (E14). */
  const stretchSeconds = (session: InProgress): number =>
    session.runningSince === null
      ? 0
      : Math.max(0, Math.floor((now() - Date.parse(session.runningSince)) / 1_000));

  function replace(session: FakeSession, next: FakeSession): FakeSession {
    sessions[sessions.indexOf(session)] = next;
    return next;
  }

  /** The session after it ended; the running stretch is folded into `focusedSeconds`. */
  function ended(
    session: InProgress,
    outcome:
      | { status: 'completed' }
      | { status: 'abandoned'; reason: 'stopped' | 'grace_expired' | 'expired' },
  ): FakeSession {
    const base = {
      id: session.id,
      context: session.context,
      task: session.task,
      plannedSeconds: session.plannedSeconds,
      startedAt: session.startedAt,
      endedAt: new Date(now()).toISOString(),
    };
    if (outcome.status === 'completed') {
      return replace(session, {
        ...base,
        focusedSeconds: session.plannedSeconds,
        status: 'completed',
      });
    }
    return replace(session, {
      ...base,
      focusedSeconds: Math.min(
        session.plannedSeconds,
        session.focusedSeconds + stretchSeconds(session),
      ),
      status: 'abandoned',
      abandonReason: outcome.reason,
    });
  }

  const consume = (action: FakeAction): Response | undefined => failures.get(action)?.shift()?.();

  function derivedSummary(from: string, to: string, tz: string): FakeSummary {
    const days = new Map(
      calendarDatesFrom(from, to).map((date) => [
        date,
        { date, completedFocusedSeconds: 0, totalFocusedSeconds: 0 },
      ]),
    );
    let completedCount = 0;
    for (const session of sessions) {
      if (session.status === 'in_progress') {
        continue; // V6: ended sessions only.
      }
      const day = days.get(localDate(Date.parse(session.startedAt), tz));
      if (day === undefined) {
        continue;
      }
      day.totalFocusedSeconds += session.focusedSeconds;
      if (session.status === 'completed') {
        completedCount += 1;
        day.completedFocusedSeconds += session.focusedSeconds;
      }
    }
    const list = [...days.values()];
    const sum = (pick: (day: FakeSummaryDay) => number) =>
      list.reduce((total, day) => total + pick(day), 0);
    return {
      completedCount,
      completedFocusedSeconds: sum((day) => day.completedFocusedSeconds),
      totalFocusedSeconds: sum((day) => day.totalFocusedSeconds),
      days: list,
    };
  }

  const notConnected = () =>
    errorResponse(409, 'NOT_CONNECTED', 'Focus Flow must be open and connected.');

  function start(request: RecordedRequest): Response {
    const parsed = startFocusSessionRequestSchema.safeParse(
      request.body === null ? undefined : JSON.parse(request.body),
    );
    if (!parsed.success) {
      return errorResponse(400, 'VALIDATION_FAILED', parsed.error.message);
    }
    if (!connected) {
      return notConnected();
    }
    let task: FakeSession['task'] = null;
    if (parsed.data.taskId !== undefined) {
      const found = options.findTask?.(parsed.data.taskId);
      if (found === undefined || found.deleted) {
        return errorResponse(404, 'TASK_NOT_FOUND', 'Task not found.');
      }
      if (found.completed) {
        return errorResponse(409, 'TASK_NOT_OPEN', 'Only an open task can be focused on.');
      }
      task = { id: parsed.data.taskId, title: found.title, deleted: false };
    }
    const existing = inProgress();
    if (existing !== undefined) {
      return jsonResponse(409, {
        error: {
          code: 'SESSION_IN_PROGRESS',
          message: 'A focus session is already in progress.',
          details: sessionBody(existing),
        },
      });
    }
    const startedAt = new Date(now()).toISOString();
    const session: FakeSession = {
      id: crypto.randomUUID(),
      context: { kind: 'solo' },
      task,
      plannedSeconds: parsed.data.plannedSeconds,
      focusedSeconds: 0,
      startedAt,
      status: 'in_progress',
      runningSince: startedAt,
    };
    sessions.unshift(session);
    return jsonResponse(201, sessionBody(session));
  }

  function transition(action: 'pause' | 'resume' | 'stop', sessionId: string): Response {
    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (session === undefined) {
      return errorResponse(404, 'NOT_FOUND', 'Focus session not found.');
    }
    if (session.status !== 'in_progress') {
      return jsonResponse(200, sessionBody(session)); // E11: an ended session is unchanged.
    }
    if (action === 'stop') {
      return jsonResponse(
        200,
        sessionBody(ended(session, { status: 'abandoned', reason: 'stopped' })),
      );
    }
    if (action === 'pause' && session.runningSince !== null) {
      session.focusedSeconds += stretchSeconds(session);
      session.runningSince = null;
    }
    if (action === 'resume' && session.runningSince === null) {
      if (!connected) {
        return notConnected();
      }
      session.runningSince = new Date(now()).toISOString();
    }
    return jsonResponse(200, sessionBody(session));
  }

  function handle(request: RecordedRequest): Response {
    const url = new URL(request.url, 'http://localhost');
    const path = url.pathname.slice(API_BASE_PATH.length);
    const [root, sessionId, action] = path.split('/').filter((segment) => segment.length > 0);

    if (path === authPaths.refresh) {
      return jsonResponse(200, refreshBody('fake-token'));
    }
    if (path === authPaths.logout) {
      return noContentResponse();
    }
    if (path === authPaths.login) {
      // A different person signing in on the same tab.
      return jsonResponse(200, {
        user: { ...userBody, ...OTHER_USER },
        accessToken: 'other-token',
        accessTokenExpiresAt,
      });
    }
    if (path === mePaths.self) {
      return jsonResponse(200, { user: userBody });
    }
    if (path === focusSessionPaths.summary && request.method === 'GET') {
      if (summary !== undefined) {
        return jsonResponse(200, summary);
      }
      const query = focusSessionSummaryQuerySchema.parse(Object.fromEntries(url.searchParams));
      return jsonResponse(
        200,
        focusSessionSummaryResponseSchema.parse(derivedSummary(query.from, query.to, query.tz)),
      );
    }
    if (path === focusSessionPaths.collection && request.method === 'GET') {
      const limit = Number(url.searchParams.get('limit') ?? options.pageSize ?? 50);
      const cursor = url.searchParams.get('cursor');
      const first =
        cursor === null ? 0 : sessions.findIndex((session) => `c-${session.id}` === cursor) + 1;
      const page = sessions.slice(first, first + limit);
      const more = first + limit < sessions.length;
      const last = page.at(-1);
      return jsonResponse(
        200,
        focusSessionListResponseSchema.parse({
          sessions: page,
          nextCursor: more && last !== undefined ? `c-${last.id}` : null,
        }),
      );
    }
    if (path === focusSessionPaths.collection && request.method === 'POST') {
      return consume('start') ?? start(request);
    }
    if (path === focusSessionPaths.current && request.method === 'GET') {
      const current = inProgress();
      return (
        consume('current') ??
        jsonResponse(200, { session: current === undefined ? null : sessionBody(current).session })
      );
    }
    if (
      root === 'focus-sessions' &&
      sessionId !== undefined &&
      (action === 'pause' || action === 'resume' || action === 'stop') &&
      request.method === 'POST'
    ) {
      return consume(action) ?? transition(action, sessionId);
    }
    return errorResponse(404, 'NOT_FOUND', `Unhandled fake route ${request.method} ${path}`);
  }

  /** The server ending the in-progress session on its own, as the worker would (E6). */
  function endCurrent(
    outcome: { status: 'completed' } | { status: 'abandoned'; reason: 'grace_expired' | 'expired' },
  ): FakeSession {
    const session = inProgress();
    if (session === undefined) {
      throw new Error('No in-progress session to end.');
    }
    return ended(session, outcome);
  }

  return {
    handle,
    sessions,
    /** A fixed summary; `deriveSummary()` computes it from `sessions` instead. */
    setSummary: (next: FakeSummary) => {
      summary = next;
    },
    deriveSummary: () => {
      summary = undefined;
    },
    /** Whether the user has a connected socket: gates start and resume (H2, E21). */
    setConnected: (value: boolean) => {
      connected = value;
    },
    /** Replaces the next answer to `action` once (a 503, a 409, a malformed body…). */
    failNext: (action: FakeAction, response: () => Response) => {
      failures.set(action, [...(failures.get(action) ?? []), response]);
    },
    completeCurrent: () => endCurrent({ status: 'completed' }),
    abandonCurrent: (reason: 'grace_expired' | 'expired') =>
      endCurrent({ status: 'abandoned', reason }),
    current: inProgress,
  };
}
