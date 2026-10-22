import type { FocusSessionView } from '@focus-flow/contracts';

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
    <li
      aria-label={`${title}, ${status}`}
      className="space-y-1 rounded border border-slate-200 p-3 text-sm"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className={session.task === null ? 'text-slate-500 italic' : 'font-medium'}>
          {title}
          {session.task?.deleted === true && (
            <span className="ml-2 text-xs text-slate-500">(deleted)</span>
          )}
        </p>
        <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-semibold">{status}</span>
      </div>
      <p>
        {`Focused ${formatDuration(session.focusedSeconds)} of ${formatDuration(session.plannedSeconds)} planned`}
        {running && (
          // `focusedSeconds` excludes the stretch that is running right now (D6).
          <span className="text-slate-500"> (plus the current running stretch)</span>
        )}
      </p>
      <p className="text-slate-600">
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
