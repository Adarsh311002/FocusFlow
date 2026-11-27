import {
  checkInFocusSessionRequestSchema,
  focusSessionInsightsQuerySchema,
  focusSessionParamsSchema,
  focusSessionPaths,
  focusSessionSummaryQuerySchema,
  listFocusSessionsQuerySchema,
  startFocusSessionRequestSchema,
} from '@focus-flow/contracts';
import { type RequestHandler, Router } from 'express';

import { parseRequestInput } from '../../platform/http/errors.js';
import { getAuthUser } from '../auth/context.js';
import { checkInFocusSession } from './check-in.js';
import { getFocusInsights, listFocusSessionHistory, summarizeFocusSessions } from './review.js';
import {
  breakFocusSession,
  type FocusSessionsDeps,
  getCurrentFocusSession,
  pauseFocusSession,
  recordDistraction,
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
 * `GET /focus-sessions/current`, `/summary` and `/insights` are registered before the `:sessionId`
 * routes, so "current" and "summary" are never parsed as session ids. History and summary
 * return the contract shapes directly (`{ sessions, nextCursor }`, the summary object).
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

  router.get(focusSessionPaths.collection, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      const query = parseRequestInput(listFocusSessionsQuerySchema, req.query);
      res.status(200).json(await listFocusSessionHistory(deps, userId, query));
    })().catch(next);
  });

  router.get(focusSessionPaths.current, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      res.status(200).json({ session: await getCurrentFocusSession(deps, userId) });
    })().catch(next);
  });

  router.get(focusSessionPaths.summary, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      const query = parseRequestInput(focusSessionSummaryQuerySchema, req.query);
      res.status(200).json(await summarizeFocusSessions(deps, userId, query));
    })().catch(next);
  });

  router.get(focusSessionPaths.insights, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      const query = parseRequestInput(focusSessionInsightsQuerySchema, req.query);
      res.status(200).json(await getFocusInsights(deps, userId, query));
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
  sessionAction(focusSessionPaths.break, breakFocusSession);
  sessionAction(focusSessionPaths.distraction, recordDistraction);

  // CI2: the user's check-in on an ended session.
  router.put(focusSessionPaths.checkIn, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      const { sessionId } = parseRequestInput(focusSessionParamsSchema, req.params);
      const request = parseRequestInput(checkInFocusSessionRequestSchema, req.body);
      res
        .status(200)
        .json({ session: await checkInFocusSession(deps, userId, sessionId, request) });
    })().catch(next);
  });

  return router;
};
