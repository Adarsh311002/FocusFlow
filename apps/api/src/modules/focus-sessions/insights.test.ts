import { describe, expect, it } from 'vitest';

import {
  buildInsights,
  computeStreak,
  createLocalMomentFormatter,
  previousPeriod,
} from './insights.js';
import type { InsightMinute } from './review-queries.js';

const minute = (iso: string, extra: Partial<InsightMinute> = {}): InsightMinute => ({
  minuteStartMs: Date.parse(iso),
  taskId: null,
  isRoom: false,
  completedCount: 1,
  abandonedCount: 0,
  completedFocusedSeconds: 1_500,
  totalFocusedSeconds: 1_500,
  doneCount: 0,
  progressCount: 0,
  stuckCount: 0,
  qualitySum: 0,
  qualityCount: 0,
  deepCount: 0,
  deepCompletedCount: 0,
  deepBrokenCount: 0,
  deepDistractionFreeCount: 0,
  deepDistractions: 0,
  ...extra,
});

const run = (
  query: { from: string; to: string; tz: string },
  minutes: InsightMinute[],
  options: { completed?: number[]; nowMs?: number; goal?: number; deepRun?: number } = {},
) =>
  buildInsights({
    query,
    minutes,
    completedMinutes:
      options.completed ?? minutes.filter((m) => m.completedCount > 0).map((m) => m.minuteStartMs),
    dailyGoalSeconds: options.goal ?? 3_000,
    deepUnbrokenRun: options.deepRun ?? 0,
    nowMs: options.nowMs ?? Date.parse('2025-06-30T12:00:00Z'),
    labelsOf: () => Promise.resolve([]),
  });

describe('createLocalMomentFormatter', () => {
  it('reads date, weekday (Monday = 0) and hour in the zone', () => {
    const local = createLocalMomentFormatter('Asia/Kolkata');
    // 2025-06-30 is a Monday; 20:00Z is 01:30 on Tuesday in Kolkata.
    expect(local(Date.parse('2025-06-30T20:00:00Z'))).toEqual({
      date: '2025-07-01',
      weekday: 1,
      hour: 1,
    });
    expect(createLocalMomentFormatter('UTC')(Date.parse('2025-07-06T00:00:00Z'))).toEqual({
      date: '2025-07-06',
      weekday: 6,
      hour: 0,
    });
  });

  it('shows local midnight as hour 0, not 24', () => {
    const local = createLocalMomentFormatter('America/New_York');
    expect(local(Date.parse('2025-01-15T05:00:00Z'))).toMatchObject({
      date: '2025-01-15',
      hour: 0,
    });
  });

  it('follows daylight saving: the same UTC time lands on different local hours', () => {
    const local = createLocalMomentFormatter('Europe/Berlin');
    expect(local(Date.parse('2025-01-15T12:00:00Z')).hour).toBe(13);
    expect(local(Date.parse('2025-07-15T12:00:00Z')).hour).toBe(14);
  });
});

describe('computeStreak', () => {
  const dates = (...list: string[]) => new Set(list);

  it('counts consecutive days ending today', () => {
    expect(computeStreak(dates('2025-06-28', '2025-06-29', '2025-06-30'), '2025-06-30')).toEqual({
      current: 3,
      longest: 3,
      todayCompleted: true,
    });
  });

  it('keeps the streak alive until the day ends: yesterday counts when today has none yet', () => {
    expect(computeStreak(dates('2025-06-28', '2025-06-29'), '2025-06-30')).toEqual({
      current: 2,
      longest: 2,
      todayCompleted: false,
    });
  });

  it('is 0 when the last completed day is older than yesterday, and tracks the longest run', () => {
    expect(
      computeStreak(dates('2025-06-01', '2025-06-02', '2025-06-03', '2025-06-10'), '2025-06-30'),
    ).toEqual({ current: 0, longest: 3, todayCompleted: false });
    expect(computeStreak(dates(), '2025-06-30')).toEqual({
      current: 0,
      longest: 0,
      todayCompleted: false,
    });
  });

  it('crosses month, year and leap-day boundaries', () => {
    expect(
      computeStreak(
        dates('2023-12-31', '2024-01-01', '2024-02-28', '2024-02-29', '2024-03-01'),
        '2024-03-01',
      ),
    ).toMatchObject({ current: 3, longest: 3 });
  });
});

