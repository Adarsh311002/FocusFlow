import {
  type FocusSessionView,
  type OptInRoomFocusRequest,
  optInRoomFocusRequestSchema,
  type RoomFocusSessionResponse,
  roomFocusSessionResponseSchema,
  type RoomFocusStateResponse,
  roomFocusStateResponseSchema,
  type RoomId,
  roomPath,
  roomPaths,
} from '@focus-flow/contracts';

import { ApiError } from '../../lib/api-client';
import { authedApiRequest } from '../auth/auth-client';

// Typed calls for room focus participation (docs/api/rest.md, "Rooms": focus-participation).
// Every response is validated against the shared contract before it reaches a component.

const focusParticipationPath = (roomId: RoomId): string =>
  `${roomPath(roomPaths.item, { roomId })}/focus-participation`;

/** `GET`: the current run, who is in it, and the caller's own session. Member only. */
export function getRoomFocusState(roomId: RoomId): Promise<RoomFocusStateResponse> {
  return authedApiRequest(focusParticipationPath(roomId), roomFocusStateResponseSchema);
}

/** `POST` (201, or 200 when a half-completed opt-in of this same run is repaired). */
export async function optInRoomFocus(
  roomId: RoomId,
  request: OptInRoomFocusRequest,
): Promise<FocusSessionView> {
  const body = await authedApiRequest<RoomFocusSessionResponse>(
    focusParticipationPath(roomId),
    roomFocusSessionResponseSchema,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(optInRoomFocusRequestSchema.parse(request)),
    },
  );
  return body.session;
}

/** `DELETE`: opt out. Repeatable; does not need the person to be present. */
export async function optOutRoomFocus(roomId: RoomId): Promise<FocusSessionView> {
  const body = await authedApiRequest<RoomFocusSessionResponse>(
    focusParticipationPath(roomId),
    roomFocusSessionResponseSchema,
    { method: 'DELETE' },
  );
  return body.session;
}

/** True for the 409 answers that mean "the picture you acted on has changed". */
export const isStaleFocusAnswer = (error: unknown): boolean =>
  error instanceof ApiError &&
  (error.code === 'RUN_CHANGED' ||
    error.code === 'RUN_ENDING' ||
    error.code === 'NOT_FOCUS_PHASE' ||
    error.code === 'SESSION_IN_PROGRESS');
