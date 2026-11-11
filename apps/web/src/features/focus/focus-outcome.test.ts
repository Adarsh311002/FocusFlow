import { type AbandonReason, focusSessionViewSchema } from '@focus-flow/contracts';
import { describe, expect, it } from 'vitest';

import { fakeSession } from '../../test/fake-focus-session-api';
import { type EndedSessionView, focusOutcomeMessage } from './focus-outcome';

const ROOM_CONTEXT = {
  kind: 'room',
  roomId: '0192f8a0-3333-7aaa-8bbb-000000000003',
  focusRunId: '0192f8a0-1111-7aaa-8bbb-000000000001',
} as const;

const abandoned = (reason: AbandonReason, focusedSeconds = 600): EndedSessionView => {
  const view = focusSessionViewSchema.parse(
    fakeSession({
      context: ROOM_CONTEXT,
      status: 'abandoned',
      abandonReason: reason,
      focusedSeconds,
      endedAt: '2026-03-09T10:10:00.000Z',
    }),
  );
  if (view.status === 'in_progress') {
    throw new Error('unexpected');
  }
  return view;
};

describe('focusOutcomeMessage', () => {
  it('keeps the solo wording', () => {
    const solo = focusSessionViewSchema.parse(fakeSession());
    if (solo.status === 'in_progress') {
      throw new Error('unexpected');
    }
    expect(focusOutcomeMessage(solo)).toBe('Completed: 25 min of focus recorded.');
  });

  it('says a room session completed together', () => {
    const view = focusSessionViewSchema.parse(fakeSession({ context: ROOM_CONTEXT }));
    if (view.status === 'in_progress') {
      throw new Error('unexpected');
    }
    expect(focusOutcomeMessage(view)).toMatch(/Completed: you focused together for 25 min/);
  });

  it.each([
    ['opted_out', /You left the focus run: 10 min recorded/],
    ['left_room', /You left the room.*10 min recorded/],
    ['removed', /removed from the room.*10 min recorded/],
    ['reset', /host reset the timer.*10 min recorded/],
    ['phase_changed', /host switched the timer to another phase.*10 min recorded/],
    ['grace_expired', /disconnected: 10 min recorded/],
    ['stopped', /Stopped: 10 min recorded/],
    ['expired', /Expired.*10 min recorded/],
  ] as const)('explains %s and the recorded time', (reason, pattern) => {
    expect(focusOutcomeMessage(abandoned(reason))).toMatch(pattern);
  });

  it('says no time was recorded when the room timer was lost', () => {
    expect(focusOutcomeMessage(abandoned('timer_lost', 0))).toMatch(/No time was recorded/);
  });
});
