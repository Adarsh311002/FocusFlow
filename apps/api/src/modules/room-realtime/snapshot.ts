import { type RoomSnapshot, roomSnapshotSchema } from '@focus-flow/contracts';

import type { PendingKnock } from './knocks.js';
import type { RoomRow, UserProfileRow } from './queries.js';
import type { PresentUser } from './store.js';

// The room:join snapshot (M6): the authoritative picture of a room at the moment of
// joining. Assembled from already-read parts so it can be tested without Redis.

export const toRoomView = (room: RoomRow) => ({
  id: room.id,
  code: room.code,
  name: room.name,
  isPrivate: room.isPrivate,
  hostId: room.hostId,
  timerSettings: {
    focusSeconds: room.focusSeconds,
    shortBreakSeconds: room.shortBreakSeconds,
    longBreakSeconds: room.longBreakSeconds,
  },
  createdAt: room.createdAt.toISOString(),
});

export type SnapshotParts = {
  readonly room: RoomRow;
  readonly viewerId: string;
  readonly present: readonly PresentUser[];
  /** Read only for the host; ignored for anyone else. */
  readonly knocks: readonly PendingKnock[];
  readonly knockers: readonly UserProfileRow[];
  readonly serverNowMs: number;
};

/**
 * `pendingKnocks` appears only for the host (and then always, possibly empty). A knocker
 * whose account is gone is left out. Validated against the contract, which also brands the ids.
 */
export const buildSnapshot = (parts: SnapshotParts): RoomSnapshot => {
  const profiles = new Map(parts.knockers.map((user) => [user.id, user]));
  const pendingKnocks =
    parts.room.hostId === parts.viewerId
      ? parts.knocks.flatMap((knock) => {
          const profile = profiles.get(knock.userId);
          return profile === undefined
            ? []
            : [
                {
                  userId: knock.userId,
                  displayName: profile.displayName,
                  avatarUrl: profile.avatarUrl,
                  expiresAtMs: knock.expiresAtMs,
                },
              ];
        })
      : undefined;
  return roomSnapshotSchema.parse({
    room: toRoomView(parts.room),
    presence: parts.present.map(({ userId, displayName, avatarUrl }) => ({
      userId,
      displayName,
      avatarUrl,
    })),
    ...(pendingKnocks === undefined ? {} : { pendingKnocks }),
    serverNowMs: parts.serverNowMs,
  });
};
