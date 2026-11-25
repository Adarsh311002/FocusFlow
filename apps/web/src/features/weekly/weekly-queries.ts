import {
  addCalendarDays,
  createCalendarDateFormatter,
  type TaskId,
  type WeeklyPrioritiesResponse,
  weeklyPrioritiesResponseSchema,
  weeklyPriorityPaths,
} from '@focus-flow/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { authedApiRequest } from '../auth/auth-client';
import { useAuth } from '../auth/auth-context';
import { readBrowserTimeZone, resolveTimeZone } from '../review/review-range';
import { taskKeys } from '../tasks/task-queries';

// Weekly priorities and the weekly review (WR3–WR5). The week is the Monday of the local
// week in the browser's time zone (WR3), the same zone as the rest of Review.

const NO_USER = 'signed-out';

/** The local calendar date's Monday. `date` is YYYY-MM-DD. */
export function mondayOf(date: string): string {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addCalendarDays(date, -((weekday + 6) % 7));
}

export type WeekRange = { readonly week: string; readonly tz: string };

/** This week's Monday and the zone, read once per call. */
export function currentWeek(nowMs: number = Date.now()): WeekRange {
  const tz = resolveTimeZone(readBrowserTimeZone()).timeZone;
  return { week: mondayOf(createCalendarDateFormatter(tz)(nowMs)), tz };
}

export const weeklyKeys = {
  all: (userId: string) => ['weekly-priorities', userId] as const,
  week: (userId: string, week: string) => ['weekly-priorities', userId, week] as const,
};

export function useWeeklyPriorities(week: string) {
  const userId = useAuth().user?.id ?? NO_USER;
  return useQuery({
    queryKey: weeklyKeys.week(userId, week),
    queryFn: () =>
      authedApiRequest(
        `${weeklyPriorityPaths.collection}?week=${encodeURIComponent(week)}`,
        weeklyPrioritiesResponseSchema,
      ),
    enabled: userId !== NO_USER,
  });
}

export function useSetWeeklyPriorities() {
  const userId = useAuth().user?.id ?? NO_USER;
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: { week: string; taskIds: readonly TaskId[] }) =>
      authedApiRequest<WeeklyPrioritiesResponse>(
        weeklyPriorityPaths.collection,
        weeklyPrioritiesResponseSchema,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(variables),
        },
      ),
    onSuccess: (saved) => {
      queryClient.setQueryData(weeklyKeys.week(userId, saved.week), saved);
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: weeklyKeys.all(userId) }),
        queryClient.invalidateQueries({ queryKey: taskKeys.all(userId) }),
      ]),
  });
}

/* The weekly review is asked once per user and local week, in this browser only (WR4). */

const reviewKey = (userId: string, week: string): string => `ff-weekly:${userId}:${week}`;

export function weeklyReviewAnswered(userId: string, week: string): boolean {
  try {
    return window.localStorage.getItem(reviewKey(userId, week)) !== null;
  } catch {
    return false;
  }
}

/** Also tells any open page (the daily intention waits for the weekly review). */
export function rememberWeeklyReview(
  userId: string,
  week: string,
  outcome: 'set' | 'skipped' | 'new',
): void {
  try {
    window.localStorage.setItem(reviewKey(userId, week), outcome);
  } catch {
    // Only means the review may be offered again this week.
  }
  window.dispatchEvent(new Event(WEEKLY_REVIEW_DONE));
}

export const WEEKLY_REVIEW_DONE = 'ff-weekly-review-done';
/** Asks the weekly review to open now (the dashboard's "Plan your week"). */
export const OPEN_WEEKLY_REVIEW = 'ff-open-weekly-review';
