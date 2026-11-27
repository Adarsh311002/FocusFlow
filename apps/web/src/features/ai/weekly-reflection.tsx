import { addCalendarDays } from '@focus-flow/contracts';
import { useState } from 'react';

import { buttonClass } from '../../ui/primitives';
import { currentWeek } from '../weekly/weekly-queries';
import {
  FAILURE_TEXT,
  isActive,
  requestErrorText,
  useRequestWeeklyReflection,
  useWeeklyReflection,
} from './ai-data';

// The weekly reflection (AI8): a short, honest read of one week, written from the user's
// own numbers and check-in notes. Kept per week, so it is there when they come back.

const WEEK_LABEL = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

export function WeeklyReflection() {
  const [{ week: thisWeek, tz }] = useState(() => currentWeek());
  const [which, setWhich] = useState<'last' | 'this'>('last');
  const week = which === 'this' ? thisWeek : addCalendarDays(thisWeek, -7);
  const reflection = useWeeklyReflection(week);
  const request = useRequestWeeklyReflection(week, tz);

  const job = reflection.data ?? null;
  const busy = request.isPending || isActive(job);
  const result =
    job?.kind === 'weekly_reflection' && job.status === 'succeeded' ? job.result : null;
  const from = WEEK_LABEL.format(new Date(`${week}T12:00:00Z`));
  const to = WEEK_LABEL.format(new Date(`${addCalendarDays(week, 6)}T12:00:00Z`));

  return (
    <section aria-labelledby="weekly-reflection" aria-busy={busy} className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs tracking-[0.3em] text-focus uppercase">( Looking back )</p>
          <h3 id="weekly-reflection" className="font-display mt-3 text-4xl">
            Your week, reflected
          </h3>
          <p className="mt-1 text-sm text-muted">{`${from} – ${to}`}</p>
        </div>
        <div
          role="group"
          aria-label="Which week"
          className="flex gap-1 rounded-full border border-line p-1"
        >
          {(['last', 'this'] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={which === option}
              onClick={() => {
                setWhich(option);
                request.reset();
              }}
              className={`rounded-full px-4 py-1.5 text-xs ${which === option ? 'bg-focus/20 text-ink' : 'text-muted hover:text-ink'}`}
            >
              {option === 'last' ? 'Last week' : 'This week'}
            </button>
          ))}
        </div>
      </div>

      {reflection.isPending && <p className="text-sm text-muted">Looking for a reflection…</p>}

      {busy && (
        <p role="status" className="text-sm text-muted">
          <span aria-hidden="true" className="mr-2 inline-block animate-pulse">
            🦉
          </span>
          Reading your week…
        </p>
      )}

      {result !== null && (
        <div className="space-y-4">
          <p className="font-display text-2xl leading-snug">{result.headline}</p>
          <div className="grid gap-4 md:grid-cols-2">
            {result.wins.length > 0 && (
              <div>
                <p className="text-[10px] tracking-[0.3em] text-muted uppercase">Went well</p>
                <ul aria-label="Went well" className="mt-2 space-y-1.5 text-sm">
                  {result.wins.map((win) => (
                    <li key={win}>🌱 {win}</li>
                  ))}
                </ul>
              </div>
            )}
            {result.patterns.length > 0 && (
              <div>
                <p className="text-[10px] tracking-[0.3em] text-muted uppercase">Noticed</p>
                <ul aria-label="Noticed" className="mt-2 space-y-1.5 text-sm">
                  {result.patterns.map((pattern) => (
                    <li key={pattern}>🍃 {pattern}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <p className="rounded-2xl border border-focus/30 bg-focus/10 p-4 text-sm">
            <span className="font-medium">Try next: </span>
            {result.suggestion}
          </p>
          {job?.source === 'mock' && (
            <p className="text-xs text-muted">
              A sample reflection from your numbers: no AI model is set up on this server yet.
            </p>
          )}
        </div>
      )}

      {job?.status === 'failed' && !busy && (
        <p role="alert" className="text-sm text-warm">
          {FAILURE_TEXT[job.failure ?? 'unavailable']}
        </p>
      )}
      {request.isError && (
        <p role="alert" className="text-sm text-warm">
          {requestErrorText(request.error)}
        </p>
      )}

      {!busy && !reflection.isPending && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => {
              request.mutate();
            }}
            className={buttonClass(result === null ? 'primary' : 'ghost', 'px-5 py-2 text-xs')}
          >
            {result === null
              ? `✨ Reflect on ${which === 'last' ? 'last' : 'this'} week`
              : 'Reflect again'}
          </button>
          <span className="text-xs text-muted">
            Sends that week’s totals, task titles and your check-in notes to the AI helper.
          </span>
        </div>
      )}
    </section>
  );
}
