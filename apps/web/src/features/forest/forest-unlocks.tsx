import type { ForestMilestoneId } from '@focus-flow/contracts';
import { Link } from '@tanstack/react-router';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';

import { useAuth } from '../auth/auth-context';
import { CREATURE, MILESTONE_TEXT, useForest } from './forest-data';

// GF6: when a milestone is newly reached, a creature arrives with a gentle note. What was
// already shown is remembered per user in this browser; the first read only remembers, so a
// long history never arrives as a burst of old news.

const SHOW_FOR_MS = 9_000;
const ARRIVE_AFTER_MS = 800;

const seenKey = (userId: string) => `ff-forest-seen:${userId}`;

function readSeen(userId: string): ForestMilestoneId[] | null {
  try {
    const raw = window.localStorage.getItem(seenKey(userId));
    return raw === null ? null : (JSON.parse(raw) as ForestMilestoneId[]);
  } catch {
    return null;
  }
}

function writeSeen(userId: string, ids: readonly ForestMilestoneId[]): void {
  try {
    window.localStorage.setItem(seenKey(userId), JSON.stringify(ids));
  } catch {
    // Only means a creature may be announced once more.
  }
}

export function ForestUnlocks() {
  const { status, user } = useAuth();
  if (status !== 'authenticated' || user === null) {
    return null;
  }
  return <Announcer userId={user.id} />;
}

function Announcer({ userId }: { readonly userId: string }) {
  const forest = useForest();
  // The newly reached milestones, newest first; the note leads with the newest.
  const [arrivals, setArrivals] = useState<readonly ForestMilestoneId[]>([]);
  const arrived = arrivals[0] ?? null;
  const unlocked = (forest.data?.milestones ?? [])
    .filter((milestone) => milestone.unlockedAt !== null)
    .map((milestone) => milestone.id);
  const key = unlocked.join(',');

  useEffect(() => {
    if (!forest.isSuccess) {
      return undefined;
    }
    const seen = readSeen(userId);
    if (seen === null) {
      writeSeen(userId, unlocked);
      return undefined;
    }
    const fresh = unlocked.filter((id) => !seen.includes(id)).reverse();
    if (fresh.length === 0) {
      return undefined;
    }
    // A breath after the page settles, then the creature arrives.
    // Remembered only once shown, so a cancelled timer (a re-run) never loses an arrival.
    const timer = setTimeout(() => {
      writeSeen(userId, unlocked);
      setArrivals(fresh);
    }, ARRIVE_AFTER_MS);
    return () => {
      clearTimeout(timer);
    };
    // `key` stands for `unlocked`: rerun only when the set of reached milestones changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forest.isSuccess, key, userId]);

  useEffect(() => {
    if (arrived === null) {
      return undefined;
    }
    const timer = setTimeout(() => {
      setArrivals([]);
    }, SHOW_FOR_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [arrived]);

  const milestone = forest.data?.milestones.find((entry) => entry.id === arrived);
  return (
    <AnimatePresence>
      {arrived !== null && milestone !== undefined && (
        <motion.div
          role="status"
          initial={{ opacity: 0, y: -16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          className="fixed top-24 left-1/2 z-[70] flex w-[min(92vw,26rem)] -translate-x-1/2 items-center gap-4 rounded-2xl border border-focus/40 bg-canvas-2/95 p-4 shadow-card backdrop-blur-xl"
        >
          <span aria-hidden="true" className="text-4xl">
            {CREATURE[milestone.creature].emoji}
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-medium">{`${CREATURE[milestone.creature].name} moved into your forest`}</p>
            <p className="text-sm text-muted">
              {MILESTONE_TEXT[milestone.id].title}
              {arrivals.length > 1 ? ` · and ${String(arrivals.length - 1)} more` : ''}
            </p>
            <Link
              to="/forest"
              onClick={() => {
                setArrivals([]);
              }}
              className="text-sm text-focus underline underline-offset-4"
            >
              Visit your forest
            </Link>
          </div>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => {
              setArrivals([]);
            }}
            className="text-muted hover:text-ink"
          >
            ×
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
