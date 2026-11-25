import { describe, expect, it } from 'vitest';

import { focusSessionInsightsQuerySchema, INSIGHTS_TOP_TASKS } from './insights';
import { DAILY_GOAL_SECONDS, updateMeRequestSchema, userViewSchema } from './user';

describe('focusSessionInsightsQuerySchema', () => {
  it('takes the summary range rules: at most 366 days, from not after to, a real zone', () => {
    expect(
      focusSessionInsightsQuerySchema.safeParse({ from: '2026-01-01', to: '2027-01-01', tz: 'UTC' })
        .success,
    ).toBe(true);
    expect(
      focusSessionInsightsQuerySchema.safeParse({ from: '2026-01-01', to: '2027-01-02', tz: 'UTC' })
        .success,
    ).toBe(false);
    expect(
      focusSessionInsightsQuerySchema.safeParse({ from: '2026-02-02', to: '2026-02-01', tz: 'UTC' })
        .success,
    ).toBe(false);
    expect(
      focusSessionInsightsQuerySchema.safeParse({ from: '2026-01-01', to: '2026-01-02', tz: 'PST' })
        .success,
    ).toBe(false);
  });

  it('lists at most ten tasks', () => {
    expect(INSIGHTS_TOP_TASKS).toBe(10);
  });
});

describe('updateMeRequestSchema', () => {
  it('accepts the goal within its bounds only, and no unknown setting', () => {
    expect(updateMeRequestSchema.safeParse({ dailyGoalSeconds: 3_600 }).success).toBe(true);
    expect(
      updateMeRequestSchema.safeParse({ dailyGoalSeconds: DAILY_GOAL_SECONDS.min }).success,
    ).toBe(true);
    expect(
      updateMeRequestSchema.safeParse({ dailyGoalSeconds: DAILY_GOAL_SECONDS.max }).success,
    ).toBe(true);
    expect(updateMeRequestSchema.safeParse({ dailyGoalSeconds: 299 }).success).toBe(false);
    expect(updateMeRequestSchema.safeParse({ dailyGoalSeconds: 43_201 }).success).toBe(false);
    expect(updateMeRequestSchema.safeParse({ dailyGoalSeconds: 60.5 }).success).toBe(false);
    expect(updateMeRequestSchema.safeParse({}).success).toBe(false);
    expect(updateMeRequestSchema.safeParse({ email: 'x@example.com' }).success).toBe(false);
  });

  it('accepts the profile settings within their rules (ST1–ST3)', () => {
    expect(updateMeRequestSchema.parse({ displayName: '  Ada  ' }).displayName).toBe('Ada');
    expect(updateMeRequestSchema.safeParse({ displayName: '   ' }).success).toBe(false);
    expect(updateMeRequestSchema.safeParse({ avatarPreset: 'owl' }).success).toBe(true);
    expect(updateMeRequestSchema.safeParse({ avatarPreset: null }).success).toBe(true);
    expect(updateMeRequestSchema.safeParse({ avatarPreset: 'dragon' }).success).toBe(false);
    expect(updateMeRequestSchema.safeParse({ defaultSessionSeconds: 2_400 }).success).toBe(true);
    for (const seconds of [59, 14_460, 1_530]) {
      expect(updateMeRequestSchema.safeParse({ defaultSessionSeconds: seconds }).success).toBe(
        false,
      );
    }
  });
});

describe('userViewSchema dailyGoalSeconds', () => {
  const user = {
    id: '018f8f3e-0f1a-7c2b-9f4a-2f1b6c9d0e11',
    email: 'person@example.com',
    emailVerified: false,
    displayName: 'Ada',
    avatarUrl: null,
    currentTaskId: null,
    identities: [],
  };

  it('accepts a missing goal (older fixtures) and keeps a present one', () => {
    expect(userViewSchema.parse(user).dailyGoalSeconds).toBeUndefined();
    expect(userViewSchema.parse({ ...user, dailyGoalSeconds: 3_600 }).dailyGoalSeconds).toBe(3_600);
  });
});
