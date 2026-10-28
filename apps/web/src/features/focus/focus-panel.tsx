import { ActiveSession } from './active-session';
import { EndedSession } from './ended-session';
import { focusErrorMessage } from './focus-messages';
import { useCurrentFocusSession } from './focus-queries';
import { StartSessionForm } from './start-session-form';

/**
 * The focus step of the loop: decide the task, then focus. A running session is restored
 * from the server after a reload; nothing here ever starts a session by itself.
 */
export function FocusPanel() {
  const current = useCurrentFocusSession();
  // A session (or "no session") from an earlier successful read. It is what the page last
  // knew, not proof that the server can be reached now.
  const known = current.data !== undefined;

  let body;
  if (current.isPending) {
    body = (
      <p role="status" className="text-slate-600">
        Checking for a running session…
      </p>
    );
  } else if (current.isError && !known) {
    // Nothing to show instead: no session was ever read, so the error is all there is.
    body = <ReadFailure error={current.error} onRetry={current.refetch} />;
  } else if (current.data === null) {
    body = (
      <div className="space-y-3">
        <EndedSession />
        <StartSessionForm />
      </div>
    );
  } else if (current.data.status === 'in_progress') {
    body = <ActiveSession session={current.data} />;
  } else {
    // Defensive: the endpoint only returns an in-progress session or null.
    body = <StartSessionForm />;
  }

  return (
    <section
      aria-labelledby="focus-heading"
      className="space-y-3 rounded-md border border-slate-300 p-4"
    >
      <h3 id="focus-heading" className="text-sm font-semibold uppercase text-slate-600">
        Focus
      </h3>
      {/* A failed background read must not hide what is already known: the notice sits
          beside the session, with a way to try again, and says what is shown. */}
      {current.isError && known && (
        <ReadFailure
          error={current.error}
          onRetry={current.refetch}
          retrying={current.isFetching}
          note="Showing what was last known."
        />
      )}
      {body}
    </section>
  );
}

function ReadFailure({
  error,
  onRetry,
  retrying = false,
  note,
}: {
  error: unknown;
  onRetry: () => unknown;
  retrying?: boolean;
  note?: string;
}) {
  return (
    <div className="space-y-2">
      <p role="alert" className="text-sm text-red-700">
        {focusErrorMessage(error)}
        {note === undefined ? '' : ` ${note}`}
      </p>
      <button
        type="button"
        // Not `disabled`: a disabled button drops keyboard focus while the read is running.
        aria-disabled={retrying}
        onClick={() => {
          if (!retrying) {
            void onRetry();
          }
        }}
        className="rounded border border-slate-300 px-3 py-1 text-sm aria-disabled:opacity-50"
      >
        Retry
      </button>
    </div>
  );
}
