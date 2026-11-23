import type { FocusSessionView } from '@focus-flow/contracts';
import { Link } from '@tanstack/react-router';

import { formatDateTime, formatDuration, sessionStatusLabel } from './review-format';

/** One focus session in the history: what it was for, how it ended, and how long. */
export function SessionItem({
  session,
  timeZone,
}: {
  session: FocusSessionView;
  timeZone: string;
}) {
  const title = session.task?.title ?? 'No task';
  const status = sessionStatusLabel(session);
  const running = session.status === 'in_progress' && session.runningSince !== null;

  return (
    <li aria-label={`${title}, ${status}`} className="relative space-y-1.5 text-sm">
      <span
        aria-hidden="true"
        className={`absolute top-1 -left-[2.6rem] h-4 w-4 rounded-full border-4 border-canvas ${
          session.status === 'completed'
            ? 'bg-focus shadow-glow'
            : session.status === 'in_progress'
              ? 'animate-pulse bg-ok'
              : 'bg-muted/60'
        }`}
      />
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p
          className={
            session.task === null
              ? 'font-display text-2xl text-muted italic'
              : 'font-display text-2xl'
          }
        >
          {title}
          {session.task?.deleted === true && (
            <span className="ml-2 text-xs text-muted">(deleted)</span>
          )}
        </p>
        <span className="rounded-full border border-line px-3 py-1 text-[10px] tracking-[0.2em] text-muted uppercase">
          {status}
        </span>
      </div>
      {session.context.kind === 'room' && (
        <p className="text-muted">
          {'Focused together in a room · '}
          <Link
            to="/rooms/$roomId"
            params={{ roomId: session.context.roomId }}
            className="underline"
          >
            Open the room
          </Link>
        </p>
      )}
      <p>
        {`Focused ${formatDuration(session.focusedSeconds)} of ${formatDuration(session.plannedSeconds)} planned`}
        {running && (
          // `focusedSeconds` excludes the stretch that is running right now (D6).
          <span className="text-muted"> (plus the current running stretch)</span>
        )}
      </p>
      <p className="text-muted">
        {'Started '}
        <time dateTime={session.startedAt}>{formatDateTime(session.startedAt, timeZone)}</time>
        {session.status !== 'in_progress' && (
          <>
            {' · Ended '}
            <time dateTime={session.endedAt}>{formatDateTime(session.endedAt, timeZone)}</time>
          </>
        )}
      </p>
    </li>
  );
}
