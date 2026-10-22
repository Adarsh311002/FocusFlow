import { formatDayLabel, formatDuration } from './review-format';
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
    body = <p className="text-slate-600">Loading your summary…</p>;
  } else if (summary.isError) {
    body = (
      <p role="alert" className="text-sm text-red-700">
        {reviewErrorMessage(summary.error)}
      </p>
    );
  } else {
    const data = summary.data;
    const nothingYet = data.completedCount === 0 && data.totalFocusedSeconds === 0;
    body = (
      <div className="space-y-4">
        <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
          <div className="rounded border border-slate-200 p-3">
            <dt className="text-slate-600">Completed sessions</dt>
            <dd className="text-lg font-semibold">{data.completedCount}</dd>
          </div>
          <div className="rounded border border-slate-200 p-3">
            <dt className="text-slate-600">Completed focus time</dt>
            <dd className="text-lg font-semibold">
              {formatDuration(data.completedFocusedSeconds)}
            </dd>
          </div>
          <div className="rounded border border-slate-200 p-3">
            <dt className="text-slate-600">Total focus time (incl. stopped and abandoned)</dt>
            <dd className="text-lg font-semibold">{formatDuration(data.totalFocusedSeconds)}</dd>
          </div>
        </dl>
        {nothingYet && (
          <p className="text-slate-600">No finished focus sessions in this period yet.</p>
        )}
        <table className="w-full text-left text-sm">
          <caption className="mb-1 text-left text-slate-600">Focus time per day</caption>
          <thead>
            <tr className="border-b border-slate-200">
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
              <tr key={day.date} className="border-b border-slate-100">
                <th scope="row" className="py-1 font-normal">
                  <time dateTime={day.date}>{formatDayLabel(day.date)}</time>
                </th>
                <td className="py-1">{formatDuration(day.completedFocusedSeconds)}</td>
                <td className="py-1">{formatDuration(day.totalFocusedSeconds)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <section aria-labelledby="summary-heading" className="space-y-3">
      <div className="space-y-1">
        <h3 id="summary-heading" className="text-base font-semibold">
          {`Last ${String(REVIEW_RANGE_DAYS)} days`}
        </h3>
        <p className="text-xs text-slate-500">
          {`${formatDayLabel(range.from)} – ${formatDayLabel(range.to)} · ${range.tz}`}
        </p>
        {range.fellBack && (
          <p role="status" className="text-sm text-amber-800">
            {`Your browser's time zone could not be used, so days are shown in ${range.tz}.`}
          </p>
        )}
      </div>
      {body}
    </section>
  );
}
