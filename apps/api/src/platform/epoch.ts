import { randomUUID } from 'node:crypto';

import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import { redisTimeMs } from './redis.js';
import { redisKeys } from './redis-keys.js';

// Redis state-loss detection (docs/architecture/redis-keys.md, "Restart semantics").
// `ff:epoch` is written once with SET NX. Redis can lose its data without any client
// noticing a disconnect (FLUSHALL, restoring an empty snapshot, failing over to an empty
// replica), so every instance compares the epoch it last saw with the current one at
// startup, on every heartbeat and on every reconnect.
//
// The value also records when it was created (`{uuid}.{createdAtMs}`, Redis TIME), for
// diagnostics. Revocation does not depend on it: a missing revocation marker always sends
// the check to PostgreSQL (modules/auth/revocation.ts).

export type EpochValue = { readonly id: string; readonly createdAtMs: number };

const EPOCH_PATTERN = /^([0-9a-f-]{36})\.(\d{1,16})$/;

export const formatEpoch = (epoch: EpochValue): string =>
  `${epoch.id}.${String(epoch.createdAtMs)}`;

/** `undefined` for a missing or malformed value; both mean "cannot trust this epoch". */
export const parseEpoch = (raw: string | null | undefined): EpochValue | undefined => {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const match = EPOCH_PATTERN.exec(raw);
  if (match === null) {
    return undefined;
  }
  const [, id, createdAt] = match;
  if (id === undefined || createdAt === undefined) {
    return undefined;
  }
  return { id, createdAtMs: Number(createdAt) };
};

/** How the current epoch relates to the one this instance saw last. */
export type EpochChange = 'first' | 'unchanged' | 'changed';

export const classifyEpoch = (known: string | undefined, current: string): EpochChange => {
  if (known === undefined) {
    return 'first';
  }
  return known === current ? 'unchanged' : 'changed';
};

export type EpochCheckReason = 'startup' | 'tick' | 'reconnect';

export type EpochCheckResult = {
  readonly epoch: string;
  readonly change: EpochChange;
  /** This instance won the SET NX that created the current epoch. */
  readonly created: boolean;
};

export type RecoveryHandler = () => Promise<void> | void;

export type EpochMonitor = {
  /** Serialised: concurrent callers share one check. */
  readonly check: (reason: EpochCheckReason) => Promise<EpochCheckResult>;
  /**
   * Runs on at most one instance per epoch (the SET NX winner) when an epoch is created,
   * whether on the very first startup or after data loss. It is not guaranteed: the winner
   * can crash before its handlers run, and a failed handler is not retried. (Replacing a
   * malformed epoch can even run it on more than one instance.) Handlers must therefore be
   * idempotent, and anything that must happen after data loss is also covered by the
   * reconciler.
   */
  readonly onGlobalRecovery: (handler: RecoveryHandler) => void;
  /**
   * Runs on every instance that sees the epoch change while it is running: re-assert
   * this instance's own state (heartbeat, presence, job schedules).
   */
  readonly onLocalRecovery: (handler: RecoveryHandler) => void;
  readonly known: () => string | undefined;
};

type EpochDeps = {
  readonly redis: Redis;
  readonly logger: Logger;
  readonly instanceId: string;
};

export const createEpochMonitor = ({ redis, logger, instanceId }: EpochDeps): EpochMonitor => {
  let known: string | undefined;
  let inFlight: Promise<EpochCheckResult> | undefined;
  const globalHandlers: RecoveryHandler[] = [];
  const localHandlers: RecoveryHandler[] = [];

  const runHandlers = async (handlers: RecoveryHandler[], kind: string): Promise<void> => {
    for (const handler of handlers) {
      try {
        await handler();
      } catch (error) {
        logger.error({ err: error, instanceId, kind }, 'Redis recovery step failed');
      }
    }
  };

  /** Reads the current epoch, creating it if missing (or replacing it if unreadable). */
  const establish = async (): Promise<{ current: string; created: boolean }> => {
    const observed = await redis.get(redisKeys.epoch);
    if (observed !== null && parseEpoch(observed) !== undefined) {
      return { current: observed, created: false };
    }

    const candidate = formatEpoch({ id: randomUUID(), createdAtMs: await redisTimeMs(redis) });
    if (observed !== null) {
      // Present but unreadable: never trust it. Replace it; whoever overwrites last
      // wins, and every instance converges on the next check.
      logger.error({ instanceId }, 'Malformed Redis epoch value; replacing it');
      await redis.set(redisKeys.epoch, candidate);
      return { current: candidate, created: true };
    }

    if ((await redis.set(redisKeys.epoch, candidate, 'NX')) === 'OK') {
      return { current: candidate, created: true };
    }
    // Another instance won the race; adopt its value.
    const winner = await redis.get(redisKeys.epoch);
    if (winner === null) {
      throw new Error('the Redis epoch disappeared while it was being established');
    }
    return { current: winner, created: false };
  };

  const doCheck = async (reason: EpochCheckReason): Promise<EpochCheckResult> => {
    const { current, created } = await establish();

    const change = classifyEpoch(known, current);
    known = current;

    if (created) {
      logger.warn(
        { instanceId, reason, epoch: current, firstObservation: change === 'first' },
        'Redis epoch created; running global recovery',
      );
      await runHandlers(globalHandlers, 'global');
    }
    if (change === 'changed') {
      logger.warn(
        { instanceId, reason, epoch: current },
        'Redis epoch changed; running local recovery',
      );
      await runHandlers(localHandlers, 'local');
    }

    return { epoch: current, change, created };
  };

  return {
    check: (reason) => {
      inFlight ??= doCheck(reason).finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
    onGlobalRecovery: (handler) => {
      globalHandlers.push(handler);
    },
    onLocalRecovery: (handler) => {
      localHandlers.push(handler);
    },
    known: () => known,
  };
};
