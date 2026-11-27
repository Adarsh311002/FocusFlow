import { DEEP_FOCUS_LEAVE_WARNING_SECONDS, DEEP_FOCUS_PAUSE_SECONDS } from '@focus-flow/contracts';
import { Link } from '@tanstack/react-router';

import { Eyebrow } from '../../ui/primitives';
import { EndedSession } from '../focus/ended-session';
import { focusErrorMessage } from '../focus/focus-messages';
import { useCurrentFocusSession } from '../focus/focus-queries';
import { StartSessionForm } from '../focus/start-session-form';

// `/deep-focus` (DF1–DF5): its own tab, where a Deep Focus session is set up and started.
// The running session itself is the full-screen layer over every page (DeepFocusLayer).

const RULES = [
  'The page goes full screen and shows only your intention and the timer.',
  `Switch tabs, apps or leave full screen and a ${String(DEEP_FOCUS_LEAVE_WARNING_SECONDS)}-second countdown starts. Come back in time and it counts as one distraction; stay away and the session resets.`,
  `One pause of up to ${String(DEEP_FOCUS_PAUSE_SECONDS / 60)} minutes. While paused you may leave.`,
  'Ending early takes a 3-second hold, so an impulse is not enough.',
  'Notes and reminders wait until you are done. A breath before you start helps you settle.',
] as const;

export function DeepFocusPage() {
  const current = useCurrentFocusSession();

  let body;
  if (current.isPending) {
    body = (
      <p role="status" className="text-muted">
        Checking for a running session…
      </p>
    );
  } else if (current.isError && current.data === undefined) {
    body = (
      <p role="alert" className="text-sm text-danger">
        {focusErrorMessage(current.error)}
      </p>
    );
  } else if (current.data === null || current.data.status !== 'in_progress') {
    body = (
      <div className="space-y-4">
        <EndedSession />
        <StartSessionForm deep />
      </div>
    );
  } else if (current.data.deepFocus !== undefined) {
    body = (
      <p role="status" className="text-muted">
        Your Deep Focus session is running.
      </p>
    );
  } else {
    body = (
      <div className="space-y-3">
        <p role="status" className="text-muted">
          A focus session is already running. Finish it before starting Deep Focus.
        </p>
        <Link
          to="/dashboard"
          className="inline-block rounded-xl border border-line bg-surface px-4 py-2 text-sm hover:bg-surface-strong"
        >
          Go to the session
        </Link>
      </div>
    );
  }

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <div>
        <Eyebrow>( Deep Focus )</Eyebrow>
        <h2 className="font-display mt-3 text-6xl md:text-7xl">
          One thing. <em className="text-focus">No way out.</em>
        </h2>
        <p className="mt-4 max-w-xl text-muted">
          For the work that needs all of you. Pick what you will finish, choose your sounds, and the
          rest of the world waits.
        </p>
        <ul className="mt-6 max-w-xl space-y-3 text-sm">
          {RULES.map((rule) => (
            <li key={rule} className="flex gap-3">
              <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-focus" />
              {rule}
            </li>
          ))}
        </ul>
      </div>
      <section
        aria-label="Start Deep Focus"
        className="space-y-6 rounded-[2rem] border border-line bg-surface p-6 shadow-card backdrop-blur-xl md:p-8"
      >
        {body}
      </section>
    </div>
  );
}
