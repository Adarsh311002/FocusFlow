import { useState } from 'react';

import { buttonClass } from '../../ui/primitives';
import { currentWeek, OPEN_WEEKLY_REVIEW, useWeeklyPriorities } from './weekly-queries';

/** WR5: this week's three on the dashboard, with a way back into the weekly review. */
export function WeeklyTopThree() {
  const [{ week }] = useState(() => currentWeek());
  const priorities = useWeeklyPriorities(week);
  const entries = priorities.data?.priorities ?? [];
  const done = entries.filter((entry) => entry.task.status === 'completed').length;

  return (
    <section aria-labelledby="weekly-top-three" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 id="weekly-top-three" className="text-xs tracking-[0.3em] text-focus uppercase">
          This week’s three
        </h4>
        {entries.length > 0 && (
          <span className="text-xs text-muted">{`${String(done)} of ${String(entries.length)} done`}</span>
        )}
      </div>
      {entries.length === 0 ? (
        <p className="text-sm text-muted">Nothing chosen for this week yet.</p>
      ) : (
        <ol aria-labelledby="weekly-top-three" className="space-y-1.5">
          {entries.map((entry) => (
            <li
              key={entry.task.id}
              className={`flex items-baseline gap-3 text-sm ${
                entry.task.status === 'completed' ? 'text-muted line-through' : ''
              }`}
            >
              <span aria-hidden="true" className="font-display text-xl text-focus">
                {entry.task.status === 'completed' ? '✓' : String(entry.position)}
              </span>
              {entry.task.title}
              {entry.task.status === 'completed' && <span className="sr-only"> (done)</span>}
            </li>
          ))}
        </ol>
      )}
      <button
        type="button"
        onClick={() => {
          window.dispatchEvent(new Event(OPEN_WEEKLY_REVIEW));
        }}
        className={buttonClass('ghost', 'px-4 py-1.5 text-xs')}
      >
        {entries.length === 0 ? 'Plan your week' : 'Change the three'}
      </button>
    </section>
  );
}
