import {
  focusSessionParamsSchema,
  focusSessionPaths,
  startFocusSessionRequestSchema,
} from '@focus-flow/contracts';
import { type RequestHandler, Router } from 'express';

import { parseRequestInput } from '../../platform/http/errors.js';
import { getAuthUser } from '../auth/context.js';
import {
  type FocusSessionsDeps,
  getCurrentFocusSession,
  pauseFocusSession,
  resumeFocusSession,
  startFocusSession,
  stopFocusSession,
} from './service.js';

export type FocusSessionsRouterDeps = FocusSessionsDeps & {
  /** `requireAuth(authDeps)`, built once in platform/http/app.ts. */
  readonly authenticate: RequestHandler;
};

/**
 * Thin handlers: parse, call the service, return `{ session }`. The owner is always the
 * authenticated user, never anything the client sends; strict request schemas reject a
 * body that names a user. `authenticate` is attached per route (see the task router).
 * `GET /focus-sessions/current` is registered before the `:sessionId` routes, so
 * "current" is never parsed as a session id.
 */
export const createFocusSessionsRouter = (deps: FocusSessionsRouterDeps): Router => {
  const router = Router();
  const { authenticate } = deps;

  router.post(focusSessionPaths.collection, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      const request = parseRequestInput(startFocusSessionRequestSchema, req.body);
      res.status(201).json({ session: await startFocusSession(deps, userId, request) });
    })().catch(next);
  });

  router.get(focusSessionPaths.current, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      res.status(200).json({ session: await getCurrentFocusSession(deps, userId) });
    })().catch(next);
  });

  const sessionAction = (
    path: string,
    action: (deps: FocusSessionsDeps, userId: string, sessionId: string) => Promise<unknown>,
  ): void => {
    router.post(path, authenticate, (req, res, next) => {
      void (async () => {
        const { userId } = getAuthUser(req);
        const { sessionId } = parseRequestInput(focusSessionParamsSchema, req.params);
        res.status(200).json({ session: await action(deps, userId, sessionId) });
      })().catch(next);
    });
  };

  sessionAction(focusSessionPaths.pause, pauseFocusSession);
  sessionAction(focusSessionPaths.resume, resumeFocusSession);
  sessionAction(focusSessionPaths.stop, stopFocusSession);

  return router;
};
