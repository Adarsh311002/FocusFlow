import {
  mePaths,
  type MeResponse,
  meResponseSchema,
  type TaskId,
  type TaskListResponse,
  taskListResponseSchema,
  taskPath,
  taskPaths,
  type TaskResponse,
  taskResponseSchema,
  type TaskStatus,
  taskStepListResponseSchema,
  taskStepPath,
  taskStepResponseSchema,
  type TaskStepView,
  type TaskView,
  type UserView,
} from '@focus-flow/contracts';

import { authedApiRequest, authedApiRequestNoContent } from '../auth/auth-client';

// Typed calls for the task routes (docs/api/rest.md). Every response is validated against
// the shared contract before it reaches a component.

function jsonBody(method: 'POST' | 'PATCH' | 'PUT', body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export type ListTasksParams = {
  readonly status: TaskStatus;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
  /** GL4: only this goal's tasks. */
  readonly goalId?: string | undefined;
};

export function listTasks(params: ListTasksParams): Promise<TaskListResponse> {
  const query = new URLSearchParams({ status: params.status });
  if (params.cursor !== undefined) {
    query.set('cursor', params.cursor);
  }
  if (params.limit !== undefined) {
    query.set('limit', String(params.limit));
  }
  if (params.goalId !== undefined) {
    query.set('goalId', params.goalId);
  }
  return authedApiRequest<TaskListResponse>(
    `${taskPaths.collection}?${query.toString()}`,
    taskListResponseSchema,
  );
}

async function taskRequest(path: string, init?: RequestInit): Promise<TaskView> {
  const body = await authedApiRequest<TaskResponse>(path, taskResponseSchema, init);
  return body.task;
}

export function getTask(taskId: TaskId): Promise<TaskView> {
  return taskRequest(taskPath(taskPaths.item, taskId));
}

export function createTask(
  title: string,
  options: { readonly goalId?: string; readonly estimatedSessions?: number } = {},
): Promise<TaskView> {
  return taskRequest(taskPaths.collection, jsonBody('POST', { title, ...options }));
}

/** `PATCH /tasks/:taskId` with any of the task's fields (title, goal, estimate). */
export function updateTask(
  taskId: TaskId,
  changes: {
    readonly title?: string;
    readonly goalId?: string | null;
    readonly estimatedSessions?: number | null;
  },
): Promise<TaskView> {
  return taskRequest(taskPath(taskPaths.item, taskId), jsonBody('PATCH', changes));
}

// Steps (SP2).

export async function listSteps(taskId: TaskId): Promise<TaskStepView[]> {
  return (await authedApiRequest(taskStepPath(taskId), taskStepListResponseSchema)).steps;
}

export async function addStep(taskId: TaskId, title: string): Promise<TaskStepView> {
  return (
    await authedApiRequest(
      taskStepPath(taskId),
      taskStepResponseSchema,
      jsonBody('POST', { title }),
    )
  ).step;
}

export async function updateStep(
  taskId: TaskId,
  stepId: string,
  changes: { readonly title?: string; readonly done?: boolean },
): Promise<TaskStepView> {
  return (
    await authedApiRequest(
      taskStepPath(taskId, stepId),
      taskStepResponseSchema,
      jsonBody('PATCH', changes),
    )
  ).step;
}

export function removeStep(taskId: TaskId, stepId: string): Promise<void> {
  return authedApiRequestNoContent(taskStepPath(taskId, stepId), { method: 'DELETE' });
}

export function renameTask(taskId: TaskId, title: string): Promise<TaskView> {
  return taskRequest(taskPath(taskPaths.item, taskId), jsonBody('PATCH', { title }));
}

export function completeTask(taskId: TaskId): Promise<TaskView> {
  return taskRequest(taskPath(taskPaths.complete, taskId), { method: 'POST' });
}

export function reopenTask(taskId: TaskId): Promise<TaskView> {
  return taskRequest(taskPath(taskPaths.reopen, taskId), { method: 'POST' });
}

export function deleteTask(taskId: TaskId): Promise<void> {
  return authedApiRequestNoContent(taskPath(taskPaths.item, taskId), { method: 'DELETE' });
}

/** `PUT /me/current-task`; `null` clears it. Answers with the updated user. */
export async function setCurrentTask(taskId: TaskId | null): Promise<UserView> {
  const body = await authedApiRequest<MeResponse>(
    mePaths.currentTask,
    meResponseSchema,
    jsonBody('PUT', { taskId }),
  );
  return body.user;
}
