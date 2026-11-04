import {
  type CreateRoomRequest,
  DEFAULT_ROOM_TIMER_SETTINGS,
  type RoomListItem,
  type RoomLookupResponse,
  type RoomMembershipView,
  type RoomMemberView,
  type RoomView,
  type UpdateRoomTimerSettingsRequest,
} from '@focus-flow/contracts';
import type { Logger } from 'pino';
import { uuidv7 } from 'uuidv7';

import type { Db } from '../../db/client.js';
import { isUniqueViolation } from '../../db/pg-errors.js';
import { AppError, appError } from '../../platform/http/errors.js';
import { generateRoomCode } from './code.js';
import type { RoomLive } from './ports.js';
import {
  deleteMembership,
  findMember,
  findMembershipJoinedAt,
  findRoomByCode,
  findRoomById,
  insertMembershipIfAbsent,
  insertRoom,
  listMembers,
  listRoomsOfMember,
  type RoomRow,
  updateRoomSettings,
  userExists,
} from './queries.js';
import {
  toMembershipView,
  toMemberView,
  toRoomPreview,
  toRoomView,
  toTimerSettings,
} from './views.js';

// Rooms and membership (Phase 6; docs/api/rest.md "Rooms", decisions D8, D9, D10, D16,
// M1–M10). PostgreSQL decides; `live` (Redis and sockets) is called only after the commit,
// and an announcement that fails never changes the answer.

export type RoomsDeps = {
  readonly db: Db;
  readonly live: RoomLive;
  readonly logger: Logger;
  /** Test seam: the room code generator (defaults to `generateRoomCode`). */
  readonly generateCode?: () => string;
};

/** Attempts to find an unused code before giving up (M2). */
export const MAX_CODE_ATTEMPTS = 5;

/** One answer for "no such room" and "not your room" (M4). */
const roomNotFound = (): AppError => appError('ROOM_NOT_FOUND', 'Room not found.');

/** Redis-backed state is needed and unreachable: nothing was changed. */
const liveUnavailable = (): AppError =>
  new AppError('INTERNAL', 503, 'Live room state is temporarily unavailable. Try again shortly.');

/** Runs a post-commit call; a failure is logged and never reaches the client. */
const afterCommit = async (
  deps: RoomsDeps,
  what: string,
  roomId: string,
  action: () => Promise<void>,
): Promise<void> => {
  try {
    await action();
  } catch (err) {
    deps.logger.error({ err, roomId, what }, 'Room live follow-up failed after commit');
  }
};

// ---- Create ---------------------------------------------------------------------------

export const createRoom = async (
  deps: RoomsDeps,
  userId: string,
  input: CreateRoomRequest,
): Promise<RoomView> => {
  const generate = deps.generateCode ?? generateRoomCode;
  const settings = { ...DEFAULT_ROOM_TIMER_SETTINGS, ...definedOnly(input.timerSettings) };

  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
    try {
      const row = await deps.db.transaction(async (tx) => {
        const room = await insertRoom(tx, {
          id: uuidv7(),
          code: generate(),
          name: input.name,
          hostId: userId,
          isPrivate: input.isPrivate,
          ...settings,
        });
        await insertMembershipIfAbsent(tx, room.id, userId);
        return room;
      });
      return toRoomView(row);
    } catch (error) {
      // The only unique constraint a fresh UUIDv7 id can hit is the code.
      if (!isUniqueViolation(error)) {
        throw error;
      }
    }
  }
  deps.logger.error({ attempts: MAX_CODE_ATTEMPTS }, 'Could not find an unused room code');
  throw new AppError('INTERNAL', 503, 'Could not create the room right now. Try again.');
};

const definedOnly = (
  input: Partial<Record<string, number | undefined>> | undefined,
): Partial<Record<'focusSeconds' | 'shortBreakSeconds' | 'longBreakSeconds', number>> => ({
  ...(input?.focusSeconds === undefined ? {} : { focusSeconds: input.focusSeconds }),
  ...(input?.shortBreakSeconds === undefined ? {} : { shortBreakSeconds: input.shortBreakSeconds }),
  ...(input?.longBreakSeconds === undefined ? {} : { longBreakSeconds: input.longBreakSeconds }),
});

// ---- Reads ----------------------------------------------------------------------------

const presentCountsOrZero = async (
  deps: RoomsDeps,
  roomIds: readonly string[],
): Promise<ReadonlyMap<string, number>> => {
  if (roomIds.length === 0) {
    return new Map();
  }
  try {
    return await deps.live.presentCounts(roomIds);
  } catch (err) {
    deps.logger.warn({ err }, 'Present counts unavailable; answering 0');
    return new Map();
  }
};

export const listMyRooms = async (deps: RoomsDeps, userId: string): Promise<RoomListItem[]> => {
  const rows = await listRoomsOfMember(deps.db, userId);
  const counts = await presentCountsOrZero(
    deps,
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({ ...toRoomView(row), presentCount: counts.get(row.id) ?? 0 }));
};

