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
} as const;
