import {
  createRoomRequestSchema,
  listRoomsQuerySchema,
  roomCodeParamsSchema,
  roomMemberParamsSchema,
  roomParamsSchema,
  roomPaths,
  updateRoomTimerSettingsRequestSchema,
} from '@focus-flow/contracts';
import { type RequestHandler, Router } from 'express';
import { z } from 'zod';

import { parseRequestInput } from '../../platform/http/errors.js';
import { getAuthUser } from '../auth/context.js';
import {
  type RateRule,
  ROOM_BLOCK_RATE,
  ROOM_CREATE_RATE,
  ROOM_JOIN_HTTP_RATE,
  ROOM_LOOKUP_RATE,
} from '../room-realtime/limiter.js';
import {
  approveKnock,
  blockMember,
  createRoom,
  getRoom,
  joinRoom,
  leaveRoom,
  listMyRooms,
  listRoomBlocks,
  listRoomMembers,
  lookupRoomByCode,
  rejectKnock,
  removeMember,
  type RoomsDeps,
  unblockMember,
  updateTimerSettings,
} from './service.js';

export type RoomsRouterDeps = RoomsDeps & {
  /** `requireAuth(authDeps)`, built once in platform/http/app.ts. */
  readonly authenticate: RequestHandler;
  /** Per-user abuse limit (Phase 9); throws when refused. Absent -> no limit (unit tests). */
  readonly limit?: (
    rule: RateRule,
    userId: string,
    res: { setHeader: (name: string, value: string) => unknown },
  ) => Promise<void>;
};

/** The by-code lookup takes no query: an unknown key is a 400 like everywhere else. */
const noQuerySchema = z.strictObject({});

/**
 * Thin handlers: parse, call the service, map the result. The acting user is always the
 * authenticated user (`getAuthUser`), never anything the client sends; the strict request
 * schemas reject a body that tries to name a user or a host. `authenticate` is attached
 * per route (see the tasks router for why).
 */
export const createRoomsRouter = (deps: RoomsRouterDeps): Router => {
  const router = Router();
  const { authenticate } = deps;

  router.post(roomPaths.collection, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      await deps.limit?.(ROOM_CREATE_RATE, userId, res);
      const input = parseRequestInput(createRoomRequestSchema, req.body);
      res.status(201).json({ room: await createRoom(deps, userId, input) });
    })().catch(next);
  });

  router.get(roomPaths.collection, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      parseRequestInput(listRoomsQuerySchema, req.query);
      res.status(200).json({ rooms: await listMyRooms(deps, userId) });
    })().catch(next);
  });

  router.get(roomPaths.byCode, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      await deps.limit?.(ROOM_LOOKUP_RATE, userId, res);
      const { code } = parseRequestInput(roomCodeParamsSchema, req.params);
      parseRequestInput(noQuerySchema, req.query);
      res.status(200).json(await lookupRoomByCode(deps, userId, code));
    })().catch(next);
  });

  router.get(roomPaths.item, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      const { roomId } = parseRequestInput(roomParamsSchema, req.params);
      res.status(200).json({ room: await getRoom(deps, userId, roomId) });
    })().catch(next);
  });

  router.patch(roomPaths.timerSettings, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      const { roomId } = parseRequestInput(roomParamsSchema, req.params);
      const input = parseRequestInput(updateRoomTimerSettingsRequestSchema, req.body);
      res.status(200).json({ room: await updateTimerSettings(deps, userId, roomId, input) });
    })().catch(next);
  });

  router.get(roomPaths.members, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      const { roomId } = parseRequestInput(roomParamsSchema, req.params);
      res.status(200).json({ members: await listRoomMembers(deps, userId, roomId) });
    })().catch(next);
  });

  router.post(roomPaths.membership, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      await deps.limit?.(ROOM_JOIN_HTTP_RATE, userId, res);
      const { roomId } = parseRequestInput(roomParamsSchema, req.params);
      const { membership, created } = await joinRoom(deps, userId, roomId);
      res.status(created ? 201 : 200).json({ membership });
    })().catch(next);
  });

  router.delete(roomPaths.membership, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      const { roomId } = parseRequestInput(roomParamsSchema, req.params);
      await leaveRoom(deps, userId, roomId);
      res.status(204).end();
    })().catch(next);
  });

  router.delete(roomPaths.member, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      const params = parseRequestInput(roomMemberParamsSchema, req.params);
      await removeMember(deps, userId, params.roomId, params.userId);
      res.status(204).end();
    })().catch(next);
  });

  // Blocks (B1–B8): host-only. PUT removes the person (if a member) and forbids a rejoin;
  // DELETE lifts the block without making them a member again.
  router.get(roomPaths.blocks, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      const { roomId } = parseRequestInput(roomParamsSchema, req.params);
      res.status(200).json({ blocks: await listRoomBlocks(deps, userId, roomId) });
    })().catch(next);
  });

  router.put(roomPaths.block, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      const params = parseRequestInput(roomMemberParamsSchema, req.params);
      await deps.limit?.(ROOM_BLOCK_RATE, userId, res);
      res
        .status(200)
        .json({ block: await blockMember(deps, userId, params.roomId, params.userId) });
    })().catch(next);
  });

  router.delete(roomPaths.block, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      const params = parseRequestInput(roomMemberParamsSchema, req.params);
      await unblockMember(deps, userId, params.roomId, params.userId);
      res.status(204).end();
    })().catch(next);
  });

  router.post(roomPaths.approveKnock, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      const params = parseRequestInput(roomMemberParamsSchema, req.params);
      const { membership, created } = await approveKnock(
        deps,
        userId,
        params.roomId,
        params.userId,
      );
      res.status(created ? 201 : 200).json({ membership });
    })().catch(next);
  });

  router.post(roomPaths.rejectKnock, authenticate, (req, res, next) => {
    void (async () => {
      const { userId } = getAuthUser(req);
      const params = parseRequestInput(roomMemberParamsSchema, req.params);
      await rejectKnock(deps, userId, params.roomId, params.userId);
      res.status(204).end();
    })().catch(next);
  });

  return router;
};
