import {
  createGoalRequestSchema,
  goalParamsSchema,
  goalPaths,
  listGoalsQuerySchema,
  updateGoalRequestSchema,
} from '@focus-flow/contracts';
import { type RequestHandler, Router } from 'express';

import { parseRequestInput } from '../../platform/http/errors.js';
import { getAuthUser } from '../auth/context.js';
import { createGoal, type GoalsDeps, listGoals, updateGoal } from './service.js';

export type GoalsRouterDeps = GoalsDeps & { readonly authenticate: RequestHandler };

/** GL3: list, create and change goals; never delete (archive instead). */
export const createGoalsRouter = (deps: GoalsRouterDeps): Router => {
  const router = Router();
  const { authenticate } = deps;

  router.get(goalPaths.collection, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      const { archived } = parseRequestInput(listGoalsQuerySchema, req.query);
      res.status(200).json({ goals: await listGoals(deps, userId, archived === 'true') });
    })().catch(next);
  });

  router.post(goalPaths.collection, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      const input = parseRequestInput(createGoalRequestSchema, req.body);
      res.status(201).json({ goal: await createGoal(deps, userId, input) });
    })().catch(next);
  });

  router.patch(goalPaths.item, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      const { goalId } = parseRequestInput(goalParamsSchema, req.params);
      const input = parseRequestInput(updateGoalRequestSchema, req.body);
      res.status(200).json({ goal: await updateGoal(deps, userId, goalId, input) });
    })().catch(next);
  });

  return router;
};
