import { reviewErrorMessage } from './review-messages';
import { useFocusSessionHistory } from './review-queries';
import { SessionItem } from './session-item';

/** Every focus session, newest started first, with "Load more" following the API's cursor. */
export function SessionHistory({ timeZone }: { timeZone: string }) {
  const history = useFocusSessionHistory();

  let body;
  if (history.isPending) {
    body = <p className="text-slate-600">Loading your focus sessions…</p>;
  } else if (history.data === undefined) {
    // Nothing loaded yet and the first page failed.
    body = (
      <p role="alert" className="text-sm text-red-700">
        {reviewErrorMessage(history.error)}
      </p>
    );
  } else {
    const sessions = history.data.pages.flatMap((page) => page.sessions);
    body = (
      <div className="space-y-3">
        {sessions.length === 0 ? (
          <p className="text-slate-600">No focus sessions yet.</p>
        ) : (
          <ul aria-label="Focus sessions" className="space-y-2">
            {sessions.map((session) => (
              <SessionItem key={session.id} session={session} timeZone={timeZone} />
            ))}
          </ul>
        )}
        {history.isError && (
          // A failed next page or refresh keeps the sessions already on screen.
          <p role="alert" className="text-sm text-red-700">
            {reviewErrorMessage(history.error)}
          </p>
        )}
        {history.hasNextPage && (
          <button
            type="button"
            disabled={history.isFetchingNextPage}
            onClick={() => {
              void history.fetchNextPage();
            }}
            className="rounded border border-slate-300 px-3 py-1 text-sm disabled:opacity-50"
          >
            {history.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
    );
  }

  return (
    <section aria-labelledby="history-heading" className="space-y-3">
      <h3 id="history-heading" className="text-base font-semibold">
        Focus sessions
      </h3>
      {body}
    </section>
  );
}
