import { describe, expect, it } from 'vitest';

import { errorCodeSchema } from '../errors';
import { focusSessionIdSchema } from '../ids';
import {
  abandonReasonSchema,
  currentFocusSessionResponseSchema,
  FOCUS_SESSION_LIST_DEFAULT_LIMIT,
  FOCUS_SESSION_LIST_MAX_LIMIT,
  FOCUS_SESSION_PLANNED_SECONDS_MAX,
  FOCUS_SESSION_PLANNED_SECONDS_MIN,
  FOCUS_SESSION_SUMMARY_MAX_DAYS,
  focusSessionParamsSchema,
  focusSessionStatusSchema,
  focusSessionSummaryQuerySchema,
  focusSessionSummaryResponseSchema,
  focusSessionViewSchema,
  listFocusSessionsQuerySchema,
  sessionInProgressDetailsSchema,
  startFocusSessionRequestSchema,
} from './focus-sessions';
import { focusSessionPath, focusSessionPaths } from './paths';

const SESSION_ID = '01a0ed0d-55de-7d1b-8495-82fb5050d815';
const TASK_ID = '01a0ed0d-55de-7d1b-8495-82fb5050d816';
const AT = '2026-10-07T10:00:00.000Z';
const LATER = '2026-10-07T10:25:00.000Z';

const base = {
  id: SESSION_ID,
  context: { kind: 'solo' },
  task: null,
  plannedSeconds: 1_500,
  focusedSeconds: 0,
  startedAt: AT,
};

describe('startFocusSessionRequestSchema', () => {
  it('accepts the planned-duration bounds exactly (E1)', () => {
    for (const plannedSeconds of [
      FOCUS_SESSION_PLANNED_SECONDS_MIN,
      FOCUS_SESSION_PLANNED_SECONDS_MAX,
    ]) {
      expect(startFocusSessionRequestSchema.safeParse({ plannedSeconds }).success).toBe(true);
    }
    expect(FOCUS_SESSION_PLANNED_SECONDS_MIN).toBe(60);
    expect(FOCUS_SESSION_PLANNED_SECONDS_MAX).toBe(14_400);
  });

  it.each([59, 14_401, 0, -60, 90.5, Number.NaN, '1500', null])(
    'rejects the planned duration %j',
    (plannedSeconds) => {
      expect(startFocusSessionRequestSchema.safeParse({ plannedSeconds }).success).toBe(false);
    },
  );

  it('takes an optional task id and never requires one (E3)', () => {
    expect(startFocusSessionRequestSchema.parse({ plannedSeconds: 1_500 })).toEqual({
      plannedSeconds: 1_500,
    });
    expect(
      startFocusSessionRequestSchema.parse({ plannedSeconds: 1_500, taskId: TASK_ID }),
    ).toEqual({ plannedSeconds: 1_500, taskId: TASK_ID });
    expect(
      startFocusSessionRequestSchema.safeParse({ plannedSeconds: 1_500, taskId: 'nope' }).success,
    ).toBe(false);
    expect(
      startFocusSessionRequestSchema.safeParse({ plannedSeconds: 1_500, taskId: null }).success,
    ).toBe(false);
  });

  it('rejects unknown keys such as a client-supplied userId or status', () => {
    expect(
      startFocusSessionRequestSchema.safeParse({ plannedSeconds: 1_500, userId: TASK_ID }).success,
    ).toBe(false);
    expect(
      startFocusSessionRequestSchema.safeParse({ plannedSeconds: 1_500, status: 'completed' })
        .success,
    ).toBe(false);
  });
});

describe('statuses and abandon reasons', () => {
  it('has exactly the three statuses', () => {
    expect(focusSessionStatusSchema.options).toEqual(['in_progress', 'completed', 'abandoned']);
  });

  it('has only the Phase 4B solo abandon reasons (E5)', () => {
    expect(abandonReasonSchema.options).toEqual(['stopped', 'grace_expired', 'expired']);
    for (const roomReason of [
      'opted_out',
      'left_room',
      'removed',
      'reset',
      'phase_changed',
      'timer_lost',
    ]) {
      expect(abandonReasonSchema.safeParse(roomReason).success).toBe(false);
    }
  });
});

