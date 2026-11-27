import {
  createTaskStepRequestSchema,
  taskParamsSchema,
  taskPaths,
  taskStepParamsSchema,
  updateTaskStepRequestSchema,
} from '@focus-flow/contracts';
import { type RequestHandler, Router } from 'express';

import { parseRequestInput } from '../../platform/http/errors.js';
import { getAuthUser } from '../auth/context.js';
import { addStep, listSteps, removeStep, type StepsDeps, updateStep } from './service.js';

export type StepsRouterDeps = StepsDeps & { readonly authenticate: RequestHandler };

const STEP_PATH = `${taskPaths.steps}/:stepId`;

/** SP2: `/tasks/:taskId/steps[/:stepId]`, the caller's own tasks only. */
export const createStepsRouter = (deps: StepsRouterDeps): Router => {
  const router = Router();
  const { authenticate } = deps;

  router.get(taskPaths.steps, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      const { taskId } = parseRequestInput(taskParamsSchema, req.params);
      res.status(200).json({ steps: await listSteps(deps, userId, taskId) });
    })().catch(next);
  });

  router.post(taskPaths.steps, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      const { taskId } = parseRequestInput(taskParamsSchema, req.params);
      const { title } = parseRequestInput(createTaskStepRequestSchema, req.body);
      res.status(201).json({ step: await addStep(deps, userId, taskId, title) });
    })().catch(next);
  });

  router.patch(STEP_PATH, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      const { taskId, stepId } = parseRequestInput(taskStepParamsSchema, req.params);
      const changes = parseRequestInput(updateTaskStepRequestSchema, req.body);
      res.status(200).json({ step: await updateStep(deps, userId, taskId, stepId, changes) });
    })().catch(next);
  });

  router.delete(STEP_PATH, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      const { taskId, stepId } = parseRequestInput(taskStepParamsSchema, req.params);
      await removeStep(deps, userId, taskId, stepId);
      res.status(204).end();
    })().catch(next);
  });

  return router;
};
