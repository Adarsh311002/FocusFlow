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
  /**
   * One tick: check the epoch, publish, then run the tick handlers. Used on reconnect.
   * Never rejects: a failed step is logged and runs again on the next tick.
   */
  readonly tick: (reason: 'tick' | 'reconnect') => Promise<void>;
  /** Publishes a heartbeat without an epoch check (used by local recovery). */
  readonly publish: () => Promise<void>;
  /**
   * Runs when a heartbeat finds this instance missing from the live set although it had
   * published before: another instance's reconciler declared it dead (for example after a
   * long pause) and removed its presence. The handler re-adds what was removed. If a
   * handler fails, the rejoin stays pending and runs again on the next heartbeat (the
   * ZADD itself reports the missing member only once).
   */
  readonly onRejoined: (handler: () => unknown) => void;
  /**
   * Runs after every successful heartbeat (the presence sync, Phase 4A). A failure is
   * logged and the handler runs again on the next tick.
   */
  readonly onTick: (handler: () => unknown) => void;
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
  let published = false;
  let rejoinPending = false;
  const rejoinHandlers: (() => unknown)[] = [];
  const tickHandlers: (() => unknown)[] = [];

  const publish = async (): Promise<void> => {
    const nowMs = await redisTimeMs(redis);
    // ZADD answers 1 only when the member was not in the set.
    const added = (await redis.zadd(redisKeys.instances, nowMs, instanceId)) === 1;
    if (added && published) {
      logger.warn({ instanceId }, 'Instance was missing from the live set; re-adding its state');
      rejoinPending = true;
    }
    published = true;
    if (rejoinPending) {
      for (const handler of rejoinHandlers) {
        await handler();
      }
      rejoinPending = false;
    }
  };

  const tick = async (reason: 'tick' | 'reconnect'): Promise<void> => {
    try {
      await epoch.check(reason);
      await publish();
    } catch (error) {
      // Redis is down or flaky: the next tick (or the reconnect) tries again. Other
      // instances may briefly see this one as dead, which only hides its presence.
      logger.warn({ err: error, instanceId, reason }, 'Instance heartbeat failed');
      return;
    }
    for (const handler of tickHandlers) {
      try {
        await handler();
      } catch (error) {
        logger.warn(
          { err: error, instanceId, reason },
          'Heartbeat step failed; retrying next tick',
        );
      }
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
      published = false;
      rejoinPending = false;
      try {
        await redis.zrem(redisKeys.instances, instanceId);
      } catch (error) {
        logger.warn({ err: error, instanceId }, 'Could not remove the instance heartbeat');
      }
    },
    tick,
    publish,
    onRejoined: (handler) => {
      rejoinHandlers.push(handler);
    },
    onTick: (handler) => {
      tickHandlers.push(handler);
    },
  };
};