describe('focusSessionViewSchema', () => {
  it('accepts a running, a paused, a completed and an abandoned session', () => {
    expect(
      focusSessionViewSchema.safeParse({ ...base, status: 'in_progress', runningSince: AT })
        .success,
    ).toBe(true);
    expect(
      focusSessionViewSchema.safeParse({
        ...base,
        status: 'in_progress',
        runningSince: null,
        focusedSeconds: 300,
      }).success,
    ).toBe(true);
    expect(
      focusSessionViewSchema.safeParse({
        ...base,
        status: 'completed',
        focusedSeconds: 1_500,
        endedAt: LATER,
      }).success,
    ).toBe(true);
    expect(
      focusSessionViewSchema.safeParse({
        ...base,
        status: 'abandoned',
        endedAt: LATER,
        abandonReason: 'grace_expired',
        task: { id: TASK_ID, title: 'Write report', deleted: true },
      }).success,
    ).toBe(true);
  });

  it('cannot represent an abandoned session without a reason', () => {
    expect(
      focusSessionViewSchema.safeParse({ ...base, status: 'abandoned', endedAt: LATER }).success,
    ).toBe(false);
  });

  it('cannot represent a finished session without an end time', () => {
    expect(focusSessionViewSchema.safeParse({ ...base, status: 'completed' }).success).toBe(false);
  });

  it('rejects room contexts and room-only reasons in Phase 4B', () => {
    expect(
      focusSessionViewSchema.safeParse({
        ...base,
        context: { kind: 'room', roomId: SESSION_ID },
        status: 'in_progress',
        runningSince: AT,
      }).success,
    ).toBe(false);
    expect(
      focusSessionViewSchema.safeParse({
        ...base,
        status: 'abandoned',
        endedAt: LATER,
        abandonReason: 'timer_lost',
      }).success,
    ).toBe(false);
  });

  it('rejects negative or fractional focused seconds', () => {
    for (const focusedSeconds of [-1, 1.5]) {
      expect(
        focusSessionViewSchema.safeParse({
          ...base,
          focusedSeconds,
          status: 'in_progress',
          runningSince: null,
        }).success,
      ).toBe(false);
    }
  });
});

describe('responses and errors', () => {
  it('allows no current session', () => {
    expect(currentFocusSessionResponseSchema.parse({ session: null })).toEqual({ session: null });
  });

  it('carries the existing session in SESSION_IN_PROGRESS details', () => {
    const details = { session: { ...base, status: 'in_progress', runningSince: AT } };
    expect(sessionInProgressDetailsSchema.safeParse(details).success).toBe(true);
  });

  it('defines the Phase 4B error codes', () => {
    expect(errorCodeSchema.safeParse('SESSION_IN_PROGRESS').success).toBe(true);
    expect(errorCodeSchema.safeParse('NOT_CONNECTED').success).toBe(true);
  });
});

