import {
  DAILY_GOAL_SECONDS,
  mePaths,
  type MeResponse,
  meResponseSchema,
  type TaskView,
  type UserView,
} from '@focus-flow/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { authedApiRequest } from '../auth/auth-client';
import { useAuth } from '../auth/auth-context';
import { focusSessionKeys } from '../review/review-queries';
import { taskKeys } from '../tasks/task-queries';
import { createTask, setCurrentTask } from '../tasks/tasks-client';

/* Intention: before focusing, the user names what they mean to finish. An intention is
   stored as a task (so it lives with the user's todos, shows on the dashboard sign and in
   Review history) and becomes the current task. The daily goal is the user's own setting
   (A2), changed through `PATCH /me`. */

const NO_USER = 'signed-out';

/** `PATCH /me { dailyGoalSeconds }` (A2): answers with the updated user. */
export async function updateDailyGoal(dailyGoalSeconds: number): Promise<UserView> {
  const body = await authedApiRequest<MeResponse>(mePaths.self, meResponseSchema, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dailyGoalSeconds }),
  });
  return body.user;
}

/** The user's daily goal in seconds; a missing value reads as the default (A10). */
export function dailyGoalOf(user: UserView | null): number {
  return user?.dailyGoalSeconds ?? DAILY_GOAL_SECONDS.default;
}

/**
 * Turns an intention into a task and makes it the current task. Returns the task, so a
 * caller can start a session on it. The task lists and the user are refreshed afterwards.
 */
export function useAdoptIntention() {
  const { user, updateUser } = useAuth();
  const queryClient = useQueryClient();
  const userId = user?.id ?? NO_USER;
  return useMutation({
    mutationFn: async (title: string): Promise<TaskView> => {
      const task = await createTask(title);
      // The task exists now; making it current is a follow-up the user can redo by hand.
      try {
        updateUser(await setCurrentTask(task.id));
      } catch {
        // Not fatal: the intention is saved as a task either way.
      }
      return task;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: taskKeys.all(userId) }),
  });
}

/** Saves the daily goal and refreshes everything measured against it. */
export function useSetDailyGoal() {
  const { user, updateUser } = useAuth();
  const queryClient = useQueryClient();
  const userId = user?.id ?? NO_USER;
  return useMutation({
    mutationFn: updateDailyGoal,
    onSuccess: async (updated) => {
      updateUser(updated);
      await queryClient.invalidateQueries({ queryKey: focusSessionKeys.all(userId) });
    },
  });
}

/* Asked once a day: remembered per user and local date, in this browser only. */

function localDate(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${String(now.getFullYear())}-${month}-${day}`;
}

function intentionKey(userId: string): string {
  return `ff-intention:${userId}:${localDate()}`;
}

export function dailyIntentionAnswered(userId: string): boolean {
  try {
    return window.localStorage.getItem(intentionKey(userId)) !== null;
  } catch {
    return false;
  }
}

export function rememberDailyIntention(userId: string, outcome: 'set' | 'skipped'): void {
  try {
    window.localStorage.setItem(intentionKey(userId), outcome);
  } catch {
    // Only means the question may come back later today.
  }
}
