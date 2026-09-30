import type { TaskId, TaskStatus } from '@focus-flow/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { useAuth } from '../auth/auth-context';
import { isTaskNotFound } from './task-messages';
import {
  completeTask,
  createTask,
  deleteTask,
  getTask,
  listTasks,
  renameTask,
  reopenTask,
  setCurrentTask,
} from './tasks-client';

// Server state for tasks lives in TanStack Query. Keys start with the user id, so even
// between the session changing and the cache being cleared (auth-context.tsx) one user's
// entries can never be read under another user's keys.
//
// Phase 2 deliberately has no optimistic updates: every mutation waits for the server's
// answer, shows a pending state meanwhile, and then refetches the affected lists.

const NO_USER = 'signed-out';

/** The first page has no cursor; typed so later pages can carry one. */
const FIRST_PAGE: string | undefined = undefined;

export const taskKeys = {
  all: (userId: string) => ['tasks', userId] as const,
  list: (userId: string, status: TaskStatus) => ['tasks', userId, 'list', status] as const,
  detail: (userId: string, taskId: TaskId) => ['tasks', userId, 'detail', taskId] as const,
};

function useUserId(): string {
  return useAuth().user?.id ?? NO_USER;
}

/** Newest-created first, one page at a time; `fetchNextPage` follows `nextCursor`. */
export function useTaskList(status: TaskStatus) {
  const userId = useUserId();
  return useInfiniteQuery({
    queryKey: taskKeys.list(userId, status),
    queryFn: ({ pageParam }) => listTasks({ status, cursor: pageParam }),
    initialPageParam: FIRST_PAGE,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: userId !== NO_USER,
  });
}

/** One task by id; used to show the current task even when it is not on a loaded page. */
export function useTask(taskId: TaskId | null) {
  const userId = useUserId();
  return useQuery({
    queryKey:
      taskId === null ? ['tasks', userId, 'detail', 'none'] : taskKeys.detail(userId, taskId),
    queryFn: () => {
      if (taskId === null) {
        throw new Error('useTask: no task id');
      }
      return getTask(taskId);
    },
    enabled: userId !== NO_USER && taskId !== null,
    retry: false,
  });
}

/** Refetches every task query of the signed-in user after a change. */
function useInvalidateTasks(): () => Promise<void> {
  const queryClient = useQueryClient();
  const userId = useUserId();
  return useCallback(
    () => queryClient.invalidateQueries({ queryKey: taskKeys.all(userId) }),
    [queryClient, userId],
  );
}

/**
 * Task writes share one rule: refresh the lists afterwards, including after a
 * TASK_NOT_FOUND (the task was deleted elsewhere, so the list on screen is stale).
 *
 * `afterSuccess` is a best-effort follow-up (for example re-reading the user) and must
 * not throw: a mutation that the server accepted is a success whatever happens next, and
 * the lists are refreshed regardless (`finally`).
 */
function useTaskMutation<TVariables, TResult>(
  mutationFn: (variables: TVariables) => Promise<TResult>,
  afterSuccess?: (result: TResult, variables: TVariables) => Promise<void> | void,
) {
  const invalidate = useInvalidateTasks();
  return useMutation({
    mutationFn,
    onSuccess: async (result, variables) => {
      try {
        await afterSuccess?.(result, variables);
      } finally {
        await invalidate();
      }
    },
    onError: async (error) => {
      if (isTaskNotFound(error)) {
        await invalidate();
      }
    },
  });
}

export function useCreateTask() {
  return useTaskMutation((title: string) => createTask(title));
}

export function useRenameTask() {
  return useTaskMutation(({ taskId, title }: { taskId: TaskId; title: string }) =>
    renameTask(taskId, title),
  );
}

export function useReopenTask() {
  return useTaskMutation((taskId: TaskId) => reopenTask(taskId));
}

/**
 * Completing or deleting the current task makes the server clear it (D43, D38). The
 * client does not guess: it re-reads `GET /me` so the user it shows matches the server.
 * `reloadUser` is best effort and never throws; a failure is surfaced as
 * `userSyncFailed` (a non-blocking notice), not as a failed mutation.
 */
function useClearsCurrentTask() {
  const { user, reloadUser } = useAuth();
  const currentTaskId = user?.currentTaskId ?? null;
  return useCallback(
    async (taskId: TaskId) => {
      if (taskId === currentTaskId) {
        await reloadUser();
      }
    },
    [currentTaskId, reloadUser],
  );
}

export function useCompleteTask() {
  const afterClear = useClearsCurrentTask();
  return useTaskMutation(
    (taskId: TaskId) => completeTask(taskId),
    (_task, taskId) => afterClear(taskId),
  );
}

export function useDeleteTask() {
  const afterClear = useClearsCurrentTask();
  return useTaskMutation(
    (taskId: TaskId) => deleteTask(taskId),
    (_result, taskId) => afterClear(taskId),
  );
}

/** `PUT /me/current-task`: the response is the updated user, applied directly. */
export function useSetCurrentTask() {
  const { updateUser } = useAuth();
  return useTaskMutation(
    (taskId: TaskId | null) => setCurrentTask(taskId),
    (user) => {
      updateUser(user);
    },
  );
}
