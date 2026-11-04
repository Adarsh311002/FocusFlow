import type {
  RoomMemberRemovedEvent,
  RoomMemberView,
  RoomTimerSettings,
} from '@focus-flow/contracts';

/**
 * The live side of rooms (Redis presence and knocks, Socket.IO events) as the REST module
 * sees it. The REST module (`modules/rooms`) owns PostgreSQL and permissions; the realtime
 * module (`modules/room-realtime`) implements this and owns Redis and sockets. The
 * boundary is one-way: REST calls into this, never the reverse.
 *
 * Rules every implementation keeps (persist, then emit: docs/api/rest.md "Conventions"):
 * - The `announce…` methods run AFTER the PostgreSQL commit, never throw (a Redis or
 *   emitter failure is logged), and are safe to repeat.
 * - `presentCounts` and `isKnockPending` may reject when Redis is unreachable; callers
 *   decide what that means (the room list degrades to 0 present; approving answers 503).
 */
export type RoomLive = {
  /** People with at least one live socket joined to each room, 0 for rooms nobody is in. */
  readonly presentCounts: (roomIds: readonly string[]) => Promise<ReadonlyMap<string, number>>;

  /** Whether `userId` has an unexpired knock on the room. */
  readonly isKnockPending: (roomId: string, userId: string) => Promise<boolean>;

  /**
   * Removes the knock if present, then tells the requester (`room:knock:resolved`, to
   * `user:{userId}` only) and the host (`room:knock:removed`, to `user:{hostId}`).
   * Used by approve and reject; a repeat with no knock left sends nothing.
   *
   * Resolves `true` only when THIS call removed the knock (the Redis removal is the gate
   * between a racing approve and reject: exactly one caller gets `true`), `false` when
   * there was none. Rejects when the removal itself fails (Redis unreachable); a failed
   * emit after a successful removal is logged and still resolves `true`.
   */
  readonly resolveKnock: (
    roomId: string,
    hostId: string,
    userId: string,
    outcome: 'approved' | 'rejected',
  ) => Promise<boolean>;

  /** `room:member:joined` to the room (a public join, an approved knock). */
  readonly announceMemberJoined: (roomId: string, member: RoomMemberView) => Promise<void>;

  /**
   * The user is no longer a member (they left, or the host removed them): removes their
   * room presence (announcing `room:presence:left` if they were present), takes all their
   * sockets out of the Socket.IO room, and sends `room:member:removed` to the room and to
   * `user:{userId}`.
   */
  readonly announceMemberRemoved: (
    roomId: string,
    userId: string,
    reason: RoomMemberRemovedEvent['reason'],
  ) => Promise<void>;

  /** `room:settings:updated` (effective from the next phase) to the room. */
  readonly announceSettingsUpdated: (
    roomId: string,
    timerSettings: RoomTimerSettings,
  ) => Promise<void>;
};
