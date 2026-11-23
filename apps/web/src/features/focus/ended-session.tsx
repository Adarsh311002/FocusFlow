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
    <div role="status" className="space-y-2 rounded-2xl border border-focus/30 bg-focus/10 p-4">
      <p className="text-sm">
        {session.task === null ? '' : `${session.task.title}. `}
        {focusOutcomeMessage(session)}
      </p>
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
