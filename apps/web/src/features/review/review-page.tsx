import { useState } from 'react';

import { currentReviewRange } from './review-range';
import { SessionHistory } from './session-history';
import { SummaryPanel } from './summary-panel';

/**
 * The review step of the loop: how much focus the last days held, then every session.
 * The range is fixed once per visit, so the summary's query key stays stable while the
 * page is open; coming back to the page computes it again.
 */
export function ReviewPage() {
  const [range] = useState(() => currentReviewRange());

  return (
    <section aria-labelledby="review-heading" className="max-w-xl space-y-6">
      <h2 id="review-heading" className="text-base font-semibold">
        Review
      </h2>
      <SummaryPanel range={range} />
      <SessionHistory timeZone={range.tz} />
    </section>
  );
}