/** The room, when the user is a member (the host always is); otherwise ROOM_NOT_FOUND (M4). */
const requireMemberRoom = async (
  deps: RoomsDeps,
  userId: string,
  roomId: string,
): Promise<RoomRow> => {
  const room = await findRoomById(deps.db, roomId);
  if (room === undefined) {
    throw roomNotFound();
  }
  const isMember =
    room.hostId === userId || (await findMembershipJoinedAt(deps.db, roomId, userId)) !== undefined;
  if (!isMember) {
    throw roomNotFound();
  }
  return room;
};

/** The room, when the user is its host; a non-host member gets NOT_HOST, anyone else 404. */
const requireHostRoom = async (
  deps: RoomsDeps,
  userId: string,
  roomId: string,
): Promise<RoomRow> => {
  const room = await requireMemberRoom(deps, userId, roomId);
  if (room.hostId !== userId) {
    throw appError('NOT_HOST', 'Only the host can do this.');
  }
  return room;
};

export const getRoom = async (deps: RoomsDeps, userId: string, roomId: string): Promise<RoomView> =>
  toRoomView(await requireMemberRoom(deps, userId, roomId));

export const lookupRoomByCode = async (
  deps: RoomsDeps,
  userId: string,
  code: string,
): Promise<RoomLookupResponse> => {
  const room = await findRoomByCode(deps.db, code);
  if (room === undefined) {
    throw roomNotFound();
  }
  const isHost = room.hostId === userId;
  const isMember = isHost || (await findMembershipJoinedAt(deps.db, room.id, userId)) !== undefined;

  if (!isMember && room.isPrivate) {
    // Nothing about the room beyond the preview, not even who is in it.
    return { access: 'must_knock', room: toRoomPreview(room), presentCount: null };
  }
  const presentCount = (await presentCountsOrZero(deps, [room.id])).get(room.id) ?? 0;
  if (!isMember) {
    return { access: 'can_join', room: toRoomPreview(room), presentCount };
  }
  return { access: isHost ? 'host' : 'member', room: toRoomView(room), presentCount };
};

export const listRoomMembers = async (
  deps: RoomsDeps,
  userId: string,
  roomId: string,
): Promise<RoomMemberView[]> => {
  const room = await requireMemberRoom(deps, userId, roomId);
  const rows = await listMembers(deps.db, roomId);
  return rows.map((row) => toMemberView(row, room.hostId));
};

// ---- Settings -------------------------------------------------------------------------

export const updateTimerSettings = async (
  deps: RoomsDeps,
  userId: string,
  roomId: string,
  input: UpdateRoomTimerSettingsRequest,
): Promise<RoomView> => {
  await requireHostRoom(deps, userId, roomId);
  const updated = await updateRoomSettings(deps.db, roomId, input);
  if (updated === undefined) {
    throw roomNotFound();
  }
  await afterCommit(deps, 'announceSettingsUpdated', roomId, () =>
    deps.live.announceSettingsUpdated(roomId, toTimerSettings(updated)),
  );
  return toRoomView(updated);
};

// ---- Membership -----------------------------------------------------------------------

export type MembershipResult = {
  readonly membership: RoomMembershipView;
  readonly created: boolean;
};

/**
 * Upserts a membership and reports whether this call created it. `ON CONFLICT DO NOTHING`
 * makes concurrent calls safe: exactly one inserts.
 */
const ensureMembership = async (
  deps: RoomsDeps,
  room: RoomRow,
  memberUserId: string,
): Promise<MembershipResult> => {
  const insertedAt = await insertMembershipIfAbsent(deps.db, room.id, memberUserId);
  if (insertedAt !== undefined) {
    return { membership: toMembershipView(room.id, memberUserId, insertedAt), created: true };
  }
  const joinedAt = await findMembershipJoinedAt(deps.db, room.id, memberUserId);
  if (joinedAt === undefined) {
    // Removed between the conflict and this read; the caller can simply retry.
    throw roomNotFound();
  }
  return { membership: toMembershipView(room.id, memberUserId, joinedAt), created: false };
};

const announceJoined = (deps: RoomsDeps, room: RoomRow, memberUserId: string): Promise<void> =>
  afterCommit(deps, 'announceMemberJoined', room.id, async () => {
    const member = await findMember(deps.db, room.id, memberUserId);
    // Already gone again (removed right after joining): nothing to announce.
    if (member !== undefined) {
      await deps.live.announceMemberJoined(room.id, toMemberView(member, room.hostId));
    }
  });

export const joinRoom = async (
  deps: RoomsDeps,
  userId: string,
  roomId: string,
): Promise<MembershipResult> => {
  const room = await findRoomById(deps.db, roomId);
  if (room === undefined) {
    throw roomNotFound();
  }
  if (room.isPrivate && room.hostId !== userId) {
    // A member of a private room "joins" again idempotently; anyone else must knock.
    if ((await findMembershipJoinedAt(deps.db, roomId, userId)) === undefined) {
      throw appError('KNOCK_REQUIRED', 'This room is private. Knock to ask the host.');
    }
  }
  const result = await ensureMembership(deps, room, userId);
  if (result.created) {
    await announceJoined(deps, room, userId);
  }
  return result;
};

