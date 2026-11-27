import type { FocusSessionInsightsResponse, InsightsHeatmapCell } from '@focus-flow/contracts';
import { motion } from 'motion/react';
import { useMemo, useState } from 'react';

import { formatDuration } from './review-format';
import { reviewErrorMessage } from './review-messages';
import { useFocusSessionInsights } from './review-queries';
import { lastNDays, readBrowserTimeZone, resolveTimeZone } from './review-range';

const RANGES = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
] as const;

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const HOURS_SHOWN = Array.from({ length: 24 }, (_, hour) => hour);

function percent(value: number): string {
  return `${String(Math.round(value * 100))}%`;
}

function hourLabel(hour: number): string {
  if (hour === 0) {
    return '12am';
  }
  if (hour === 12) {
    return '12pm';
  }
  return hour < 12 ? `${String(hour)}am` : `${String(hour - 12)}pm`;
}

/** The weekday x hour heatmap (A4): when the user's focus happens. */
function Heatmap({ cells }: { readonly cells: readonly InsightsHeatmapCell[] }) {
  const max = Math.max(1, ...cells.map((cell) => cell.totalFocusedSeconds));
  const best = cells.reduce<InsightsHeatmapCell | undefined>(
    (top, cell) =>
      cell.totalFocusedSeconds > 0 &&
      (top === undefined || cell.totalFocusedSeconds > top.totalFocusedSeconds)
        ? cell
        : top,
    undefined,
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="font-display text-3xl">Your best hours</h4>
        <p className="text-sm text-muted">
          {best === undefined
            ? 'Focus a few times and your rhythm appears here.'
            : `You focus most on ${WEEKDAYS[best.weekday] ?? ''} around ${hourLabel(best.hour)}.`}
        </p>
      </div>
      <div aria-hidden="true" className="overflow-x-auto">
        <div className="min-w-[640px] space-y-1">
          {WEEKDAYS.map((day, weekday) => (
            <div key={day} className="flex items-center gap-1">
              <span className="w-9 text-[10px] text-muted">{day}</span>
              {HOURS_SHOWN.map((hour) => {
                const cell = cells[weekday * 24 + hour];
                const level = (cell?.totalFocusedSeconds ?? 0) / max;
                return (
                  <motion.span
                    key={hour}
                    title={
                      cell === undefined || cell.totalFocusedSeconds === 0
                        ? undefined
                        : `${day} ${hourLabel(hour)}: ${formatDuration(cell.totalFocusedSeconds)}`
                    }
                    className="aspect-square flex-1 rounded-[3px]"
                    style={{
                      background:
                        level === 0
                          ? 'var(--ff-line)'
                          : `color-mix(in srgb, var(--ff-focus) ${String(Math.round(25 + level * 75))}%, transparent)`,
                    }}
                    initial={{ opacity: 0, scale: 0.5 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 0.4, delay: (weekday * 24 + hour) * 0.002 }}
                  />
                );
              })}
            </div>
          ))}
          <div className="flex gap-1 pl-10 text-[10px] text-muted">
            {HOURS_SHOWN.map((hour) => (
              <span key={hour} className="flex-1 text-center">
                {hour % 3 === 0 ? hourLabel(hour) : ''}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** FQ4: how deep the user rated their sessions, by local start hour. */
function DeepestHours({ quality }: { readonly quality: FocusSessionInsightsResponse['quality'] }) {
  const best = quality.byHour.reduce<{ hour: number; average: number } | null>(
    (top, entry, hour) =>
      entry.average !== null &&
      entry.ratedCount >= 2 &&
      (top === null || entry.average > top.average)
        ? { hour, average: entry.average }
        : top,
    null,
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="font-display text-3xl">Your deepest hours</h4>
        <p className="text-sm text-muted">
          {quality.ratedCount === 0
            ? 'Rate how deep a session was when you check in, and your deepest hours appear here.'
            : best === null
              ? `Average depth ${String(quality.average)}/5 over ${String(quality.ratedCount)} rated sessions.`
              : `Deepest around ${hourLabel(best.hour)} (${String(best.average)}/5). Average ${String(quality.average)}/5.`}
        </p>
      </div>
      {quality.ratedCount > 0 && (
        <div aria-hidden="true" className="flex h-24 items-end gap-1">
          {quality.byHour.map((entry, hour) => (
            <div
              key={hour}
              className="flex h-full flex-1 flex-col justify-end"
              title={
                entry.average === null
                  ? undefined
                  : `${hourLabel(hour)}: ${String(entry.average)}/5 (${String(entry.ratedCount)} rated)`
              }
            >
              <motion.div
                className={`rounded-t-sm ${entry.average === null ? 'bg-line' : 'bg-gradient-to-t from-focus/40 to-focus'}`}
                initial={{ height: 0 }}
                animate={{
                  height: entry.average === null ? '4%' : `${String((entry.average / 5) * 100)}%`,
                }}
                transition={{ duration: 0.6, delay: hour * 0.01 }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** DF6: how the range's Deep Focus sessions went. */
function DeepFocusStats({ deep }: { readonly deep: FocusSessionInsightsResponse['deepFocus'] }) {
  const stats = [
    { label: 'Deep Focus sessions', value: String(deep.sessions) },
    { label: 'Completed with no distraction', value: String(deep.distractionFree) },
    { label: 'Broken', value: String(deep.broken) },
    { label: 'Unbroken in a row', value: String(deep.unbrokenRun) },
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="font-display text-3xl">Deep Focus</h4>
        <p className="text-sm text-muted">
          {deep.sessions === 0
            ? 'Try the Deep Focus tab: full screen, no tab switching.'
            : `${String(deep.completed)} of ${String(deep.sessions)} completed, ${String(deep.distractions)} ${deep.distractions === 1 ? 'distraction' : 'distractions'} in all.`}
        </p>
      </div>
      {deep.sessions > 0 && (
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {stats.map((stat) => (
            <div key={stat.label} className="rounded-2xl border border-line bg-surface p-4">
              <dt className="text-xs text-muted">{stat.label}</dt>
              <dd className="font-display mt-1 text-3xl">{stat.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function Bar({
  label,
  seconds,
  of,
  muted = false,
  note,
}: {
  readonly label: string;
  readonly seconds: number;
  readonly of: number;
  readonly muted?: boolean;
  readonly note?: string;
}) {
  return (
    <li className="space-y-1.5">
      <div className="flex justify-between gap-3 text-sm">
        <span className={`truncate ${muted ? 'text-muted italic' : ''}`}>
          {label}
          {note !== undefined && <span className="ml-2 text-xs text-muted">{note}</span>}
        </span>
        <span className="shrink-0 text-muted">{formatDuration(seconds)}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-line">
        <motion.div
          className={`h-full rounded-full ${muted ? 'bg-muted/50' : 'bg-gradient-to-r from-focus to-violet'}`}
          initial={{ width: 0 }}
          animate={{ width: `${String(Math.max(2, (seconds / Math.max(1, of)) * 100))}%` }}
          transition={{ duration: 0.9, ease: 'easeOut' }}
        />
      </div>
    </li>
  );
}

function Breakdown({ data }: { readonly data: FocusSessionInsightsResponse }) {
  const total = data.totals.totalFocusedSeconds;
  const empty = data.tasks.length === 0 && data.noTask.sessionCount === 0;
  return (
    <div className="space-y-4">
      <h4 className="font-display text-3xl">Where your focus went</h4>
      {empty ? (
        <p className="text-sm text-muted">No ended sessions in this period yet.</p>
      ) : (
        <ul className="space-y-4">
          {data.tasks.map((task) => (
            <Bar
              key={task.taskId}
              label={task.title}
              seconds={task.totalFocusedSeconds}
              of={total}
              note={
                task.deleted
                  ? '(deleted)'
                  : `${String(task.completedCount)}/${String(task.sessionCount)} done`
              }
            />
          ))}
          {data.otherTasks.taskCount > 0 && (
            <Bar
              label={`${String(data.otherTasks.taskCount)} other tasks`}
              seconds={data.otherTasks.totalFocusedSeconds}
              of={total}
              muted
            />
          )}
          {data.noTask.sessionCount > 0 && (
            <Bar
              label="Without an intention"
              seconds={data.noTask.totalFocusedSeconds}
              of={total}
              muted
            />
          )}
        </ul>
      )}
    </div>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div>
      <dt className="text-[10px] tracking-[0.3em] text-muted uppercase">{label}</dt>
      <dd className="mt-2">
        <span className="font-display block text-4xl leading-none">{value}</span>
        <span className="mt-1.5 block text-xs text-muted">{hint}</span>
      </dd>
    </div>
  );
}

function Rhythm({ data }: { readonly data: FocusSessionInsightsResponse }) {
  const { delta, previous } = data.comparison;
  const change = delta.totalFocusedSecondsChange;
  const soloRoom = data.split.solo.totalFocusedSeconds + data.split.room.totalFocusedSeconds;
  const roomShare = soloRoom === 0 ? null : data.split.room.totalFocusedSeconds / soloRoom;
  return (
    <dl className="grid grid-cols-2 gap-6 md:grid-cols-5">
      <Figure
        label="Streak"
        value={`${String(data.streak.current)}d`}
        hint={`Longest ever: ${String(data.streak.longest)} ${data.streak.longest === 1 ? 'day' : 'days'}`}
      />
      <Figure
        label="Days on goal"
        value={`${String(data.goalDaysMet)}/${String(data.range.dayCount)}`}
        hint={`Goal: ${formatDuration(data.dailyGoalSeconds)} a day`}
      />
      <Figure
        label="Vs previous"
        value={change === null ? '—' : `${change >= 0 ? '+' : '−'}${percent(Math.abs(change))}`}
        hint={`${formatDuration(previous.totalFocusedSeconds)} the period before`}
      />
      <Figure
        label="Intentions done"
        value={
          data.checkIns.withIntention === 0
            ? '—'
            : `${String(data.checkIns.done)}/${String(data.checkIns.withIntention)}`
        }
        hint={`${String(data.checkIns.progress)} progress · ${String(data.checkIns.stuck)} stuck · ${String(data.checkIns.unrecorded)} unanswered`}
      />
      <Figure
        label="Together"
        value={roomShare === null ? '—' : percent(roomShare)}
        hint={`${formatDuration(data.split.room.totalFocusedSeconds)} in rooms, ${formatDuration(data.split.solo.totalFocusedSeconds)} solo`}
      />
    </dl>
  );
}

/** Review insights (A1–A10) over a chosen range: rhythm, the heatmap and the breakdown. */
export function InsightsPanel() {
  const [days, setDays] = useState<number>(30);
  // "Today" and the zone are fixed once per visit, like the summary's range, so the query
  // key stays stable while the page is open.
  const [now] = useState(() => Date.now());
  const [timeZone] = useState(() => resolveTimeZone(readBrowserTimeZone()).timeZone);
  const range = useMemo(() => lastNDays(days, now, timeZone), [days, now, timeZone]);
  const insights = useFocusSessionInsights(range);

  return (
    <section aria-labelledby="insights-heading" className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs tracking-[0.3em] text-focus uppercase">( Patterns )</p>
          <h3 id="insights-heading" className="font-display mt-3 text-4xl">
            How you focus
          </h3>
        </div>
        <div
          role="group"
          aria-label="Period"
          className="flex gap-1 rounded-full border border-line bg-surface p-1"
        >
          {RANGES.map((option) => (
            <button
              key={option.days}
              type="button"
              aria-pressed={days === option.days}
              onClick={() => {
                setDays(option.days);
              }}
              className={`rounded-full px-4 py-1.5 text-sm transition ${
                days === option.days ? 'bg-focus text-focus-ink' : 'text-muted hover:text-ink'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      {insights.isPending && <p className="text-muted">Reading the forest…</p>}
      {insights.isError && (
        <p role="alert" className="text-sm text-danger">
          {reviewErrorMessage(insights.error)}
        </p>
      )}
      {insights.isSuccess && (
        <>
          <Rhythm data={insights.data} />
          <div className="grid gap-10 border-t border-line pt-8 lg:grid-cols-[1.6fr_1fr]">
            <div className="space-y-10">
              <Heatmap cells={insights.data.heatmap} />
              <DeepestHours quality={insights.data.quality} />
              <DeepFocusStats deep={insights.data.deepFocus} />
            </div>
            <Breakdown data={insights.data} />
          </div>
        </>
      )}
    </section>
  );
}
