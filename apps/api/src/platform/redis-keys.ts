// Application Redis keys (docs/architecture/redis-keys.md). They are written without the
// deployment prefix: the general client adds `REDIS_KEY_PREFIX` (default `ff:`, P3) to
// every key, so `epoch` is stored as `ff:epoch`.

export const redisKeys = {
  /** `{uuid}.{createdAtMs}`, set once with SET NX. Missing means Redis lost its data. */
  epoch: 'epoch',
  /** Sorted set: instanceId scored by its last heartbeat (Redis TIME, ms). */
  instances: 'instances',
  /** Set of `{userId}:{socketId}` served by one instance (reverse index for cleanup). */
  instanceSockets: (instanceId: string) => `instance:${instanceId}:sockets`,
  /** Set of `{instanceId}:{socketId}`: every authenticated socket of one user. */
  userSockets: (userId: string) => `user:${userId}:sockets`,
  /**
   * `{sessionId}:{latestDisconnectedAtMs}:{evidence}`: the latest disconnect during the
   * user's running solo session (E10). Changed only with WATCH/MULTI.
   */
  userDisconnected: (userId: string) => `user:${userId}:disconnected`,
  /**
   * When a reconcile run last finished (Redis TIME, ms), written by every run however it was
   * started. Missing or older than 3 × RECONCILER_INTERVAL_MS: runs are not happening, and
   * each worker instance runs the reconciler itself (E23).
   */
  reconcileLastFinished: 'reconcile:last-finished',
  /** Hash: userId → { displayName, avatarUrl, firstJoinedAtMs } of the users present in a room (M5). */
  roomPresence: (roomId: string) => `room:${roomId}:presence`,
  /** Set of `{instanceId}:{socketId}`: one user's sockets joined to a room (M5). */
  roomPresenceSockets: (roomId: string, userId: string) => `room:${roomId}:presence:${userId}`,
  /** Set of `{roomId}:{userId}:{socketId}` served by one instance: the reverse index (M5). */
  instanceRooms: (instanceId: string) => `instance:${instanceId}:rooms`,
  /** Sorted set: the userId of a pending knock, scored by its expiresAtMs (M7). */
  /** Hash: the room timer state (RT1, RT2); created at first access, never expires. */
  roomTimer: (roomId: string) => `room:${roomId}:timer`,
  /** Sorted set: roomId scored by `endsAtMs` of every running timer (the reconciler, RT12). */
  runningTimers: `rooms:timers:running`,
  roomKnocks: (roomId: string) => `room:${roomId}:knocks`,
  /**
   * `SET NX` marker holding `messageId:sentAtMs` for 60 s (M8), per user, room and client
   * message id: the same id sent to another room is another message.
   */
  chatDedupe: (userId: string, roomId: string, clientMessageId: string) =>
    `chat:dedupe:${userId}:${roomId}:${clientMessageId}`,
  /** Fixed-window counter for one action of one user. */
  rateLimit: (action: string, userId: string) => `ratelimit:${action}:${userId}`,
} as const;
