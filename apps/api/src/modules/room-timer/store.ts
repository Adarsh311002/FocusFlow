import { timerPhaseSchema, timerStatusSchema } from '@focus-flow/contracts';
import type { Redis } from 'ioredis';
import { z } from 'zod';

import { redisTimeReplyToMs } from '../../platform/redis.js';
import { redisKeys } from '../../platform/redis-keys.js';
import type { RoomTimerStore, TimerRead, TimerState } from './types.js';

// The room timer in Redis (docs/architecture/redis-keys.md, RT1, RT2, RT13). The hash
// `ff:room:{roomId}:timer` is the state; the sorted set `ff:rooms:timers:running` (roomId
// scored by `endsAtMs`) is the reconciler's index of running timers. They change together,
// in the one small script below, which compares the stored version and writes: it holds no
// timer rules (those are the pure machine's).

// KEYS: the timer hash, the running index. ARGV: expected version ('' = the key must not
// exist), the roomId, the six fields (phase, status, durationMs, elapsedBeforeMs,
// segmentStartedAtMs or '', version), endsAtMs or '' (not running).
// Replies 1 on success and 0 on a version conflict.
const WRITE_SCRIPT = `
if ARGV[1] == '' then
  if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
else
  local current = redis.call('HGET', KEYS[1], 'version')
  if current ~= ARGV[1] then return 0 end
end
redis.call('HSET', KEYS[1],
  'phase', ARGV[3], 'status', ARGV[4], 'durationMs', ARGV[5],
  'elapsedBeforeMs', ARGV[6], 'segmentStartedAtMs', ARGV[7], 'version', ARGV[8])
if ARGV[9] == '' then
  redis.call('ZREM', KEYS[2], ARGV[2])
else
  redis.call('ZADD', KEYS[2], ARGV[9], ARGV[2])
end
return 1
`;

// KEYS: the timer hash, the running index. ARGV: the roomId. Removes the index member only
// when the timer is absent or not running; never a running timer's. Replies 1 if it removed.
const FORGET_SCRIPT = `
if redis.call('HGET', KEYS[1], 'status') == 'running' then return 0 end
return redis.call('ZREM', KEYS[2], ARGV[1])
`;

const count = z.string().regex(/^\d+$/).transform(Number);

const hashSchema = z
  .object({
    phase: timerPhaseSchema,
    status: timerStatusSchema,
    durationMs: count,
    elapsedBeforeMs: count,
    // '' is how the script stores "not running" (a hash field cannot be null).
    segmentStartedAtMs: z.union([z.literal('').transform(() => null), count]),
    version: count,
  })
  .refine(
    (hash) =>
      hash.elapsedBeforeMs <= hash.durationMs &&
      (hash.status === 'running') === (hash.segmentStartedAtMs !== null),
    'inconsistent timer state',
  );

/**
 * A missing key (an empty hash) is absent. A hash that is present but malformed or
 * inconsistent is never treated as absent (that would let the next write silently replace
 * state nobody understands): reading it throws, and the caller surfaces an internal error.
 * Only a bug or outside tampering can produce one: the script writes every field at once.
 */
const parseHash = (roomId: string, hash: Record<string, string>): TimerState | undefined => {
  if (Object.keys(hash).length === 0) {
    return undefined;
  }
  const parsed = hashSchema.safeParse(hash);
  if (!parsed.success) {
    throw new Error(`the stored timer of room ${roomId} is malformed`);
  }
  return parsed.data;
};

const replyOf = (replies: [Error | null, unknown][] | null, index: number): unknown => {
  if (replies === null) {
    throw new Error('the timer read transaction was aborted');
  }
  const entry = replies[index];
  if (entry === undefined || entry[0] !== null) {
    throw entry?.[0] ?? new Error('the timer read transaction failed');
  }
  return entry[1];
};

const stringList = (reply: unknown): string[] => {
  if (
    !Array.isArray(reply) ||
    !reply.every((value: unknown): value is string => typeof value === 'string')
  ) {
    throw new Error('unexpected Redis reply: expected a list of strings');
  }
  return reply;
};

export const createRoomTimerStore = (redis: Redis): RoomTimerStore => ({
  read: async (roomId): Promise<TimerRead> => {
    const replies = await redis.multi().hgetall(redisKeys.roomTimer(roomId)).time().exec();
    const hash: unknown = replyOf(replies, 0);
    if (typeof hash !== 'object' || hash === null) {
      throw new Error('unexpected Redis HGETALL reply');
    }
    return {
      state: parseHash(
        roomId,
        Object.fromEntries(Object.entries(hash).map(([key, value]) => [key, String(value)])),
      ),
      nowMs: redisTimeReplyToMs(replyOf(replies, 1)),
    };
  },

  write: async (roomId, expectedVersion, next) => {
    const endsAtMs =
      next.status === 'running' && next.segmentStartedAtMs !== null
        ? next.segmentStartedAtMs + next.durationMs - next.elapsedBeforeMs
        : null;
    const reply: unknown = await redis.eval(
      WRITE_SCRIPT,
      2,
      redisKeys.roomTimer(roomId),
      redisKeys.runningTimers,
      expectedVersion === null ? '' : String(expectedVersion),
      roomId,
      next.phase,
      next.status,
      String(next.durationMs),
      String(next.elapsedBeforeMs),
      next.segmentStartedAtMs === null ? '' : String(next.segmentStartedAtMs),
      String(next.version),
      endsAtMs === null ? '' : String(endsAtMs),
    );
    if (reply !== 0 && reply !== 1) {
      throw new Error('unexpected Redis script reply');
    }
    return reply === 1 ? 'ok' : 'conflict';
  },

  forget: async (roomId) => {
    const reply: unknown = await redis.eval(
      FORGET_SCRIPT,
      2,
      redisKeys.roomTimer(roomId),
      redisKeys.runningTimers,
      roomId,
    );
    if (reply !== 0 && reply !== 1) {
      throw new Error('unexpected Redis script reply');
    }
    return reply === 1;
  },

  due: async (nowMs, limit) =>
    stringList(
      await redis.zrangebyscore(redisKeys.runningTimers, '-inf', String(nowMs), 'LIMIT', 0, limit),
    ),

  running: async (offset, limit) => {
    const flat = stringList(
      await redis.zrange(
        redisKeys.runningTimers,
        String(offset),
        String(offset + limit - 1),
        'WITHSCORES',
      ),
    );
    const entries: { roomId: string; endsAtMs: number }[] = [];
    for (let index = 0; index + 1 < flat.length; index += 2) {
      entries.push({ roomId: flat[index] ?? '', endsAtMs: Number(flat[index + 1]) });
    }
    return entries;
  },
});
