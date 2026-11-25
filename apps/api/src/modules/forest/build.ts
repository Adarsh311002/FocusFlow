import {
  addCalendarDays,
  FOREST_MAX_PLANTS,
  type ForestCreature,
  type ForestMilestone,
  type ForestMilestoneId,
  type ForestPlant,
  type ForestResponse,
  forestResponseSchema,
  type PlantKind,
} from '@focus-flow/contracts';

import { computeStreak, createLocalMomentFormatter } from '../focus-sessions/insights.js';

// "Grow your forest" (GF1–GF4): the pure part. Everything is derived from ended sessions, in
// the order they ended, so a milestone's unlock time is the end of the session that reached it.

export type ForestSession = {
  readonly id: string;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly status: 'completed' | 'abandoned';
  readonly plannedSeconds: number;
  readonly focusedSeconds: number;
  readonly isRoom: boolean;
  readonly outcome: 'done' | 'progress' | 'stuck' | null;
  readonly quality: number | null;
};

/** GF2: a stopped session grows a sprout when at least this much focus went into it. */
export const SPROUT_MIN_FOCUSED_SECONDS = 600;

/** GF2: completed sessions grow by their planned length; real effort that stopped, a sprout. */
export const plantKindOf = (session: ForestSession): PlantKind | null => {
  if (session.status === 'abandoned') {
    return session.focusedSeconds >= SPROUT_MIN_FOCUSED_SECONDS ? 'sprout' : null;
  }
  if (session.plannedSeconds >= 50 * 60) {
    return 'tree';
  }
  return session.plannedSeconds >= 25 * 60 ? 'sapling' : 'sprout';
};

type MilestoneRule = {
  readonly id: ForestMilestoneId;
  readonly creature: ForestCreature;
  readonly target: number;
};

/** GF3: in the order they are usually reached. */
export const MILESTONES: readonly MilestoneRule[] = [
  { id: 'first-seed', creature: 'firefly', target: 1 },
  { id: 'ten-sessions', creature: 'frog', target: 10 },
  { id: 'ten-hours', creature: 'butterfly', target: 10 },
  { id: 'week-streak', creature: 'toucan', target: 7 },
  { id: 'intentions-25', creature: 'owl', target: 25 },
  { id: 'deep-flow', creature: 'sloth', target: 1 },
  { id: 'together', creature: 'monkey', target: 1 },
  { id: 'hundred-hours', creature: 'jaguar', target: 100 },
];

type Progress = {
  completed: number;
  focusedSeconds: number;
  longestStreak: number;
  intentionsDone: number;
  deepFlow: number;
  together: number;
};

const valueOf = (id: ForestMilestoneId, progress: Progress): number => {
  switch (id) {
    case 'first-seed':
    case 'ten-sessions':
      return progress.completed;
    case 'ten-hours':
    case 'hundred-hours':
      return Math.floor((progress.focusedSeconds / 3600) * 10) / 10;
    case 'week-streak':
      return progress.longestStreak;
    case 'intentions-25':
      return progress.intentionsDone;
    case 'deep-flow':
      return progress.deepFlow;
    case 'together':
      return progress.together;
  }
};

export const buildForest = (input: {
  readonly sessions: readonly ForestSession[];
  readonly tz: string;
  readonly dailyGoalSeconds: number;
  readonly nowMs: number;
}): ForestResponse => {
  const localDate = (ms: number) => createLocalMomentFormatter(input.tz)(ms).date;
  const sessions = [...input.sessions].sort(
    (a, b) => a.endedAtMs - b.endedAtMs || a.id.localeCompare(b.id),
  );

  const progress: Progress = {
    completed: 0,
    focusedSeconds: 0,
    longestStreak: 0,
    intentionsDone: 0,
    deepFlow: 0,
    together: 0,
  };
  const unlocked = new Map<ForestMilestoneId, number>();
  // Streak runs by local start date of completed sessions (A3's rule), grown as they arrive.
  const runEndingAt = new Map<string, number>();
  const plants: ForestPlant[] = [];
  let deepSessions = 0;

  for (const session of sessions) {
    progress.focusedSeconds += session.focusedSeconds;
    if (session.outcome === 'done') {
      progress.intentionsDone += 1;
    }
    if (session.quality !== null && session.quality >= 4) {
      deepSessions += 1;
    }
    if (session.quality === 5) {
      progress.deepFlow += 1;
    }
    if (session.status === 'completed') {
      progress.completed += 1;
      if (session.isRoom) {
        progress.together += 1;
      }
      const date = localDate(session.startedAtMs);
      if (!runEndingAt.has(date)) {
        const run = (runEndingAt.get(addCalendarDays(date, -1)) ?? 0) + 1;
        runEndingAt.set(date, run);
        progress.longestStreak = Math.max(progress.longestStreak, run);
      }
    }
    const kind = plantKindOf(session);
    if (kind !== null) {
      plants.push({
        id: session.id as ForestPlant['id'],
        kind,
        bloom: session.outcome === 'done',
        glow: session.quality !== null && session.quality >= 4,
        plantedAt: new Date(session.endedAtMs).toISOString(),
      });
    }
    for (const rule of MILESTONES) {
      if (!unlocked.has(rule.id) && valueOf(rule.id, progress) >= rule.target) {
        unlocked.set(rule.id, session.endedAtMs);
      }
    }
  }

  // The streak as of today (A3), over every completed day.
  const today = localDate(input.nowMs);
  const streak = computeStreak(new Set(runEndingAt.keys()), today);

  // GF4: the last 7 local days (today included) against the goal; never below 0.15.
  const weekStart = addCalendarDays(today, -6);
  const recentSeconds = sessions
    .filter((session) => {
      const date = localDate(session.startedAtMs);
      return date >= weekStart && date <= today;
    })
    .reduce((sum, session) => sum + session.focusedSeconds, 0);
  const vitality = Math.min(
    1,
    Math.max(0.15, recentSeconds / Math.max(1, input.dailyGoalSeconds * 7)),
  );

  const milestones: ForestMilestone[] = MILESTONES.map((rule) => {
    const at = unlocked.get(rule.id);
    return {
      id: rule.id,
      creature: rule.creature,
      current: Math.min(valueOf(rule.id, progress), rule.target),
      target: rule.target,
      unlockedAt: at === undefined ? null : new Date(at).toISOString(),
    };
  });

  return forestResponseSchema.parse({
    totals: {
      plants: plants.length,
      completedSessions: progress.completed,
      focusedSeconds: progress.focusedSeconds,
      intentionsDone: progress.intentionsDone,
      deepSessions,
      currentStreak: streak.current,
      longestStreak: streak.longest,
    },
    vitality: Math.round(vitality * 1000) / 1000,
    plants: plants.slice(-FOREST_MAX_PLANTS),
    milestones,
  });
};
