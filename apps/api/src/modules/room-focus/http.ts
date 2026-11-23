import {
  optInRoomFocusRequestSchema,
  roomFocusParamsSchema,
  roomPaths,
} from '@focus-flow/contracts';
import { type RequestHandler, Router } from 'express';
import { z } from 'zod';

import { AppError, parseRequestInput } from '../../platform/http/errors.js';
import { getAuthUser } from '../auth/context.js';
import type { RoomFocusService } from './types.js';

/** `/rooms/:roomId/focus-participation` (docs/api/rest.md "Rooms"). */
export const roomFocusParticipationPath = `${roomPaths.item}/focus-participation`;

export type RoomFocusRouterDeps = {
  readonly service: Pick<RoomFocusService, 'optIn' | 'optOut' | 'state'>;
  /** `requireAuth(authDeps)`, built once in platform/http/app.ts. */
  readonly authenticate: RequestHandler;
  /**
   * Counts one write by the user; `true` while within the limit (10 per 10 s, Rev I M3). The
   * state read is exempt. Unset: no limit (tests).
   */
  readonly rateLimit?: (userId: string) => Promise<boolean>;
};

const noQuerySchema = z.strictObject({});

/**
 * Thin handlers: parse, call the service, map the result. The acting user is always the
 * authenticated user; the strict schemas reject a body that tries to name a user or a
 * session. Non-members get `404 ROOM_NOT_FOUND` from the service (M4, RF14).
 */
export const createRoomFocusRouter = (deps: RoomFocusRouterDeps): Router => {
  const router = Router();
  const { authenticate, service } = deps;

  const limitWrites = async (userId: string): Promise<void> => {
    if (deps.rateLimit === undefined) {
      return;
    }
    let allowed: boolean;
    try {
      allowed = await deps.rateLimit(userId);
    } catch {
      throw new AppError('INTERNAL', 503, 'Rate limiting is temporarily unavailable.');
    }
    if (!allowed) {
      throw new AppError('RATE_LIMITED', 429, 'Too many requests. Slow down.');
    }
  };

  router.post(roomFocusParticipationPath, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      await limitWrites(userId);
      const { roomId } = parseRequestInput(roomFocusParamsSchema, req.params);
      // A body-less POST is valid: express leaves `req.body` undefined.
      const { taskId } = parseRequestInput(optInRoomFocusRequestSchema, req.body ?? {});
      parseRequestInput(noQuerySchema, req.query);
      const { session, created } = await service.optIn(userId, roomId, taskId);
      res.status(created ? 201 : 200).json({ session });
    })().catch(next);
  });

  router.delete(roomFocusParticipationPath, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      await limitWrites(userId);
      const { roomId } = parseRequestInput(roomFocusParamsSchema, req.params);
      parseRequestInput(noQuerySchema, req.query);
      const { session } = await service.optOut(userId, roomId);
      if (session === null) {
        throw new AppError('NOT_FOUND', 404, 'You have no focus participation in this room.');
      }
      res.status(200).json({ session });
    })().catch(next);
  });

  router.get(roomFocusParticipationPath, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      const { roomId } = parseRequestInput(roomFocusParamsSchema, req.params);
      parseRequestInput(noQuerySchema, req.query);
      res.status(200).json(await service.state(userId, roomId));
    })().catch(next);
  });

  return router;
};
