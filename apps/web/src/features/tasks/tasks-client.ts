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
};

export function listTasks(params: ListTasksParams): Promise<TaskListResponse> {
  const query = new URLSearchParams({ status: params.status });
  if (params.cursor !== undefined) {
    query.set('cursor', params.cursor);
  }
  if (params.limit !== undefined) {
    query.set('limit', String(params.limit));
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

export function createTask(title: string): Promise<TaskView> {
  return taskRequest(taskPaths.collection, jsonBody('POST', { title }));
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