export const leaveRoom = async (deps: RoomsDeps, userId: string, roomId: string): Promise<void> => {
  const room = await findRoomById(deps.db, roomId);
  if (room === undefined) {
    return;
  }
  if (room.hostId === userId) {
    throw appError('HOST_CANNOT_LEAVE', 'The host cannot leave their own room.');
  }
  if (await deleteMembership(deps.db, roomId, userId)) {
    await afterCommit(deps, 'announceMemberRemoved', roomId, () =>
      deps.live.announceMemberRemoved(roomId, userId, 'left'),
    );
  }
};

export const removeMember = async (
  deps: RoomsDeps,
  hostUserId: string,
  roomId: string,
  targetUserId: string,
): Promise<void> => {
  const room = await requireHostRoom(deps, hostUserId, roomId);
  if (room.hostId === targetUserId) {
    throw appError('CANNOT_REMOVE_HOST', 'The host cannot be removed from their own room.');
  }
  if (await deleteMembership(deps.db, roomId, targetUserId)) {
    await afterCommit(deps, 'announceMemberRemoved', roomId, () =>
      deps.live.announceMemberRemoved(roomId, targetUserId, 'removed'),
    );
  }
};

// ---- Knocks ---------------------------------------------------------------------------

const approvalChains = new Map<string, Promise<unknown>>();

/**
 * Approvals of one knock run one after another within this process, so two parallel
 * approvals cannot race each other's compensation (below): the second simply finds the
 * membership the first created. Across processes the race is limited to a double approval
 * colliding with a reject, which the Redis removal still settles.
 */
const serializedApproval = <T>(key: string, work: () => Promise<T>): Promise<T> => {
  const previous = approvalChains.get(key) ?? Promise.resolve();
  const run = previous.then(work, work);
  const tail = run.catch(() => undefined);
  approvalChains.set(key, tail);
  void tail.then(() => {
    if (approvalChains.get(key) === tail) {
      approvalChains.delete(key);
    }
  });
  return run;
};

export const approveKnock = (
  deps: RoomsDeps,
  hostUserId: string,
  roomId: string,
  targetUserId: string,
): Promise<MembershipResult> =>
  serializedApproval(`${roomId}:${targetUserId}`, () =>
    approveKnockOnce(deps, hostUserId, roomId, targetUserId),
  );

const approveKnockOnce = async (
  deps: RoomsDeps,
  hostUserId: string,
  roomId: string,
  targetUserId: string,
): Promise<MembershipResult> => {
  const room = await requireHostRoom(deps, hostUserId, roomId);
  if (!room.isPrivate) {
    throw appError('NOT_PRIVATE', 'Only a private room has knocks.');
  }

  const existing = await findMembershipJoinedAt(deps.db, roomId, targetUserId);
  if (existing !== undefined) {
    // No knock needed; clear a stale one if there is any.
    await afterCommit(deps, 'resolveKnock', roomId, async () => {
      await deps.live.resolveKnock(roomId, hostUserId, targetUserId, 'approved');
    });
    return { membership: toMembershipView(roomId, targetUserId, existing), created: false };
  }

  let pending: boolean;
  try {
    pending = await deps.live.isKnockPending(roomId, targetUserId);
  } catch (err) {
    deps.logger.warn({ err, roomId }, 'Knock state unavailable');
    throw liveUnavailable();
  }
  if (!pending || !(await userExists(deps.db, targetUserId))) {
    throw appError('KNOCK_EXPIRED', 'This knock is no longer pending.');
  }

  const result = await ensureMembership(deps, room, targetUserId);
  // The Redis removal is the gate against a racing reject: only the call that removes the
  // knock may tell the requester "approved". A failed removal is logged and never changes
  // the answer (the membership is committed); the knock simply expires.
  let removed = true;
  try {
    removed = await deps.live.resolveKnock(roomId, hostUserId, targetUserId, 'approved');
  } catch (err) {
    deps.logger.error(
      { err, roomId, what: 'resolveKnock' },
      'Room live follow-up failed after commit',
    );
  }
  if (!removed) {
    // A reject (or the knock's expiry) won after the check: the requester was told
    // "rejected", so undo the membership this call created. A call that only found an
    // existing membership (a concurrent approve created it) keeps it if still there.
    if (result.created) {
      await deleteMembership(deps.db, roomId, targetUserId);
    } else if ((await findMembershipJoinedAt(deps.db, roomId, targetUserId)) !== undefined) {
      return result;
    }
    throw appError('KNOCK_EXPIRED', 'This knock is no longer pending.');
  }
  if (result.created) {
    await announceJoined(deps, room, targetUserId);
  }
  return result;
};

export const rejectKnock = async (
  deps: RoomsDeps,
  hostUserId: string,
  roomId: string,
  targetUserId: string,
): Promise<void> => {
  await requireHostRoom(deps, hostUserId, roomId);
  try {
    await deps.live.resolveKnock(roomId, hostUserId, targetUserId, 'rejected');
  } catch (err) {
    deps.logger.warn({ err, roomId }, 'Knock state unavailable');
    throw liveUnavailable();
  }
};
