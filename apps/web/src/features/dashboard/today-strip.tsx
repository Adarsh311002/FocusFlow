import { useState } from 'react';

import { formatDuration, formatWeekdayShort } from '../review/review-format';
import { useFocusSessionSummary } from '../review/review-queries';
import { currentReviewRange } from '../review/review-range';

function Figure({
  label,
  value,
  hint,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
}) {
  return (
    <div className="flex flex-col justify-between gap-3 px-6 py-5 first:pl-0">
      <dt className="text-[10px] tracking-[0.3em] text-muted uppercase">{label}</dt>
      <dd>
        <span className="font-display block text-4xl leading-none md:text-5xl">{value}</span>
        {hint !== undefined && <span className="mt-2 block text-xs text-muted">{hint}</span>}
      </dd>
    </div>
  );
}

/**
 * Today and this week in four quiet figures, read from the same 7-day summary the week
 * chart uses (one shared query).
 */
export function TodayStrip() {
  const [range] = useState(() => currentReviewRange());
  const summary = useFocusSessionSummary(range);
  if (!summary.isSuccess) {
    return null;
  }
  const { days } = summary.data;
  const today = days[days.length - 1];
  const best = days.reduce<(typeof days)[number] | undefined>(
    (top, day) =>
      top === undefined || day.completedFocusedSeconds > top.completedFocusedSeconds ? day : top,
    undefined,
  );
  const activeDays = days.filter((day) => day.totalFocusedSeconds > 0).length;
  return (
    <dl
      aria-label="Your focus at a glance"
      className="grid grid-cols-2 divide-line border-y border-line md:grid-cols-4 md:divide-x"
    >
      <Figure
        label="Today"
        value={formatDuration(today?.completedFocusedSeconds ?? 0)}
        hint="completed focus"
      />
      <Figure
        label="This week"
        value={formatDuration(summary.data.completedFocusedSeconds)}
        hint={`${String(summary.data.completedCount)} sessions completed`}
      />
      <Figure
        label="Days in the forest"
        value={`${String(activeDays)} / 7`}
        hint="days you focused"
      />
      <Figure
        label="Best day"
        value={
          best === undefined || best.completedFocusedSeconds === 0
            ? '—'
            : formatWeekdayShort(best.date)
        }
        hint={
          best === undefined || best.completedFocusedSeconds === 0
            ? 'your first one is waiting'
            : formatDuration(best.completedFocusedSeconds)
        }
      />
    </dl>
  );
}
