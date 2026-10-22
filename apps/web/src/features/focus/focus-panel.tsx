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

  let body;
  if (current.isPending) {
    body = (
      <p role="status" className="text-slate-600">
        Checking for a running session…
      </p>
    );
  } else if (current.isError) {
    body = (
      <div className="space-y-2">
        <p role="alert" className="text-sm text-red-700">
          {focusErrorMessage(current.error)}
        </p>
        <button
          type="button"
          onClick={() => {
            void current.refetch();
          }}
          className="rounded border border-slate-300 px-3 py-1 text-sm"
        >
          Retry
        </button>
      </div>
    );
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
      {body}
    </section>
  );
}
