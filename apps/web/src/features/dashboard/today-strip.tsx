import type { ReactNode } from 'react';
import { useState } from 'react';

import { formatDuration } from '../review/review-format';
import { useFocusSessionInsights } from '../review/review-queries';
import { currentReviewRange } from '../review/review-range';

function Figure({
  label,
  value,
  hint,
  aside,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
  readonly aside?: ReactNode;
}) {
  return (
    <div className="flex items-end justify-between gap-4 px-6 py-5 first:pl-0">
      <div className="flex flex-col justify-between gap-3">
        <dt className="text-[10px] tracking-[0.3em] text-muted uppercase">{label}</dt>
        <dd>
          <span className="font-display block text-4xl leading-none md:text-5xl">{value}</span>
          {hint !== undefined && <span className="mt-2 block text-xs text-muted">{hint}</span>}
        </dd>
      </div>
      {aside}
    </div>
  );
}

/** A small ring filling toward today's goal; it glows once the goal is met. */
function GoalRing({ progress }: { readonly progress: number }) {
  const radius = 20;
  const circumference = 2 * Math.PI * radius;
  const met = progress >= 1;
  return (
    <svg aria-hidden="true" viewBox="0 0 48 48" className="h-12 w-12 shrink-0 -rotate-90">
      <circle cx="24" cy="24" r={radius} fill="none" stroke="var(--ff-line)" strokeWidth="4" />
      <circle
        cx="24"
        cy="24"
        r={radius}
        fill="none"
        stroke={met ? 'var(--ff-ok)' : 'var(--ff-focus)'}
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - Math.min(1, progress))}
        style={{
          transition: 'stroke-dashoffset 1s ease-out',
          filter: met ? 'drop-shadow(0 0 6px var(--ff-ok))' : undefined,
        }}
      />
    </svg>
  );
}

function percent(value: number): string {
  return `${String(Math.round(value * 100))}%`;
}

/**
 * The day and the week at a glance, from the insights endpoint (A1–A10): progress toward
 * today's goal, the streak, this week against last week, and how often sessions finish.
 */
export function TodayStrip() {
  const [range] = useState(() => currentReviewRange());
  const insights = useFocusSessionInsights(range);
  if (!insights.isSuccess) {
    return null;
  }
  const data = insights.data;
  const today = data.days[data.days.length - 1];
  const todaySeconds = today?.totalFocusedSeconds ?? 0;
  const progress = today?.goalProgress ?? 0;
  const change = data.comparison.delta.totalFocusedSecondsChange;
  const { checkIns } = data;
  const recorded = checkIns.withIntention - checkIns.unrecorded;

  return (
    <dl
      aria-label="Your focus at a glance"
      className="grid grid-cols-2 divide-line border-y border-line md:grid-cols-4 md:divide-x"
    >
      <Figure
        label="Today"
        value={formatDuration(todaySeconds)}
        hint={
          progress >= 1
            ? `Goal of ${formatDuration(data.dailyGoalSeconds)} reached`
            : `of your ${formatDuration(data.dailyGoalSeconds)} goal`
        }
        aside={<GoalRing progress={progress} />}
      />
      <Figure
        label="Streak"
        value={`${String(data.streak.current)} ${data.streak.current === 1 ? 'day' : 'days'}`}
        hint={
          data.streak.todayCompleted
            ? `Today counts · best ${String(data.streak.longest)}`
            : data.streak.current > 0
              ? 'Finish a session today to keep it'
              : `Best ${String(data.streak.longest)} · start one today`
        }
      />
      <Figure
        label="This week"
        value={formatDuration(data.totals.totalFocusedSeconds)}
        hint={
          change === null
            ? `${String(data.goalDaysMet)} of 7 days on goal`
            : `${change >= 0 ? '▲' : '▼'} ${percent(Math.abs(change))} vs last week · ${String(data.goalDaysMet)}/7 on goal`
        }
      />
      {/* CI5: what the user said they finished, not just minutes sat. */}
      <Figure
        label="Intentions done"
        value={
          checkIns.withIntention === 0
            ? '—'
            : `${String(checkIns.done)}/${String(checkIns.withIntention)}`
        }
        hint={
          checkIns.withIntention === 0
            ? 'Name what you will finish when you start'
            : checkIns.unrecorded > 0
              ? `${String(checkIns.unrecorded)} still to check in`
              : recorded === 0
                ? 'Check in after a session'
                : `${percent(checkIns.done / recorded)} of check-ins were done`
        }
      />
    </dl>
  );
}
