import {
  createTaskRequestSchema,
  listTasksQuerySchema,
  taskParamsSchema,
  taskPaths,
  updateTaskRequestSchema,
} from '@focus-flow/contracts';
import { type RequestHandler, Router } from 'express';

import { parseRequestInput } from '../../platform/http/errors.js';
import { getAuthUser } from '../auth/context.js';
import {
  completeTask,
  createTask,
  deleteTask,
  getTask,
  listTasks,
  renameTask,
  reopenTask,
  type TasksDeps,
} from './service.js';
import { toTaskView } from './views.js';

export type TasksRouterDeps = TasksDeps & {
  /** `requireAuth(authDeps)`, built once in platform/http/app.ts. */
  readonly authenticate: RequestHandler;
};

/**
 * Thin handlers: parse, call the service, map the result. The owner is always the
 * authenticated user (`getAuthUser`), never anything the client sends; the strict
 * request schemas reject a body that tries to name a user.
 *
 * `authenticate` is attached per route rather than with `router.use`, because this router
 * is mounted at the API base path: a router-level middleware would also run for requests
 * that match no task route and turn their 404 into a 401.
 */
export const createTasksRouter = (deps: TasksRouterDeps): Router => {
  const router = Router();
  const { authenticate } = deps;

  router.get(taskPaths.collection, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      const query = parseRequestInput(listTasksQuerySchema, req.query);
      const page = await listTasks(deps, userId, query);
      res.status(200).json({ tasks: page.tasks.map(toTaskView), nextCursor: page.nextCursor });
    })().catch(next);
  });

  router.post(taskPaths.collection, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      const { title } = parseRequestInput(createTaskRequestSchema, req.body);
      const task = await createTask(deps, userId, title);
      res.status(201).json({ task: toTaskView(task) });
    })().catch(next);
  });

  router.get(taskPaths.item, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      const { taskId } = parseRequestInput(taskParamsSchema, req.params);
      res.status(200).json({ task: toTaskView(await getTask(deps, userId, taskId)) });
    })().catch(next);
  });

  router.patch(taskPaths.item, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      const { taskId } = parseRequestInput(taskParamsSchema, req.params);
      const { title } = parseRequestInput(updateTaskRequestSchema, req.body);
      res.status(200).json({ task: toTaskView(await renameTask(deps, userId, taskId, title)) });
    })().catch(next);
  });

  router.post(taskPaths.complete, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      const { taskId } = parseRequestInput(taskParamsSchema, req.params);
      res.status(200).json({ task: toTaskView(await completeTask(deps, userId, taskId)) });
    })().catch(next);
  });

  router.post(taskPaths.reopen, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      const { taskId } = parseRequestInput(taskParamsSchema, req.params);
      res.status(200).json({ task: toTaskView(await reopenTask(deps, userId, taskId)) });
    })().catch(next);
  });

  router.delete(taskPaths.item, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      const { taskId } = parseRequestInput(taskParamsSchema, req.params);
      await deleteTask(deps, userId, taskId);
      res.status(204).end();
    })().catch(next);
  });

  return router;
};
