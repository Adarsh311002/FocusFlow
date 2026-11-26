import { useState } from 'react';

import { Critter, OwlArt } from '../../ui/jungle/critters';
import { WeeklyReflection } from '../ai/weekly-reflection';
import { InsightsPanel } from './insights-panel';
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
    <section aria-labelledby="review-heading" className="relative space-y-10">
      <Critter kind="owl" className="-top-6 right-[34%] hidden lg:block" bubble="left">
        <OwlArt />
      </Critter>
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <p className="text-xs tracking-[0.3em] text-focus uppercase">( Your rhythm )</p>
          <h2 id="review-heading" className="font-display mt-3 text-6xl md:text-7xl">
            Review
          </h2>
        </div>
        <p className="font-display max-w-sm text-2xl text-muted">
          See your days <em className="text-focus">add up.</em>
        </p>
      </div>
      <div className="rounded-[2.5rem] border border-line bg-surface p-6 shadow-card backdrop-blur-xl md:p-10">
        <SummaryPanel range={range} />
      </div>
      <div className="rounded-[2.5rem] border border-line bg-surface p-6 shadow-card backdrop-blur-xl md:p-10">
        <InsightsPanel />
      </div>
      <div className="rounded-[2.5rem] border border-line bg-surface p-6 shadow-card backdrop-blur-xl md:p-10">
        <WeeklyReflection />
      </div>
      <div className="grid gap-10 lg:grid-cols-12">
        <div className="lg:col-span-4">
          <p className="text-xs tracking-[0.3em] text-focus uppercase">( Every session )</p>
          <p className="font-display mt-3 text-3xl leading-snug text-muted">
            Each one a ring in the tree.{' '}
            <em className="text-ink">What you chose, and how long you stayed.</em>
          </p>
        </div>
        <div className="lg:col-span-8">
          <SessionHistory timeZone={range.tz} />
        </div>
      </div>
    </section>
  );
}
