import type { FocusSessionView } from '@focus-flow/contracts';

import { wholeMinutes } from './focus-time';

export type EndedSessionView = Exclude<FocusSessionView, { status: 'in_progress' }>;

function minutes(seconds: number): string {
  return `${String(wholeMinutes(seconds))} min`;
}

/**
 * What the server decided about a session that ended, in plain words. The reason always
 * comes from the server's record (never inferred in the browser), and the sentence says who
 * or what ended the session so the person is never left guessing. Used by the solo notice on
 * the dashboard and by the room's "Focus together" panel.
 */
export function focusOutcomeMessage(session: EndedSessionView): string {
  if (session.status === 'completed') {
    return session.context.kind === 'room'
      ? `Completed: you focused together for ${minutes(session.plannedSeconds)}. It is recorded in your review.`
      : `Completed: ${minutes(session.plannedSeconds)} of focus recorded.`;
  }
  const recorded = minutes(session.focusedSeconds);
  switch (session.abandonReason) {
    case 'stopped':
      return `Stopped: ${recorded} recorded.`;
    case 'grace_expired':
      return `Ended because you disconnected: ${recorded} recorded.`;
    case 'expired':
      return `Expired: the session was not finished in time. ${recorded} recorded.`;
    case 'opted_out':
      return `You left the focus run: ${recorded} recorded. It did not count as completed.`;
    case 'left_room':
      return `You left the room, so your focus session ended: ${recorded} recorded.`;
    case 'removed':
      return `You were removed from the room, so your focus session ended: ${recorded} recorded.`;
    case 'reset':
      return `The host reset the timer, so the focus run ended: ${recorded} recorded.`;
    case 'phase_changed':
      return `The host switched the timer to another phase, so the focus run ended: ${recorded} recorded.`;
    case 'timer_lost':
      return 'The room timer was lost on the server, so your focus session was ended. No time was recorded.';
  }
}
