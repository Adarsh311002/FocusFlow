import {
  setWeeklyPrioritiesRequestSchema,
  weeklyPrioritiesQuerySchema,
  weeklyPriorityPaths,
} from '@focus-flow/contracts';
import { type RequestHandler, Router } from 'express';

import { parseRequestInput } from '../../platform/http/errors.js';
import { getAuthUser } from '../auth/context.js';
import { getWeeklyPriorities, setWeeklyPriorities, type WeeklyPrioritiesDeps } from './service.js';

export type WeeklyPrioritiesRouterDeps = WeeklyPrioritiesDeps & {
  readonly authenticate: RequestHandler;
};

/** WR2: read and replace one week's priorities; the owner is always the token's. */
export const createWeeklyPrioritiesRouter = (deps: WeeklyPrioritiesRouterDeps): Router => {
  const router = Router();
  const { authenticate } = deps;

  router.get(weeklyPriorityPaths.collection, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      const { week } = parseRequestInput(weeklyPrioritiesQuerySchema, req.query);
      res.status(200).json(await getWeeklyPriorities(deps, userId, week));
    })().catch(next);
  });

  router.put(weeklyPriorityPaths.collection, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      const { week, taskIds } = parseRequestInput(setWeeklyPrioritiesRequestSchema, req.body);
      res.status(200).json(await setWeeklyPriorities(deps, userId, week, taskIds));
    })().catch(next);
  });

  return router;
};
