import {
  aiJobParamsSchema,
  aiPaths,
  createFirstStepRequestSchema,
  createWeeklyReflectionRequestSchema,
  weeklyReflectionQuerySchema,
} from '@focus-flow/contracts';
import {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  Router,
} from 'express';

import { parseRequestInput } from '../../platform/http/errors.js';
import { getAuthUser } from '../auth/context.js';
import {
  type AiDeps,
  getAiJob,
  getWeeklyReflection,
  requestFirstStep,
  requestWeeklyReflection,
} from './service.js';

export type AiRouterDeps = AiDeps & { readonly authenticate: RequestHandler };

/** Wave 5 routes (AI2): ask for help, then poll the job until it has finished. */
export const createAiRouter = (deps: AiRouterDeps): Router => {
  const router = Router();
  const handle =
    (work: (req: Request, userId: string) => Promise<[number, unknown]>) =>
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        const [status, body] = await work(req, getAuthUser(req).userId);
        res.status(status).json(body);
      })().catch(next);
    };

  router.post(
    aiPaths.firstStep,
    deps.authenticate,
    handle(async (req, userId) => {
      const { taskId } = parseRequestInput(createFirstStepRequestSchema, req.body);
      const { job, created } = await requestFirstStep(deps, userId, taskId);
      return [created ? 202 : 200, { job }];
    }),
  );
  router.post(
    aiPaths.weeklyReflection,
    deps.authenticate,
    handle(async (req, userId) => {
      const { week, tz } = parseRequestInput(createWeeklyReflectionRequestSchema, req.body);
      const { job, created } = await requestWeeklyReflection(deps, userId, week, tz);
      return [created ? 202 : 200, { job }];
    }),
  );
  router.get(
    aiPaths.weeklyReflection,
    deps.authenticate,
    handle(async (req, userId) => {
      const { week } = parseRequestInput(weeklyReflectionQuerySchema, req.query);
      return [200, { job: await getWeeklyReflection(deps, userId, week) }];
    }),
  );
  router.get(
    aiPaths.job,
    deps.authenticate,
    handle(async (req, userId) => {
      const { jobId } = parseRequestInput(aiJobParamsSchema, req.params);
      return [200, { job: await getAiJob(deps, userId, jobId) }];
    }),
  );
  return router;
};
