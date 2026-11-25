import {
  type CreateGoalRequest,
  type GoalColor,
  goalListResponseSchema,
  goalPath,
  goalPaths,
  goalResponseSchema,
  type GoalView,
  type UpdateGoalRequest,
} from '@focus-flow/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { authedApiRequest } from '../auth/auth-client';
import { useAuth } from '../auth/auth-context';
import { taskKeys } from '../tasks/task-queries';

// Goals on the web (GL5). Server state in TanStack Query; every write refreshes the goals
// and the tasks (a goal's progress and its tasks' chips change together).

const NO_USER = 'signed-out';

const goalKeys = {
  all: (userId: string) => ['goals', userId] as const,
  list: (userId: string, archived: boolean) => ['goals', userId, 'list', archived] as const,
};

/** The leaf-palette colors a goal may wear; also used for its chip. */
export const GOAL_COLORS: Readonly<Record<GoalColor, { swatch: string; name: string }>> = {
  leaf: { swatch: '#5c9a5a', name: 'Leaf' },
  moss: { swatch: '#7a8f3f', name: 'Moss' },
  fern: { swatch: '#2f8f7a', name: 'Fern' },
  amber: { swatch: '#d9a441', name: 'Amber' },
  berry: { swatch: '#b5577a', name: 'Berry' },
  sky: { swatch: '#5b8fc7', name: 'Sky' },
};

export function useGoals(options: { archived?: boolean } = {}) {
  const userId = useAuth().user?.id ?? NO_USER;
  const archived = options.archived ?? false;
  return useQuery({
    queryKey: goalKeys.list(userId, archived),
    queryFn: async () =>
      (
        await authedApiRequest(
          `${goalPaths.collection}?archived=${String(archived)}`,
          goalListResponseSchema,
        )
      ).goals,
    enabled: userId !== NO_USER,
  });
}

function useGoalWrite<Variables>(mutationFn: (variables: Variables) => Promise<GoalView>) {
  const userId = useAuth().user?.id ?? NO_USER;
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: goalKeys.all(userId) }),
        queryClient.invalidateQueries({ queryKey: taskKeys.all(userId) }),
      ]),
  });
}

export function useCreateGoal() {
  return useGoalWrite(
    async (request: CreateGoalRequest) =>
      (
        await authedApiRequest(goalPaths.collection, goalResponseSchema, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        })
      ).goal,
  );
}

export function useUpdateGoal() {
  return useGoalWrite(
    async ({ goalId, changes }: { goalId: string; changes: UpdateGoalRequest }) =>
      (
        await authedApiRequest(goalPath(goalId), goalResponseSchema, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(changes),
        })
      ).goal,
  );
}

/** "in 12 days", "today", "3 days ago" for a target date. */
export function untilLabel(targetDate: string, nowMs: number = Date.now()): string {
  const today = new Date(nowMs);
  const start = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.round((Date.parse(`${targetDate}T00:00:00Z`) - start) / 86_400_000);
  if (days === 0) {
    return 'today';
  }
  if (days > 0) {
    return days === 1 ? 'tomorrow' : `in ${String(days)} days`;
  }
  return days === -1 ? 'yesterday' : `${String(-days)} days ago`;
}
