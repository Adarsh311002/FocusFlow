import { Link } from '@tanstack/react-router';

import { CREATURE, useForest } from './forest-data';

/** GF6: the dashboard's glimpse of the forest, with a way in. */
export function ForestCard() {
  const forest = useForest();
  if (!forest.isSuccess) {
    return null;
  }
  const { totals, milestones } = forest.data;
  const creatures = milestones.filter((milestone) => milestone.unlockedAt !== null);
  const next = milestones.find((milestone) => milestone.unlockedAt === null);
  return (
    <Link
      to="/forest"
      className="group block space-y-2 rounded-2xl border border-line bg-surface p-4 transition hover:border-focus/50"
    >
      <p className="text-xs tracking-[0.3em] text-focus uppercase">Your forest</p>
      <p className="font-display text-2xl">
        {totals.plants === 0
          ? 'Waiting for its first seed'
          : `${String(totals.plants)} ${totals.plants === 1 ? 'plant' : 'plants'} growing`}
      </p>
      <p className="text-sm text-muted">
        <span aria-hidden="true">
          {creatures.map((milestone) => CREATURE[milestone.creature].emoji).join(' ')}
        </span>
        {creatures.length > 0 ? ' · ' : ''}
        {next === undefined
          ? 'Every creature has arrived.'
          : `Next: ${CREATURE[next.creature].name.toLowerCase()} at ${String(next.target)}`}
      </p>
      <span className="text-sm text-focus underline-offset-4 group-hover:underline">Walk in →</span>
    </Link>
  );
}