describe('listFocusSessionsQuerySchema (V1, V2)', () => {
  it('defaults the limit and leaves the range open', () => {
    expect(listFocusSessionsQuerySchema.parse({})).toEqual({
      limit: FOCUS_SESSION_LIST_DEFAULT_LIMIT,
    });
    expect(FOCUS_SESSION_LIST_DEFAULT_LIMIT).toBe(50);
    expect(FOCUS_SESSION_LIST_MAX_LIMIT).toBe(100);
  });

  it('takes instants with an offset and needs from < to', () => {
    expect(
      listFocusSessionsQuerySchema.safeParse({ from: AT, to: '2026-10-07T15:30:00.000+05:30' })
        .success,
    ).toBe(false);
    expect(listFocusSessionsQuerySchema.safeParse({ from: AT, to: LATER }).success).toBe(true);
    expect(listFocusSessionsQuerySchema.safeParse({ from: AT, to: AT }).success).toBe(false);
    for (const from of ['2026-10-07', '2026-10-07T10:00:00', '2026-10-07T10:00:00.0001Z']) {
      expect(listFocusSessionsQuerySchema.safeParse({ from }).success).toBe(false);
    }
  });

  it('accepts the supported instant range exactly', () => {
    expect(
      listFocusSessionsQuerySchema.safeParse({
        from: '1970-01-01T00:00:00.000Z',
        to: '9999-12-31T23:59:59.999Z',
      }).success,
    ).toBe(true);
    // The instant counts, not the wall time: this is 1970-01-01T00:00:00Z.
    expect(
      listFocusSessionsQuerySchema.safeParse({ from: '1970-01-01T05:30:00.000+05:30' }).success,
    ).toBe(true);
  });

  it.each([
    '0000-01-01T00:00:00.000Z',
    '0001-01-01T00:00:00Z',
    '1969-12-31T23:59:59.999Z',
    // In range as a wall time, but 1969-12-31T18:30:00Z as an instant.
    '1970-01-01T00:00:00.000+05:30',
    // Four-digit years, pushed out of range by the offset: year 10000 and the BC era.
    '9999-12-31T23:59:59.999-12:00',
    '0000-01-01T00:00:00.000+14:00',
    '+010000-01-01T00:00:00.000Z',
    // Shaped like an instant but not one: an impossible date and a leap second.
    '2026-02-31T00:00:00.000Z',
    '2026-12-31T23:59:60.000Z',
  ])('rejects the unsupported instant %s as either bound', (bound) => {
    expect(listFocusSessionsQuerySchema.safeParse({ from: bound }).success).toBe(false);
    expect(listFocusSessionsQuerySchema.safeParse({ to: bound }).success).toBe(false);
  });

  it('rejects unknown keys and out-of-range limits', () => {
    for (const query of [
      { userId: SESSION_ID },
      { limit: '0' },
      { limit: '101' },
      { limit: 'abc' },
      { limit: '' },
      { limit: '1.5' },
      { cursor: '' },
      { cursor: 'x'.repeat(129) },
      // Express hands a repeated query parameter over as an array, never a string.
      { limit: ['2', '3'] },
      { cursor: ['a', 'b'] },
      { from: [AT, LATER] },
    ]) {
      expect(listFocusSessionsQuerySchema.safeParse(query).success).toBe(false);
    }
  });
});

describe('focusSessionSummaryQuerySchema (V3–V5)', () => {
  const valid = { from: '2026-10-01', to: '2026-10-07', tz: 'Europe/Berlin' };

  it('accepts a range of dates in an IANA zone, up to 366 days', () => {
    expect(focusSessionSummaryQuerySchema.parse(valid)).toEqual(valid);
    expect(
      focusSessionSummaryQuerySchema.safeParse({ ...valid, from: '2026-10-07', to: '2026-10-07' })
        .success,
    ).toBe(true);
    expect(
      focusSessionSummaryQuerySchema.safeParse({ ...valid, from: '2027-01-01', to: '2028-01-01' })
        .success,
    ).toBe(true);
    expect(FOCUS_SESSION_SUMMARY_MAX_DAYS).toBe(366);
  });

  it.each([
    { ...valid, to: '2026-09-30' },
    { ...valid, from: '2027-01-01', to: '2028-01-02' },
    { ...valid, tz: '+05:30' },
    { ...valid, tz: undefined },
    { ...valid, from: '1969-12-31' },
    { ...valid, from: '2026-10-01T00:00:00Z' },
    { ...valid, extra: 'x' },
  ])('rejects %j', (query) => {
    expect(focusSessionSummaryQuerySchema.safeParse(query).success).toBe(false);
  });

  it('describes a dense, non-negative summary', () => {
    const response = {
      completedCount: 1,
      completedFocusedSeconds: 1_500,
      totalFocusedSeconds: 1_800,
      days: [{ date: '2026-10-07', completedFocusedSeconds: 1_500, totalFocusedSeconds: 1_800 }],
    };
    expect(focusSessionSummaryResponseSchema.parse(response)).toEqual(response);
    expect(
      focusSessionSummaryResponseSchema.safeParse({ ...response, completedCount: -1 }).success,
    ).toBe(false);
  });
});

describe('paths', () => {
  it('serves the summary at its own path, never as a session id', () => {
    expect(focusSessionPaths.summary).toBe('/focus-sessions/summary');
    expect(focusSessionParamsSchema.safeParse({ sessionId: 'summary' }).success).toBe(false);
  });

  it('builds per-session paths and validates their parameters', () => {
    const sessionId = focusSessionIdSchema.parse(SESSION_ID);
    expect(focusSessionPath(focusSessionPaths.pause, sessionId)).toBe(
      `/focus-sessions/${SESSION_ID}/pause`,
    );
    expect(focusSessionParamsSchema.safeParse({ sessionId: SESSION_ID }).success).toBe(true);
    expect(focusSessionParamsSchema.safeParse({ sessionId: 'current' }).success).toBe(false);
  });
});