describe('previousPeriod', () => {
  it('is the equal-length span ending the day before the range', () => {
    expect(previousPeriod({ from: '2025-03-10', to: '2025-03-16' })).toEqual({
      from: '2025-03-03',
      to: '2025-03-09',
      dayCount: 7,
    });
    expect(previousPeriod({ from: '2025-03-01', to: '2025-03-01' })).toEqual({
      from: '2025-02-28',
      to: '2025-02-28',
      dayCount: 1,
    });
  });
});

describe('buildInsights', () => {
  it('counts a session on its local start date and fills every day', async () => {
    // 23:30 in New York on 06-29 is 03:30Z on 06-30: local date 06-29, a Sunday, hour 23.
    const result = await run({ from: '2025-06-29', to: '2025-06-30', tz: 'America/New_York' }, [
      minute('2025-06-30T03:30:00Z'),
    ]);
    expect(result.days.map((d) => [d.date, d.sessionCount])).toEqual([
      ['2025-06-29', 1],
      ['2025-06-30', 0],
    ]);
    const cell = result.heatmap.find((c) => c.sessionCount > 0);
    expect(cell).toEqual({ weekday: 6, hour: 23, sessionCount: 1, totalFocusedSeconds: 1_500 });
    expect(result.heatmap).toHaveLength(168);
    expect(result.heatmap[0]).toMatchObject({ weekday: 0, hour: 0 });
  });

  it('handles the spring-forward day: no local 02:xx exists, and the date stays whole', async () => {
    // US DST starts 2025-03-09 at 02:00 local; 06:59Z is 01:59 EST, 07:00Z is 03:00 EDT.
    const result = await run({ from: '2025-03-09', to: '2025-03-09', tz: 'America/New_York' }, [
      minute('2025-03-09T06:59:00Z'),
      minute('2025-03-09T07:00:00Z'),
    ]);
    const hours = result.heatmap.filter((c) => c.sessionCount > 0).map((c) => c.hour);
    expect(hours).toEqual([1, 3]);
    expect(result.heatmap.find((c) => c.hour === 2 && c.sessionCount > 0)).toBeUndefined();
    expect(result.days[0]?.sessionCount).toBe(2);
  });

  it('handles the fall-back day: the repeated local hour merges into one heatmap cell', async () => {
    // US DST ends 2025-11-02 at 02:00 EDT -> 01:00 EST; both 05:30Z and 06:30Z are 01:30 local.
    const result = await run({ from: '2025-11-02', to: '2025-11-02', tz: 'America/New_York' }, [
      minute('2025-11-02T05:30:00Z'),
      minute('2025-11-02T06:30:00Z'),
    ]);
    const cell = result.heatmap.find((c) => c.hour === 1 && c.sessionCount > 0);
    expect(cell).toMatchObject({ weekday: 6, sessionCount: 2, totalFocusedSeconds: 3_000 });
    expect(result.days[0]?.sessionCount).toBe(2);
  });

  it('puts a half-hour zone on the right local date and hour', async () => {
    // 18:30Z on 06-29 is 00:00 on 06-30 in Kolkata (+05:30).
    const result = await run({ from: '2025-06-29', to: '2025-06-30', tz: 'Asia/Kolkata' }, [
      minute('2025-06-29T18:29:00Z'),
      minute('2025-06-29T18:30:00Z'),
    ]);
    expect(result.days.map((d) => d.sessionCount)).toEqual([1, 1]);
    expect(
      result.heatmap.filter((c) => c.sessionCount > 0).map((c) => [c.weekday, c.hour]),
    ).toEqual([
      [0, 0],
      [6, 23],
    ]);
  });

  it('computes the completion rate, the goal progress and the solo/room split', async () => {
    const result = await run(
      { from: '2025-06-30', to: '2025-06-30', tz: 'UTC' },
      [
        minute('2025-06-30T09:00:00Z', {
          completedCount: 2,
          completedFocusedSeconds: 3_000,
          totalFocusedSeconds: 3_000,
        }),
        minute('2025-06-30T10:00:00Z', {
          isRoom: true,
          completedCount: 0,
          abandonedCount: 2,
          completedFocusedSeconds: 0,
          totalFocusedSeconds: 600,
        }),
      ],
      { goal: 3_600 },
    );
    expect(result.totals).toMatchObject({
      sessionCount: 4,
      completedCount: 2,
      abandonedCount: 2,
      completionRate: 0.5,
      totalFocusedSeconds: 3_600,
    });
    expect(result.days[0]).toMatchObject({ goalProgress: 1, goalMet: true });
    expect(result.goalDaysMet).toBe(1);
    expect(result.split.solo).toEqual({
      sessionCount: 2,
      completedCount: 2,
      totalFocusedSeconds: 3_000,
    });
    expect(result.split.room).toEqual({
      sessionCount: 2,
      completedCount: 0,
      totalFocusedSeconds: 600,
    });
  });

  it('reports a null completion rate when nothing ended', async () => {
    const result = await run({ from: '2025-06-30', to: '2025-06-30', tz: 'UTC' }, []);
    expect(result.totals.completionRate).toBeNull();
    expect(result.days[0]).toMatchObject({ goalProgress: 0, goalMet: false });
    expect(result.comparison.delta.completionRate).toBeNull();
    expect(result.comparison.delta.totalFocusedSecondsChange).toBeNull();
  });

  it('compares with the previous equal-length period', async () => {
    const result = await run({ from: '2025-06-24', to: '2025-06-30', tz: 'UTC' }, [
      minute('2025-06-26T09:00:00Z', {
        completedCount: 3,
        completedFocusedSeconds: 4_500,
        totalFocusedSeconds: 4_500,
      }),
      minute('2025-06-18T09:00:00Z', {
        completedCount: 2,
        completedFocusedSeconds: 3_000,
        totalFocusedSeconds: 3_000,
      }),
      // Older than the previous period: ignored.
      minute('2025-06-10T09:00:00Z'),
    ]);
    expect(result.comparison).toMatchObject({
      previousFrom: '2025-06-17',
      previousTo: '2025-06-23',
      previous: { completedCount: 2, totalFocusedSeconds: 3_000, completionRate: 1 },
      delta: {
        completedCount: 1,
        totalFocusedSeconds: 1_500,
        totalFocusedSecondsChange: 0.5,
        completionRate: 0,
      },
    });
    expect(result.totals.completedCount).toBe(3);
  });

  it('ranks tasks by focused time, flags deleted ones and folds the tail into otherTasks', async () => {
    const ids = Array.from(
      { length: 12 },
      (_, index) => `018f8f3e-0f1a-7c2b-9f4a-2f1b6c9d00${String(10 + index)}`,
    );
    const minutes = ids.map((taskId, index) =>
      minute(`2025-06-30T${String(8 + (index % 10)).padStart(2, '0')}:00:00Z`, {
        taskId,
        completedCount: 1,
        completedFocusedSeconds: 60 * (index + 1),
        totalFocusedSeconds: 60 * (index + 1),
      }),
    );
    minutes.push(
      minute('2025-06-30T20:00:00Z', { totalFocusedSeconds: 30, completedFocusedSeconds: 30 }),
    );
    const result = await buildInsights({
      query: { from: '2025-06-30', to: '2025-06-30', tz: 'UTC' },
      minutes,
      completedMinutes: [],
      dailyGoalSeconds: 3_000,
      deepUnbrokenRun: 0,
      nowMs: Date.parse('2025-06-30T12:00:00Z'),
      labelsOf: (taskIds) =>
        Promise.resolve(
          taskIds.map((id, index) => ({ id, title: `Task ${id.slice(-2)}`, deleted: index === 0 })),
        ),
    });
    expect(result.tasks).toHaveLength(10);
    expect(result.tasks[0]).toMatchObject({ totalFocusedSeconds: 720, deleted: true });
    expect(result.tasks.map((t) => t.totalFocusedSeconds)).toEqual(
      [...result.tasks.map((t) => t.totalFocusedSeconds)].sort((a, b) => b - a),
    );
    expect(result.otherTasks).toMatchObject({ taskCount: 2, totalFocusedSeconds: 60 + 120 });
    expect(result.noTask).toMatchObject({ sessionCount: 1, totalFocusedSeconds: 30 });
  });

  it('counts check-ins of sessions with an intention only, in the range only (CI5)', async () => {
    const task = '01900000-0000-7000-8000-000000000001';
    const result = await run({ from: '2025-06-30', to: '2025-06-30', tz: 'UTC' }, [
      // Five ended sessions with a task: two done, one progress, one stuck, one never checked in.
      minute('2025-06-30T09:00:00Z', {
        taskId: task,
        completedCount: 3,
        abandonedCount: 2,
        doneCount: 2,
        progressCount: 1,
        stuckCount: 1,
      }),
      // Without a task: never part of the intention figures, even when checked in.
      minute('2025-06-30T10:00:00Z', { doneCount: 1 }),
      // The previous period: ignored.
      minute('2025-06-29T10:00:00Z', { taskId: task, doneCount: 1 }),
    ]);
    expect(result.checkIns).toEqual({
      withIntention: 5,
      done: 2,
      progress: 1,
      stuck: 1,
      unrecorded: 1,
    });
  });

  it('reports zero check-ins when nothing had an intention', async () => {
    const result = await run({ from: '2025-06-30', to: '2025-06-30', tz: 'UTC' }, []);
    expect(result.checkIns).toEqual({
      withIntention: 0,
      done: 0,
      progress: 0,
      stuck: 0,
      unrecorded: 0,
    });
  });

  it('averages quality ratings overall and per local start hour (FQ3)', async () => {
    const result = await run({ from: '2025-06-30', to: '2025-06-30', tz: 'Asia/Kolkata' }, [
      // 03:30 UTC is 09:00 in Kolkata: two ratings, 5 and 4.
      minute('2025-06-30T03:30:00Z', { qualitySum: 9, qualityCount: 2 }),
      // 09:30 UTC is 15:00: one rating of 2.
      minute('2025-06-30T09:30:00Z', { qualitySum: 2, qualityCount: 1 }),
      // Unrated.
      minute('2025-06-30T10:30:00Z'),
    ]);
    expect(result.quality.ratedCount).toBe(3);
    expect(result.quality.average).toBe(3.67);
    expect(result.quality.byHour[9]).toEqual({ ratedCount: 2, average: 4.5 });
    expect(result.quality.byHour[15]).toEqual({ ratedCount: 1, average: 2 });
    expect(result.quality.byHour[16]).toEqual({ ratedCount: 0, average: null });
  });

  it('sums Deep Focus sessions of the range and passes the unbroken run through (DF6)', async () => {
    const result = await run(
      { from: '2025-06-30', to: '2025-06-30', tz: 'UTC' },
      [
        minute('2025-06-30T09:00:00Z', {
          deepCount: 2,
          deepCompletedCount: 1,
          deepBrokenCount: 1,
          deepDistractionFreeCount: 1,
          deepDistractions: 3,
        }),
        // The previous period is not counted.
        minute('2025-06-29T09:00:00Z', { deepCount: 5, deepBrokenCount: 5 }),
      ],
      { deepRun: 4 },
    );
    expect(result.deepFocus).toEqual({
      sessions: 2,
      completed: 1,
      broken: 1,
      distractionFree: 1,
      distractions: 3,
      unbrokenRun: 4,
    });
  });
});
