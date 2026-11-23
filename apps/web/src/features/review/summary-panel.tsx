import { StemChart } from '../../ui/stem-chart';
import { formatDayLabel, formatDuration, formatWeekdayShort } from './review-format';
import { reviewErrorMessage } from './review-messages';
import { useFocusSessionSummary } from './review-queries';
import { type CurrentReviewRange, REVIEW_RANGE_DAYS } from './review-range';

/**
 * The last days at a glance. Both totals are shown, each labelled (D34): completed focus
 * time counts completed sessions only; total focus time adds the time actually focused in
 * sessions that were stopped early or abandoned. In-progress sessions are not counted.
 */
export function SummaryPanel({ range }: { range: CurrentReviewRange }) {
  const summary = useFocusSessionSummary(range);

  let body;
  if (summary.isPending) {
    body = <p className="text-muted">Loading your summary…</p>;
  } else if (summary.isError) {
    body = (
      <p role="alert" className="text-sm text-danger">
        {reviewErrorMessage(summary.error)}
      </p>
    );
  } else {
    const data = summary.data;
    const nothingYet = data.completedCount === 0 && data.totalFocusedSeconds === 0;
    body = (
      <div className="space-y-10">
        <dl className="grid grid-cols-1 divide-line border-y border-line sm:grid-cols-3 sm:divide-x">
          <div className="py-6 sm:pr-6">
            <dt className="text-[10px] tracking-[0.3em] text-muted uppercase">
              Completed sessions
            </dt>
            <dd className="font-display mt-3 text-6xl leading-none">{data.completedCount}</dd>
          </div>
          <div className="py-6 sm:px-6">
            <dt className="text-[10px] tracking-[0.3em] text-muted uppercase">
              Completed focus time
            </dt>
            <dd className="font-display mt-3 text-6xl leading-none text-focus">
              {formatDuration(data.completedFocusedSeconds)}
            </dd>
          </div>
          <div className="py-6 sm:pl-6">
            <dt className="text-[10px] tracking-[0.3em] text-muted uppercase">
              Total focus time (incl. stopped and abandoned)
            </dt>
            <dd className="font-display mt-3 text-6xl leading-none">
              {formatDuration(data.totalFocusedSeconds)}
            </dd>
          </div>
        </dl>
        {nothingYet && <p className="text-muted">No finished focus sessions in this period yet.</p>}
        <div className="grid items-end gap-10 lg:grid-cols-[1.6fr_1fr]">
          <StemChart
            data={data.days.map((day) => ({
              key: day.date,
              label: formatWeekdayShort(day.date),
              value: day.completedFocusedSeconds,
              total: day.totalFocusedSeconds,
            }))}
            formatValue={formatDuration}
          />
          <table className="w-full text-left text-sm">
            <caption className="mb-1 text-left text-muted">Focus time per day</caption>
            <thead>
              <tr className="border-b border-line">
                <th scope="col" className="py-1 font-medium">
                  Day
                </th>
                <th scope="col" className="py-1 font-medium">
                  Completed focus
                </th>
                <th scope="col" className="py-1 font-medium">
                  Total focus (incl. abandoned)
                </th>
              </tr>
            </thead>
            <tbody>
              {data.days.map((day) => (
                <tr key={day.date} className="border-b border-line">
                  <th scope="row" className="py-1.5 pr-3 font-normal whitespace-nowrap">
                    <time dateTime={day.date}>{formatDayLabel(day.date)}</time>
                  </th>
                  <td className="py-1">{formatDuration(day.completedFocusedSeconds)}</td>
                  <td className="py-1">{formatDuration(day.totalFocusedSeconds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <section aria-labelledby="summary-heading" className="space-y-6">
      <div className="space-y-1">
        <h3 id="summary-heading" className="font-display text-4xl">
          {`Last ${String(REVIEW_RANGE_DAYS)} days`}
        </h3>
        <p className="text-xs text-muted">
          {`${formatDayLabel(range.from)} – ${formatDayLabel(range.to)} · ${range.tz}`}
        </p>
        {range.fellBack && (
          <p role="status" className="text-sm text-warm">
            {`Your browser's time zone could not be used, so days are shown in ${range.tz}.`}
          </p>
        )}
      </div>
      {body}
    </section>
  );
}
