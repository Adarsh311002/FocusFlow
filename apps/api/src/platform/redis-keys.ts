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
} as const;
