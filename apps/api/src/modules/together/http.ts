import {
  buddiesQuerySchema,
  buddyParamsSchema,
  buddyRequestSchema,
  createRoomScheduleRequestSchema,
  roomFocusParamsSchema,
  roomRecapQuerySchema,
  roomScheduleParamsSchema,
  togetherPaths,
} from '@focus-flow/contracts';
import { type RequestHandler, Router } from 'express';

import { parseRequestInput } from '../../platform/http/errors.js';
import { getAuthUser } from '../auth/context.js';
import {
  acceptBuddy,
  type BuddiesDeps,
  getBuddies,
  nudgeBuddy,
  removeBuddy,
  requestBuddy,
} from './buddies.js';
import {
  createSchedule,
  deleteSchedule,
  listSchedules,
  roomRecap,
  type RoomsTogetherDeps,
  upcomingSessions,
} from './rooms.js';

export type TogetherRouterDeps = BuddiesDeps &
  RoomsTogetherDeps & { readonly authenticate: RequestHandler };

/** Wave 4 routes: buddies (BD3–BD4), room schedules (SC2–SC3) and the room recap (RR1). */
export const createTogetherRouter = (deps: TogetherRouterDeps): Router => {
  const router = Router();
  const { authenticate } = deps;
  const handle =
    (work: (req: Parameters<RequestHandler>[0], userId: string) => Promise<[number, unknown]>) =>
    (
      req: Parameters<RequestHandler>[0],
      res: Parameters<RequestHandler>[1],
      next: (e?: unknown) => void,
    ) => {
      void (async () => {
        const { userId } = getAuthUser(req);
        const [status, body] = await work(req, userId);
        if (body === undefined) {
          res.status(status).end();
        } else {
          res.status(status).json(body);
        }
      })().catch(next);
    };

  router.get(
    togetherPaths.buddies,
    authenticate,
    handle(async (req, userId) => {
      const { tz } = parseRequestInput(buddiesQuerySchema, req.query);
      return [200, await getBuddies(deps, userId, tz)];
    }),
  );
  router.post(
    togetherPaths.buddies,
    authenticate,
    handle(async (req, userId) => {
      const { code } = parseRequestInput(buddyRequestSchema, req.body);
      return [200, { status: await requestBuddy(deps, userId, code) }];
    }),
  );
  router.post(
    togetherPaths.acceptBuddy,
    authenticate,
    handle(async (req, userId) => {
      const { userId: otherId } = parseRequestInput(buddyParamsSchema, req.params);
      await acceptBuddy(deps, userId, otherId);
      return [204, undefined];
    }),
  );
  router.post(
    togetherPaths.nudgeBuddy,
    authenticate,
    handle(async (req, userId) => {
      const { userId: otherId } = parseRequestInput(buddyParamsSchema, req.params);
      await nudgeBuddy(deps, userId, otherId);
      return [204, undefined];
    }),
  );
  router.delete(
    togetherPaths.buddy,
    authenticate,
    handle(async (req, userId) => {
      const { userId: otherId } = parseRequestInput(buddyParamsSchema, req.params);
      await removeBuddy(deps, userId, otherId);
      return [204, undefined];
    }),
  );

  router.get(
    togetherPaths.upcoming,
    authenticate,
    handle(async (_req, userId) => [200, { sessions: await upcomingSessions(deps, userId) }]),
  );
  router.get(
    togetherPaths.schedules,
    authenticate,
    handle(async (req, userId) => {
      const { roomId } = parseRequestInput(roomFocusParamsSchema, req.params);
      return [200, { schedules: await listSchedules(deps, userId, roomId) }];
    }),
  );
  router.post(
    togetherPaths.schedules,
    authenticate,
    handle(async (req, userId) => {
      const { roomId } = parseRequestInput(roomFocusParamsSchema, req.params);
      const input = parseRequestInput(createRoomScheduleRequestSchema, req.body);
      return [201, { schedule: await createSchedule(deps, userId, roomId, input) }];
    }),
  );
  router.delete(
    togetherPaths.schedule,
    authenticate,
    handle(async (req, userId) => {
      const { roomId, scheduleId } = parseRequestInput(roomScheduleParamsSchema, req.params);
      await deleteSchedule(deps, userId, roomId, scheduleId);
      return [204, undefined];
    }),
  );
  router.get(
    togetherPaths.recap,
    authenticate,
    handle(async (req, userId) => {
      const { roomId } = parseRequestInput(roomFocusParamsSchema, req.params);
      const { tz } = parseRequestInput(roomRecapQuerySchema, req.query);
      return [200, await roomRecap(deps, userId, roomId, tz)];
    }),
  );

  return router;
};
