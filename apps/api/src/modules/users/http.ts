import { mePaths, setCurrentTaskRequestSchema } from '@focus-flow/contracts';
import { Router } from 'express';

import { AppError, parseRequestInput } from '../../platform/http/errors.js';
import { getAuthUser } from '../auth/context.js';
import { requireAuth } from '../auth/middleware.js';
import { findUserById } from '../auth/queries.js';
import type { AuthDeps } from '../auth/service.js';
import { setCurrentTask } from '../tasks/service.js';
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

  // The current task is a property of the user (D3), so it is set through /me; the rules
  // that keep it pointing at an open, non-deleted task live with the tasks module.
  router.put(mePaths.currentTask, requireAuth(deps), (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      const { taskId } = parseRequestInput(setCurrentTaskRequestSchema, req.body);
      const user = await setCurrentTask({ db: deps.db }, userId, taskId);
      res.status(200).json({ user: await toUserView(deps.db, user) });
    })().catch(next);
  });

  return router;
};
