import type { Redis } from 'ioredis';

import { redisKeys } from '../../platform/redis-keys.js';
import type { DisconnectMarker } from './decision.js';
import {
  type ClearRule,
  formatMarker,
  MARKER_TTL_MS,
  parseMarker,
  planMarkerClear,
  planMarkerRecord,
  type RecordPlan,
} from './marker.js';

// The disconnect marker in Redis (E10). Every change is a compare-and-set: WATCH the key,
// read it, decide with the pure rules in marker.ts, then MULTI/EXEC the write. EXEC
// answers null if another writer changed the key after the WATCH, and the attempt starts
// over, a bounded number of times. No Lua.
//
// WATCH is state of the connection, so the store needs a connection of its own: on the
// shared general client, another module's MULTI could run between this WATCH and this
// EXEC. Operations on that connection are serialised within the process; other processes
// are kept honest by the WATCH itself.

export const MARKER_MAX_ATTEMPTS = 5;

/** The marker changed under every attempt; the caller fails and is retried later. */
export class MarkerContentionError extends Error {
  constructor(userId: string) {
    super(`the disconnect marker of user ${userId} kept changing`);
    this.name = 'MarkerContentionError';
  }
}

export type RecordResult = RecordPlan;

export type DisconnectMarkerStore = {
  /** The user's marker, or `undefined` when there is none (or it is malformed). */
  readonly read: (userId: string) => Promise<DisconnectMarker | undefined>;
  /** Applies the E10 record rules for the user's running session. */
  readonly record: (
    userId: string,
    incoming: DisconnectMarker,
    runningSinceMs: number,
  ) => Promise<RecordResult>;
  /** Deletes the marker only if the rule allows it (always ownership-checked). */
  readonly clear: (userId: string, rule: ClearRule) => Promise<boolean>;
};

type StoreDeps = {
  /** A dedicated connection (with the deployment key prefix) used for nothing else. */
  readonly redis: Redis;
  readonly ttlMs?: number;
  readonly maxAttempts?: number;
};

export const createDisconnectMarkerStore = ({
  redis,
  ttlMs = MARKER_TTL_MS,
  maxAttempts = MARKER_MAX_ATTEMPTS,
}: StoreDeps): DisconnectMarkerStore => {
  let queue: Promise<unknown> = Promise.resolve();
  /** Runs `operation` after every earlier one on this connection has finished. */
  const serialised = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = queue.then(operation, operation);
    queue = run.catch(() => undefined);
    return run;
  };

  const readRaw = async (key: string): Promise<DisconnectMarker | undefined> => {
    const raw = await redis.get(key);
    return raw === null ? undefined : parseMarker(raw);
  };

  /** The write a decision asks for: a new value, a delete, or nothing. */
  type Write = { readonly set: string } | 'delete' | null;

  /**
   * One optimistic transaction: WATCH, read, decide, then MULTI/EXEC the write. Returns
   * `{ done: false }` when EXEC was aborted because the key changed after the WATCH.
   */
  const attempt = async <T>(
    key: string,
    decide: (existing: DisconnectMarker | undefined) => {
      readonly write: Write;
      readonly value: T;
    },
  ): Promise<{ done: true; value: T } | { done: false }> => {
    await redis.watch(key);
    try {
      const plan = decide(await readRaw(key));
      if (plan.write === null) {
        await redis.unwatch();
        return { done: true, value: plan.value };
      }
      const transaction = redis.multi();
      if (plan.write === 'delete') {
        transaction.del(key);
      } else {
        transaction.set(key, plan.write.set, 'PX', ttlMs);
      }
      const result = await transaction.exec();
      return result === null ? { done: false } : { done: true, value: plan.value };
    } catch (error) {
      await redis.unwatch().catch(() => undefined);
      throw error;
    }
  };

  const withRetries = async <T>(
    userId: string,
    once: () => Promise<{ done: true; value: T } | { done: false }>,
  ): Promise<T> => {
    for (let index = 0; index < maxAttempts; index += 1) {
      const outcome = await once();
      if (outcome.done) {
        return outcome.value;
      }
    }
    throw new MarkerContentionError(userId);
  };

  return {
    read: (userId) => serialised(() => readRaw(redisKeys.userDisconnected(userId))),

    record: (userId, incoming, runningSinceMs) =>
      serialised(() =>
        withRetries(userId, () =>
          attempt(redisKeys.userDisconnected(userId), (existing) => {
            const plan = planMarkerRecord(existing, incoming, runningSinceMs);
            return {
              write: plan.action === 'write' ? { set: formatMarker(plan.marker) } : null,
              value: plan,
            };
          }),
        ),
      ),

    clear: (userId, rule) =>
      serialised(() =>
        withRetries(userId, () =>
          attempt(redisKeys.userDisconnected(userId), (existing) => {
            const remove = planMarkerClear(existing, rule);
            return { write: remove ? 'delete' : null, value: remove };
          }),
        ),
      ),
  };
};
