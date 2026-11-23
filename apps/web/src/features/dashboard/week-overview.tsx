import { useState } from 'react';

import { BarChart } from '../../ui/bar-chart';
import { Card, Eyebrow } from '../../ui/primitives';
import { formatDuration, formatWeekdayShort } from '../review/review-format';
import { useFocusSessionInsights } from '../review/review-queries';
import { currentReviewRange } from '../review/review-range';

/**
 * The last seven days against the daily goal (A2), then where the time went: the tasks
 * that took the most focus this week (A6).
 */
export function WeekOverview() {
  const [range] = useState(() => currentReviewRange());
  const insights = useFocusSessionInsights(range);

  return (
    <Card className="space-y-6 rounded-[2rem] p-6 md:p-8">
      <div className="flex items-center justify-between">
        <Eyebrow>This week</Eyebrow>
        <p className="text-xs text-muted">{range.tz}</p>
      </div>
      {insights.isPending && <p className="text-muted">Loading your week…</p>}
      {insights.isError && (
        <p className="text-sm text-muted">Your week is not available right now.</p>
      )}
      {insights.isSuccess && (
        <>
          <BarChart
            height={150}
            goal={insights.data.dailyGoalSeconds}
            data={insights.data.days.map((day) => ({
              key: day.date,
              label: formatWeekdayShort(day.date),
              value: day.completedFocusedSeconds,
              total: day.totalFocusedSeconds,
            }))}
            formatValue={formatDuration}
          />
          <div className="space-y-3 border-t border-line pt-5">
            <p className="text-[10px] tracking-[0.3em] text-muted uppercase">Where it went</p>
            {insights.data.tasks.length === 0 && insights.data.noTask.sessionCount === 0 ? (
              <p className="text-sm text-muted">Your first session will show up here.</p>
            ) : (
              <ul className="space-y-3">
                {[
                  ...insights.data.tasks.slice(0, 3).map((task) => ({
                    key: task.taskId,
                    title: task.title,
                    seconds: task.totalFocusedSeconds,
                  })),
                  ...(insights.data.noTask.totalFocusedSeconds > 0
                    ? [
                        {
                          key: 'no-task',
                          title: 'Without an intention',
                          seconds: insights.data.noTask.totalFocusedSeconds,
                        },
                      ]
                    : []),
                ].map((item) => (
                  <li key={item.key} className="space-y-1.5">
                    <div className="flex justify-between gap-3 text-sm">
                      <span className="truncate">{item.title}</span>
                      <span className="shrink-0 text-muted">{formatDuration(item.seconds)}</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-line">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-focus to-violet"
                        style={{
                          width: `${String(
                            Math.max(
                              4,
                              (item.seconds /
                                Math.max(1, insights.data.totals.totalFocusedSeconds)) *
                                100,
                            ),
                          )}%`,
                        }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
