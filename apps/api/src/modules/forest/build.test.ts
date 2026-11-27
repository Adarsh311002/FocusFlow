import { describe, expect, it } from 'vitest';

import { buildForest, type ForestSession, plantKindOf } from './build.js';

let seq = 0;
const id = () => {
  seq += 1;
  return `01900000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
};

/** A completed 25-minute session that started at `iso`. */
const session = (iso: string, extra: Partial<ForestSession> = {}): ForestSession => {
  const startedAtMs = Date.parse(iso);
  return {
    id: id(),
    startedAtMs,
    endedAtMs: startedAtMs + 1_500_000,
    status: 'completed',
    plannedSeconds: 1_500,
    focusedSeconds: 1_500,
    isRoom: false,
    outcome: null,
    quality: null,
    ...extra,
  };
};

const NOW = Date.parse('2026-11-25T12:00:00Z');
const run = (sessions: ForestSession[], goal = 7_200) =>
  buildForest({ sessions, tz: 'UTC', dailyGoalSeconds: goal, nowMs: NOW });

const milestone = (result: ReturnType<typeof run>, name: string) =>
  result.milestones.find((entry) => entry.id === name);

describe('plantKindOf (GF2)', () => {
  it('sizes a completed session by its planned length', () => {
    expect(plantKindOf(session('2026-11-25T08:00:00Z', { plannedSeconds: 900 }))).toBe('sprout');
    expect(plantKindOf(session('2026-11-25T08:00:00Z', { plannedSeconds: 1_500 }))).toBe('sapling');
    expect(plantKindOf(session('2026-11-25T08:00:00Z', { plannedSeconds: 3_000 }))).toBe('tree');
  });

  it('grows a sprout from a stopped session only with ten minutes of real focus', () => {
    const stopped = (focusedSeconds: number) =>
      session('2026-11-25T08:00:00Z', { status: 'abandoned', focusedSeconds });
    expect(plantKindOf(stopped(600))).toBe('sprout');
    expect(plantKindOf(stopped(599))).toBeNull();
  });
});

describe('buildForest', () => {
  it('starts empty and quiet, never below the resting vitality', () => {
    const result = run([]);
    expect(result.totals.plants).toBe(0);
    expect(result.vitality).toBe(0.15);
    expect(result.milestones.every((entry) => entry.unlockedAt === null)).toBe(true);
  });

  it('blooms done check-ins and glows deep ones', () => {
    const result = run([
      session('2026-11-24T08:00:00Z', { outcome: 'done' }),
      session('2026-11-24T10:00:00Z', { quality: 4 }),
      session('2026-11-24T12:00:00Z', { quality: 3 }),
    ]);
    expect(result.plants.map((plant) => [plant.bloom, plant.glow])).toEqual([
      [true, false],
      [false, true],
      [false, false],
    ]);
    expect(result.totals).toMatchObject({ intentionsDone: 1, deepSessions: 1 });
  });

  it('unlocks a milestone at the end of the session that reached it', () => {
    const first = session('2026-11-20T08:00:00Z');
    const result = run([first, session('2026-11-21T08:00:00Z')]);
    expect(milestone(result, 'first-seed')?.unlockedAt).toBe(
      new Date(first.endedAtMs).toISOString(),
    );
    expect(milestone(result, 'ten-sessions')).toMatchObject({ current: 2, unlockedAt: null });
  });

  it('counts a week streak over consecutive local days, and the current one up to today', () => {
    const days = Array.from({ length: 7 }, (_, index) =>
      session(`2026-11-${String(10 + index)}T08:00:00Z`),
    );
    const result = run([...days, session('2026-11-24T08:00:00Z'), session('2026-11-25T08:00:00Z')]);
    expect(milestone(result, 'week-streak')?.unlockedAt).toBe(
      new Date(days[6]?.endedAtMs ?? 0).toISOString(),
    );
    expect(result.totals).toMatchObject({ longestStreak: 7, currentStreak: 2 });
  });

  it('brings in the monkey with a completed room session and the sloth with deep flow', () => {
    const result = run([
      session('2026-11-24T08:00:00Z', { isRoom: true, status: 'abandoned', focusedSeconds: 900 }),
      session('2026-11-24T09:00:00Z', { quality: 5 }),
    ]);
    expect(milestone(result, 'together')?.unlockedAt).toBeNull();
    expect(milestone(result, 'deep-flow')?.unlockedAt).not.toBeNull();
  });

  it('measures vitality on the last seven days against the goal, capped at 1', () => {
    const recent = run([session('2026-11-25T08:00:00Z', { focusedSeconds: 1_500 })], 600);
    expect(recent.vitality).toBe(0.357);
    const old = run([session('2026-11-01T08:00:00Z')], 600);
    expect(old.vitality).toBe(0.15);
    const lots = run(
      Array.from({ length: 7 }, (_, index) =>
        session(`2026-11-${String(19 + index)}T08:00:00Z`, {
          plannedSeconds: 14_400,
          focusedSeconds: 14_400,
        }),
      ),
    );
    expect(lots.vitality).toBe(1);
  });

  it('counts hours toward the hour milestones from every ended session', () => {
    const result = run(
      Array.from({ length: 4 }, (_, index) =>
        session(`2026-11-2${String(index)}T08:00:00Z`, {
          plannedSeconds: 10_800,
          focusedSeconds: 10_800,
        }),
      ),
    );
    expect(milestone(result, 'ten-hours')).toMatchObject({ current: 10, target: 10 });
    expect(milestone(result, 'ten-hours')?.unlockedAt).not.toBeNull();
    expect(milestone(result, 'hundred-hours')).toMatchObject({ current: 12, unlockedAt: null });
  });
});
