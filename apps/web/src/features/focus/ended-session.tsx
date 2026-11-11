import { Link } from '@tanstack/react-router';

import { focusOutcomeMessage } from './focus-outcome';
import { useDismissLastEnded, useLastEndedFocusSession } from './focus-queries';

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
        {focusOutcomeMessage(session)}
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
