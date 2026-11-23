import { useState } from 'react';

import { BarChart } from '../../ui/bar-chart';
import { Card, Eyebrow } from '../../ui/primitives';
import { formatDuration, formatWeekdayShort } from '../review/review-format';
import { useFocusSessionSummary } from '../review/review-queries';
import { currentReviewRange } from '../review/review-range';

function Stat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface-strong/50 p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="font-display mt-1 text-4xl">{value}</p>
    </div>
  );
}

/** The last seven days at a glance: key numbers and an animated chart. */
export function WeekOverview({ showStats = true }: { readonly showStats?: boolean }) {
  const [range] = useState(() => currentReviewRange());
  const summary = useFocusSessionSummary(range);

  return (
    <Card className="space-y-6 rounded-[2rem] p-6 md:p-8">
      <div className="flex items-center justify-between">
        <Eyebrow>This week</Eyebrow>
        <p className="text-xs text-muted">{range.tz}</p>
      </div>
      {summary.isPending && <p className="text-muted">Loading your week…</p>}
      {summary.isError && (
        <p className="text-sm text-muted">Your weekly summary is not available right now.</p>
      )}
      {summary.isSuccess && (
        <>
          {showStats && (
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Sessions done" value={String(summary.data.completedCount)} />
              <Stat
                label="Focus time"
                value={formatDuration(summary.data.completedFocusedSeconds)}
              />
              <Stat
                label="Incl. stopped"
                value={formatDuration(summary.data.totalFocusedSeconds)}
              />
            </div>
          )}
          <BarChart
            height={150}
            data={summary.data.days.map((day) => ({
              key: day.date,
              label: formatWeekdayShort(day.date),
              value: day.completedFocusedSeconds,
              total: day.totalFocusedSeconds,
            }))}
            formatValue={formatDuration}
          />
        </>
      )}
    </Card>
  );
}
