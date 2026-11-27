import { Link } from '@tanstack/react-router';

import { ParkedThoughts } from '../thoughts/thoughts';
import { focusOutcomeMessage } from './focus-outcome';
import { useDismissLastEnded, useLastEndedFocusSession } from './focus-queries';
import { SessionCheckIn } from './session-check-in';

/** The outcome of the last session that ended, with its check-in (CI6), until dismissed. */
export function EndedSession() {
  const session = useLastEndedFocusSession();
  const dismiss = useDismissLastEnded();
  if (session === null || session.status === 'in_progress') {
    return null;
  }
  return (
    <div className="space-y-4 rounded-2xl border border-focus/30 bg-focus/10 p-4">
      <p role="status" className="text-sm">
        {session.task === null ? '' : `${session.task.title}. `}
        {focusOutcomeMessage(session)}
      </p>
      {session.deepFocus !== undefined && (
        // DF6: how deep it was, alongside the check-in.
        <p className="text-sm text-muted">
          {session.deepFocus.distractions === 0
            ? 'Deep Focus: not a single distraction.'
            : `Deep Focus: you left ${String(session.deepFocus.distractions)} ${session.deepFocus.distractions === 1 ? 'time' : 'times'} and came back.`}
        </p>
      )}
      <SessionCheckIn session={session} />
      <ParkedThoughts sessionId={session.id} title="Parked during this session" />
      <div className="flex items-center gap-3 text-sm">
        <Link to="/review" className="text-focus underline underline-offset-4">
          View in review
        </Link>
        <button
          type="button"
          onClick={() => {
            dismiss();
          }}
          className="rounded-xl border border-line bg-surface px-3 py-1 text-sm hover:bg-surface-strong"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
