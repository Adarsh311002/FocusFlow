import {
  type CreateRoomRequest,
  roomByCodePath,
  type RoomId,
  type RoomListItem,
  roomListResponseSchema,
  type RoomLookupResponse,
  roomLookupResponseSchema,
  roomMembershipResponseSchema,
  roomMembersResponseSchema,
  type RoomMemberView,
  roomPath,
  roomPaths,
  roomResponseSchema,
  type RoomTimerSettingsInput,
  type RoomView,
  type UserId,
} from '@focus-flow/contracts';

import { authedApiRequest, authedApiRequestNoContent } from '../auth/auth-client';

// Typed calls for the room routes (docs/api/rest.md, "Rooms"). Every response is validated
// against the shared contract before it reaches a component.

function jsonBody(method: 'POST' | 'PATCH', body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export async function listMyRooms(): Promise<RoomListItem[]> {
  const body = await authedApiRequest(`${roomPaths.collection}?scope=mine`, roomListResponseSchema);
  return body.rooms;
}

export async function createRoom(request: CreateRoomRequest): Promise<RoomView> {
  const body = await authedApiRequest(
    roomPaths.collection,
    roomResponseSchema,
    jsonBody('POST', request),
  );
  return body.room;
}

/** `code` is sent as typed: the server forgives case and whitespace (M2). */
export function lookupRoomByCode(code: string): Promise<RoomLookupResponse> {
  return authedApiRequest(roomByCodePath(code), roomLookupResponseSchema);
}

export async function getRoom(roomId: RoomId): Promise<RoomView> {
  const body = await authedApiRequest(roomPath(roomPaths.item, { roomId }), roomResponseSchema);
  return body.room;
}

export async function getRoomMembers(roomId: RoomId): Promise<RoomMemberView[]> {
  const body = await authedApiRequest(
    roomPath(roomPaths.members, { roomId }),
    roomMembersResponseSchema,
  );
  return body.members;
}

/** Public rooms only; idempotent (D9). Private rooms answer `403 KNOCK_REQUIRED`. */
export async function joinPublicRoom(roomId: RoomId): Promise<void> {
  await authedApiRequest(roomPath(roomPaths.membership, { roomId }), roomMembershipResponseSchema, {
    method: 'POST',
  });
}

/** Leaves for good (the membership is deleted); the host answers `409 HOST_CANNOT_LEAVE`. */
export function leaveRoomPermanently(roomId: RoomId): Promise<void> {
  return authedApiRequestNoContent(roomPath(roomPaths.membership, { roomId }), {
    method: 'DELETE',
  });
}

export function removeRoomMember(roomId: RoomId, userId: UserId): Promise<void> {
  return authedApiRequestNoContent(roomPath(roomPaths.member, { roomId, userId }), {
    method: 'DELETE',
  });
}

export async function updateRoomTimerSettings(
  roomId: RoomId,
  settings: RoomTimerSettingsInput,
): Promise<RoomView> {
  const body = await authedApiRequest(
    roomPath(roomPaths.timerSettings, { roomId }),
    roomResponseSchema,
    jsonBody('PATCH', settings),
  );
  return body.room;
}

export async function approveKnock(roomId: RoomId, userId: UserId): Promise<void> {
  await authedApiRequest(
    roomPath(roomPaths.approveKnock, { roomId, userId }),
    roomMembershipResponseSchema,
    { method: 'POST' },
  );
}

export function rejectKnock(roomId: RoomId, userId: UserId): Promise<void> {
  return authedApiRequestNoContent(roomPath(roomPaths.rejectKnock, { roomId, userId }), {
    method: 'POST',
  });
}
