import {
  createParkedThoughtRequestSchema,
  parkedThoughtParamsSchema,
  parkedThoughtPaths,
} from '@focus-flow/contracts';
import { type RequestHandler, Router } from 'express';

import { parseRequestInput } from '../../platform/http/errors.js';
import { getAuthUser } from '../auth/context.js';
import {
  dismissThought,
  listParkedThoughts,
  type ParkedThoughtsDeps,
  parkThought,
  thoughtToTask,
} from './service.js';

export type ParkedThoughtsRouterDeps = ParkedThoughtsDeps & {
  /** `requireAuth(authDeps)`, attached per route like the task router. */
  readonly authenticate: RequestHandler;
};

/** Thin handlers (PT2–PT4): parse, call the service, answer. The owner is always the token's. */
export const createParkedThoughtsRouter = (deps: ParkedThoughtsRouterDeps): Router => {
  const router = Router();
  const { authenticate } = deps;

  router.get(parkedThoughtPaths.collection, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      res.status(200).json({ thoughts: await listParkedThoughts(deps, userId) });
    })().catch(next);
  });

  router.post(parkedThoughtPaths.collection, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      const request = parseRequestInput(createParkedThoughtRequestSchema, req.body);
      res.status(201).json({ thought: await parkThought(deps, userId, request) });
    })().catch(next);
  });

  router.delete(parkedThoughtPaths.item, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      const { thoughtId } = parseRequestInput(parkedThoughtParamsSchema, req.params);
      await dismissThought(deps, userId, thoughtId);
      res.status(204).end();
    })().catch(next);
  });

  router.post(parkedThoughtPaths.toTask, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      const { thoughtId } = parseRequestInput(parkedThoughtParamsSchema, req.params);
      res.status(201).json({ task: await thoughtToTask(deps, userId, thoughtId) });
    })().catch(next);
  });

  return router;
};
