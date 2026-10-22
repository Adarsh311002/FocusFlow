import type { FocusSessionView } from '@focus-flow/contracts';
import { Link } from '@tanstack/react-router';

import { useDismissLastEnded, useLastEndedFocusSession } from './focus-queries';
import { wholeMinutes } from './focus-time';

type Ended = Exclude<FocusSessionView, { status: 'in_progress' }>;

function minutes(seconds: number): string {
  return `${String(wholeMinutes(seconds))} min`;
}

/** What the server decided, in words. Never inferred locally. */
function endedMessage(session: Ended): string {
  if (session.status === 'completed') {
    return `Completed: ${minutes(session.plannedSeconds)} of focus recorded.`;
  }
  const recorded = minutes(session.focusedSeconds);
  switch (session.abandonReason) {
    case 'stopped':
      return `Stopped: ${recorded} recorded.`;
    case 'grace_expired':
      return `Ended because you disconnected: ${recorded} recorded.`;
    case 'expired':
      return `Expired: the session was not finished in time. ${recorded} recorded.`;
  }
}

/** The outcome of the last session that ended, until dismissed. */
export function EndedSession() {
  const session = useLastEndedFocusSession();
  const dismiss = useDismissLastEnded();
  if (session === null || session.status === 'in_progress') {
    return null;
  }
  return (
    <div role="status" className="space-y-2 rounded border border-slate-300 bg-slate-50 p-3">
      <p className="text-sm">
        {session.task === null ? '' : `${session.task.title}. `}
        {endedMessage(session)}
      </p>
      <div className="flex items-center gap-3 text-sm">
        <Link to="/review" className="underline">
          View in review
        </Link>
        <button
          type="button"
          onClick={() => {
            dismiss();
          }}
          className="rounded border border-slate-300 px-3 py-1 text-sm"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
