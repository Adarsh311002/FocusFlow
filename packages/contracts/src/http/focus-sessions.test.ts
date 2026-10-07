import { describe, expect, it } from 'vitest';

import { errorCodeSchema } from '../errors';
import { focusSessionIdSchema } from '../ids';
import {
  abandonReasonSchema,
  currentFocusSessionResponseSchema,
  FOCUS_SESSION_PLANNED_SECONDS_MAX,
  FOCUS_SESSION_PLANNED_SECONDS_MIN,
  focusSessionParamsSchema,
  focusSessionStatusSchema,
  focusSessionViewSchema,
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

describe('paths', () => {
  it('builds per-session paths and validates their parameters', () => {
    const sessionId = focusSessionIdSchema.parse(SESSION_ID);
    expect(focusSessionPath(focusSessionPaths.pause, sessionId)).toBe(
      `/focus-sessions/${SESSION_ID}/pause`,
    );
    expect(focusSessionParamsSchema.safeParse({ sessionId: SESSION_ID }).success).toBe(true);
    expect(focusSessionParamsSchema.safeParse({ sessionId: 'current' }).success).toBe(false);
  });
});
