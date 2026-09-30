import { taskIdSchema } from '@focus-flow/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api-client';
import {
  errorResponse,
  jsonResponse,
  noContentResponse,
  parsedBody,
  stubFetch,
  userBody,
} from '../../test/api-stub';
import { resetPendingRefresh } from '../auth/auth-client';
import { clearAccessToken, setAccessToken } from '../auth/token-store';
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

const TASK_ID = taskIdSchema.parse('01a0ed0d-55de-7d1b-8495-82fb5050d815');
const AT = '2026-09-30T10:00:00.000Z';
const taskBody = { id: TASK_ID, title: 'Write', status: 'open', createdAt: AT, updatedAt: AT };

beforeEach(() => {
  setAccessToken('access-token');
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearAccessToken();
  resetPendingRefresh();
});

describe('tasks client', () => {
  it('lists tasks with the status, cursor and limit in the query and a bearer token', async () => {
    const calls = stubFetch(() => jsonResponse(200, { tasks: [taskBody], nextCursor: 'next' }));

    const page = await listTasks({ status: 'completed', cursor: 'abc', limit: 10 });

    expect(page.nextCursor).toBe('next');
    expect(page.tasks[0]?.id).toBe(TASK_ID);
    expect(calls[0]?.url).toBe('/api/v1/tasks?status=completed&cursor=abc&limit=10');
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.headers.get('Authorization')).toBe('Bearer access-token');
  });

  it('creates a task with a JSON body', async () => {
    const calls = stubFetch(() => jsonResponse(201, { task: taskBody }));

    await createTask('Write');

    expect(calls[0]?.url).toBe('/api/v1/tasks');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers.get('Content-Type')).toBe('application/json');
    expect(
      parsedBody(calls[0] ?? { url: '', method: '', headers: new Headers(), body: null }),
    ).toEqual({
      title: 'Write',
    });
  });

  it.each([
    ['getTask', () => getTask(TASK_ID), 'GET', `/api/v1/tasks/${TASK_ID}`],
    ['renameTask', () => renameTask(TASK_ID, 'New'), 'PATCH', `/api/v1/tasks/${TASK_ID}`],
    ['completeTask', () => completeTask(TASK_ID), 'POST', `/api/v1/tasks/${TASK_ID}/complete`],
    ['reopenTask', () => reopenTask(TASK_ID), 'POST', `/api/v1/tasks/${TASK_ID}/reopen`],
  ])('%s calls %s %s', async (_name, run, method, url) => {
    const calls = stubFetch(() => jsonResponse(200, { task: taskBody }));

    const task = await run();

    expect(task.id).toBe(TASK_ID);
    expect(calls[0]?.method).toBe(method);
    expect(calls[0]?.url).toBe(url);
  });

  it('deletes a task and accepts the empty 204 response', async () => {
    const calls = stubFetch(() => noContentResponse());

    await expect(deleteTask(TASK_ID)).resolves.toBeUndefined();

    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.url).toBe(`/api/v1/tasks/${TASK_ID}`);
    expect(calls[0]?.headers.get('Authorization')).toBe('Bearer access-token');
  });

  it('sets and clears the current task through PUT /me/current-task', async () => {
    const calls = stubFetch((request) => {
      const { taskId } = JSON.parse(request.body ?? '{}') as { taskId: string | null };
      return jsonResponse(200, { user: { ...userBody, currentTaskId: taskId } });
    });

    expect((await setCurrentTask(TASK_ID)).currentTaskId).toBe(TASK_ID);
    expect((await setCurrentTask(null)).currentTaskId).toBeNull();
    expect(calls.map((call) => [call.method, call.url, call.body])).toEqual([
      ['PUT', '/api/v1/me/current-task', JSON.stringify({ taskId: TASK_ID })],
      ['PUT', '/api/v1/me/current-task', JSON.stringify({ taskId: null })],
    ]);
  });

  it('surfaces TASK_NOT_FOUND and TASK_NOT_OPEN as typed errors', async () => {
    stubFetch(() => errorResponse(404, 'TASK_NOT_FOUND', 'Task not found.'));
    await expect(getTask(TASK_ID)).rejects.toMatchObject({ code: 'TASK_NOT_FOUND', status: 404 });

    vi.unstubAllGlobals();
    stubFetch(() => errorResponse(409, 'TASK_NOT_OPEN', 'Only an open task can be current.'));
    await expect(setCurrentTask(TASK_ID)).rejects.toBeInstanceOf(ApiError);
  });

  it('rejects a response that does not match the contract', async () => {
    stubFetch(() => jsonResponse(200, { task: { ...taskBody, status: 'deleted' } }));

    await expect(getTask(TASK_ID)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
  });
});
