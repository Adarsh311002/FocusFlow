import type { ForestResponse } from '@focus-flow/contracts';
import { Link } from '@tanstack/react-router';

import { Eyebrow } from '../../ui/primitives';
import { formatDuration } from '../review/review-format';
import { CREATURE, MILESTONE_TEXT, useForest } from './forest-data';
import { ForestScene } from './forest-scene';

// `/forest` (GF6): the forest, what grew it, and the creatures still to meet.

function moodOf(vitality: number): string {
  if (vitality >= 0.8) {
    return 'Lush and humming. You have been here a lot this week.';
  }
  if (vitality >= 0.4) {
    return 'Growing steadily. Light comes through the canopy.';
  }
  return 'Quiet and resting. One session wakes it up again.';
}

function Summary({ forest }: { readonly forest: ForestResponse }) {
  const { totals } = forest;
  const met = forest.milestones.filter((milestone) => milestone.unlockedAt !== null).length;
  return (
    <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
      {[
        ['Plants', String(totals.plants)],
        ['Focused', formatDuration(totals.focusedSeconds)],
        ['In bloom', String(totals.intentionsDone)],
        ['Creatures', `${String(met)}/${String(forest.milestones.length)}`],
      ].map(([label, value]) => (
        <div key={label} className="rounded-2xl border border-line bg-surface p-4">
          <dt className="text-[10px] tracking-[0.3em] text-muted uppercase">{label}</dt>
          <dd className="font-display mt-1 text-4xl">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Milestones({ forest }: { readonly forest: ForestResponse }) {
  return (
    <section aria-labelledby="forest-milestones" className="space-y-4">
      <h3 id="forest-milestones" className="font-display text-4xl">
        Who lives here
      </h3>
      <ul className="grid gap-3 md:grid-cols-2">
        {forest.milestones.map((milestone) => {
          const text = MILESTONE_TEXT[milestone.id];
          const creature = CREATURE[milestone.creature];
          const met = milestone.unlockedAt !== null;
          return (
            <li
              key={milestone.id}
              aria-label={`${text.title}, ${met ? 'reached' : 'not yet'}`}
              className={`flex items-center gap-4 rounded-2xl border p-4 ${
                met ? 'border-focus/40 bg-focus/10' : 'border-line bg-surface'
              }`}
            >
              <span
                aria-hidden="true"
                className={`grid h-14 w-14 shrink-0 place-items-center rounded-full text-3xl ${
                  met ? 'bg-surface-strong' : 'bg-line grayscale opacity-50'
                }`}
              >
                {met ? creature.emoji : '?'}
              </span>
              <div className="min-w-0 flex-1 space-y-1.5">
                <p className="font-medium">{text.title}</p>
                <p className="text-sm text-muted">
                  {met
                    ? `${creature.name} moved in on ${new Date(milestone.unlockedAt ?? '').toLocaleDateString()}.`
                    : text.description}
                </p>
                {!met && (
                  <div className="space-y-1">
                    <div className="h-1.5 overflow-hidden rounded-full bg-line">
                      <div
                        className="h-full rounded-full bg-focus"
                        style={{
                          width: `${String((milestone.current / milestone.target) * 100)}%`,
                        }}
                      />
                    </div>
                    <p className="text-xs text-muted">
                      {`${String(milestone.current)} of ${String(milestone.target)} ${text.unit}`}
                    </p>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function ForestPage() {
  const forest = useForest();
  return (
    <div className="space-y-10">
      <div>
        <Eyebrow>( Your forest )</Eyebrow>
        <h2 className="font-display mt-3 text-6xl md:text-7xl">
          It grows <em className="text-focus">with you.</em>
        </h2>
        <p className="mt-4 max-w-2xl text-muted">
          Every session you complete plants something: longer ones grow taller. Intentions you
          finish bloom, deep sessions glow, and milestones bring new creatures. It never dies; a
          quiet week only lets it rest.
        </p>
      </div>
      {forest.isPending && <p className="text-muted">Walking into the forest…</p>}
      {forest.isError && (
        <p role="alert" className="text-sm text-danger">
          The forest could not be read just now. Try again in a moment.
        </p>
      )}
      {forest.isSuccess && (
        <>
          <ForestScene
            plants={forest.data.plants}
            creatures={forest.data.milestones
              .filter((milestone) => milestone.unlockedAt !== null)
              .map((milestone) => milestone.creature)}
            vitality={forest.data.vitality}
          />
          <p role="status" className="text-sm text-muted">
            {forest.data.totals.plants === 0
              ? 'Nothing planted yet. Complete a session and the first seed goes in.'
              : moodOf(forest.data.vitality)}
          </p>
          <Summary forest={forest.data} />
          <Milestones forest={forest.data} />
          {forest.data.totals.plants === 0 && (
            <Link to="/dashboard" className="text-focus underline underline-offset-4">
              Start a session
            </Link>
          )}
        </>
      )}
    </div>
  );
}
