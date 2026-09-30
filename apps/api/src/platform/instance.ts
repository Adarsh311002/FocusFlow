import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import type { EpochMonitor } from './epoch.js';
import { redisTimeMs } from './redis.js';
import { redisKeys } from './redis-keys.js';

// Instance liveness (docs/architecture/focus-timing-protocol.md, "Presence"). Every API
// process has a random instance id and publishes a heartbeat into the `instances` sorted
// set, scored by Redis TIME. An instance whose score is older than the TTL is dead: its
// sockets' presence entries are ignored immediately and removed by the reconciler.
// Scoring by Redis TIME (not this host's clock) means two hosts with skewed clocks never
// declare each other dead, and the last heartbeat time survives the instance's death.

export type InstanceHeartbeat = {
  /** Publishes one heartbeat now, then every `intervalMs`. */
  readonly start: () => Promise<void>;
  /** Stops publishing and removes this instance from the live set (clean shutdown). */
  readonly stop: () => Promise<void>;
  /** One tick: check the epoch, then publish. Used on reconnect. */
  readonly tick: (reason: 'tick' | 'reconnect') => Promise<void>;
  /** Publishes a heartbeat without an epoch check (used by local recovery). */
  readonly publish: () => Promise<void>;
};

type HeartbeatDeps = {
  readonly redis: Redis;
  readonly logger: Logger;
  readonly instanceId: string;
  readonly intervalMs: number;
  readonly epoch: EpochMonitor;
};

export const createInstanceHeartbeat = ({
  redis,
  logger,
  instanceId,
  intervalMs,
  epoch,
}: HeartbeatDeps): InstanceHeartbeat => {
  let timer: NodeJS.Timeout | undefined;

  const publish = async (): Promise<void> => {
    const nowMs = await redisTimeMs(redis);
    await redis.zadd(redisKeys.instances, nowMs, instanceId);
  };

  const tick = async (reason: 'tick' | 'reconnect'): Promise<void> => {
    try {
      await epoch.check(reason);
      await publish();
    } catch (error) {
      // Redis is down or flaky: the next tick (or the reconnect) tries again. Other
      // instances may briefly see this one as dead, which only hides its presence.
      logger.warn({ err: error, instanceId, reason }, 'Instance heartbeat failed');
    }
  };

  return {
    start: async () => {
      await tick('tick');
      timer ??= setInterval(() => {
        void tick('tick');
      }, intervalMs);
      // Never keeps a process alive on its own; the HTTP server does that.
      timer.unref();
    },
    stop: async () => {
      clearInterval(timer);
      timer = undefined;
      try {
        await redis.zrem(redisKeys.instances, instanceId);
      } catch (error) {
        logger.warn({ err: error, instanceId }, 'Could not remove the instance heartbeat');
      }
    },
    tick,
    publish,
  };
};
