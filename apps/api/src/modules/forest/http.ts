import { forestPaths, forestQuerySchema } from '@focus-flow/contracts';
import { type RequestHandler, Router } from 'express';

import { parseRequestInput } from '../../platform/http/errors.js';
import { getAuthUser } from '../auth/context.js';
import { type ForestDeps, getForest } from './service.js';

export type ForestRouterDeps = ForestDeps & { readonly authenticate: RequestHandler };

/** `GET /forest?tz=` (GF5): the caller's forest, derived from their own history. */
export const createForestRouter = (deps: ForestRouterDeps): Router => {
  const router = Router();
  router.get(forestPaths.self, deps.authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      const { tz } = parseRequestInput(forestQuerySchema, req.query);
      res.status(200).json(await getForest(deps, userId, tz));
    })().catch(next);
  });
  return router;
};
