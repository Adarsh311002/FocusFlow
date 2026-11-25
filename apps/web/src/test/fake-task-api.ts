import { API_BASE_PATH, authPaths, mePaths, taskPaths } from '@focus-flow/contracts';

import {
  errorResponse,
  jsonResponse,
  noContentResponse,
  parsedBody,
  type RecordedRequest,
  refreshBody,
  userBody,
} from './api-stub';

type FakeTask = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  deletedAt: string | null;
};

/**
 * A small in-memory stand-in for the task API, following the same rules as the real one
 * (docs/api/rest.md): newest-created first, soft delete, completing or deleting the
 * current task clears it, only open tasks can become current. It lets component tests
 * drive whole user flows through the real client code without a server.
 */
export function createFakeTaskApi(options: { pageSize?: number } = {}) {
  const tasks: FakeTask[] = [];
  let currentTaskId: string | null = null;
  /** Parked thoughts (PT2), newest last; the list answers newest first. */
  const thoughts: { id: string; body: string; sessionId: string | null; createdAt: string }[] = [];
  const now = () => new Date().toISOString();

  /** Settings changed with `PATCH /me` (A2, ST1–ST3). */
  let settings: Record<string, unknown> = {};
  const user = () => ({ ...userBody, ...settings, currentTaskId });

  const view = (task: FakeTask) => {
    const base = {
      id: task.id,
      title: task.title,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
    return task.completedAt === null
      ? { ...base, status: 'open' }
      : { ...base, status: 'completed', completedAt: task.completedAt };
  };

  const live = (id: string | undefined) =>
    tasks.find((task) => task.id === id && task.deletedAt === null);

  const notFound = () => errorResponse(404, 'TASK_NOT_FOUND', 'Task not found.');

  function addTask(title: string, completed = false): FakeTask {
    const task: FakeTask = {
      id: crypto.randomUUID(),
      title,
      createdAt: now(),
      updatedAt: now(),
      completedAt: completed ? now() : null,
      deletedAt: null,
    };
    tasks.push(task);
    return task;
  }

  function handle(request: RecordedRequest): Response {
    const url = new URL(request.url, 'http://localhost');
    const path = url.pathname.slice(API_BASE_PATH.length);
    const segments = path.split('/').filter((segment) => segment.length > 0);

    if (path === authPaths.refresh) {
      return jsonResponse(200, refreshBody('fake-token'));
    }
    if (path === authPaths.logout) {
      return noContentResponse();
    }
    if (path === mePaths.self && request.method === 'PATCH') {
      const changes = parsedBody(request);
      settings = {
        ...settings,
        ...changes,
        ...(typeof changes.displayName === 'string'
          ? { displayName: changes.displayName.trim() }
          : {}),
      };
      return jsonResponse(200, { user: user() });
    }
    if (path === mePaths.self) {
      return jsonResponse(200, { user: user() });
    }
    if (path === mePaths.currentTask && request.method === 'PUT') {
      const { taskId } = parsedBody(request);
      if (taskId === null) {
        currentTaskId = null;
        return jsonResponse(200, { user: user() });
      }
      const task = live(typeof taskId === 'string' ? taskId : undefined);
      if (task === undefined) {
        return notFound();
      }
      if (task.completedAt !== null) {
        return errorResponse(409, 'TASK_NOT_OPEN', 'Only an open task can be the current task.');
      }
      currentTaskId = task.id;
      return jsonResponse(200, { user: user() });
    }

    if (path === '/parked-thoughts' && request.method === 'GET') {
      return jsonResponse(200, { thoughts: [...thoughts].reverse() });
    }
    if (path === '/parked-thoughts' && request.method === 'POST') {
      const { body, sessionId } = parsedBody(request);
      const thought = {
        id: crypto.randomUUID(),
        body: String(body).trim(),
        sessionId: typeof sessionId === 'string' ? sessionId : null,
        createdAt: now(),
      };
      thoughts.push(thought);
      return jsonResponse(201, { thought });
    }
    if (segments[0] === 'parked-thoughts') {
      const index = thoughts.findIndex((thought) => thought.id === segments[1]);
      const [thought] = index < 0 ? [] : thoughts.splice(index, 1);
      if (thought === undefined) {
        return errorResponse(404, 'NOT_FOUND', 'Parked thought not found.');
      }
      return segments[2] === 'task'
        ? jsonResponse(201, { task: view(addTask(thought.body)) })
        : noContentResponse();
    }

    if (path === taskPaths.collection && request.method === 'GET') {
      const status = url.searchParams.get('status') ?? 'open';
      const limit = Number(url.searchParams.get('limit') ?? options.pageSize ?? 50);
      const cursor = url.searchParams.get('cursor');
      const matching = [...tasks]
        .reverse()
        .filter((task) => task.deletedAt === null)
        .filter((task) => (status === 'open') === (task.completedAt === null));
      const start = cursor === null ? 0 : matching.findIndex((task) => task.id === cursor) + 1;
      const page = matching.slice(start, start + limit);
      const more = start + limit < matching.length;
      return jsonResponse(200, {
        tasks: page.map(view),
        nextCursor: more ? (page.at(-1)?.id ?? null) : null,
      });
    }
    if (path === taskPaths.collection && request.method === 'POST') {
      const { title } = parsedBody(request);
      return jsonResponse(201, { task: view(addTask(String(title))) });
    }

    const [, taskId, action] = segments;
    const task = live(taskId);
    if (segments[0] === 'tasks' && request.method === 'DELETE') {
      if (task !== undefined) {
        task.deletedAt = now();
        if (currentTaskId === task.id) {
          currentTaskId = null;
        }
        return noContentResponse();
      }
      return tasks.some((t) => t.id === taskId) ? noContentResponse() : notFound();
    }
    if (segments[0] === 'tasks' && task === undefined) {
      return notFound();
    }
    if (task !== undefined && action === undefined && request.method === 'GET') {
      return jsonResponse(200, { task: view(task) });
    }
    if (task !== undefined && action === undefined && request.method === 'PATCH') {
      task.title = String(parsedBody(request).title);
      task.updatedAt = now();
      return jsonResponse(200, { task: view(task) });
    }
    if (task !== undefined && action === 'complete') {
      task.completedAt ??= now();
      if (currentTaskId === task.id) {
        currentTaskId = null;
      }
      return jsonResponse(200, { task: view(task) });
    }
    if (task !== undefined && action === 'reopen') {
      task.completedAt = null;
      return jsonResponse(200, { task: view(task) });
    }

    return errorResponse(404, 'NOT_FOUND', `Unhandled fake route ${request.method} ${path}`);
  }

  return {
    handle,
    addTask,
    tasks,
    thoughts,
    currentTaskId: () => currentTaskId,
    setCurrentTaskId: (id: string | null) => {
      currentTaskId = id;
    },
  };
}
