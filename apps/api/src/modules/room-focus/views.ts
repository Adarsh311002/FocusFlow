import type { RoomFocusParticipant } from '@focus-flow/contracts';
import { type RoomFocusSnapshot, roomFocusSnapshotSchema } from '@focus-flow/contracts';

// Contract shapes of the room focus state (validated, so ids come out branded).

/** No focus run: a break, or a room whose run was lost. */
export const emptyFocusSnapshot = (): RoomFocusSnapshot =>
  roomFocusSnapshotSchema.parse({
    focusRunId: null,
    participants: [],
    participantsVersion: 0,
    me: { participation: null },
  });

export const toFocusSnapshot = (
  focusRunId: string,
  participants: readonly RoomFocusParticipant[],
  participantsVersion: number,
  mySessionId: string | undefined,
): RoomFocusSnapshot =>
  roomFocusSnapshotSchema.parse({
    focusRunId,
    participants,
    participantsVersion,
    me: {
      participation: mySessionId === undefined ? null : { sessionId: mySessionId, focusRunId },
    },
  });
