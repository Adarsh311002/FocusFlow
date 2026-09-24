import { mePaths } from '@focus-flow/contracts';
import { Router } from 'express';

import { AppError } from '../../platform/http/errors.js';
import { getAuthUser } from '../auth/context.js';
import { requireAuth } from '../auth/middleware.js';
import { findUserById } from '../auth/queries.js';
import type { AuthDeps } from '../auth/service.js';
import { toUserView } from './views.js';

export const createUsersRouter = (deps: AuthDeps): Router => {
  const router = Router();

  router.get(mePaths.self, requireAuth(deps), (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      const user = await findUserById(deps.db, userId);
      if (user === undefined) {
        throw new AppError('NOT_FOUND', 404, 'User not found.');
      }
      res.status(200).json({ user: await toUserView(deps.db, user) });
    })().catch(next);
  });

  return router;
};
