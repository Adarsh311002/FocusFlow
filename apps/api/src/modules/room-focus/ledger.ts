import type { Redis } from 'ioredis';
import { z } from 'zod';

import { redisTimeReplyToMs } from '../../platform/redis.js';
import { redisKeys } from '../../platform/redis-keys.js';
import type { LedgerParticipant, RunLedger, RunRecord, RunSnapshot } from './types.js';

// The run ledger in Redis (RF3, RF7; docs/architecture/redis-keys.md). A run is a hash
// `ff:room:{roomId}:run:{runId}`, its participants a hash userId -> JSON. The run is opened
// and closed by the timer's own atomic write (room-timer/store.ts); this file only adds and
// removes participants and records disconnects. Every script is small and holds no rule: it
// checks a precomputed condition and writes precomputed values. Participant entries are
// replaced by compare-and-swap on the exact stored string, so no script parses JSON.

const count = z.string().regex(/^\d+$/).transform(Number);

const runHashSchema = z.object({
  status: z.enum(['open', 'closed']),
  closeReason: z.enum(['reset', 'phase_changed', 'completed']).optional(),
  openedAtMs: count.optional(),
  closedAtMs: count.optional(),
  elapsedAtCloseMs: count.optional(),
});

const participantSchema = z.object({
  userId: z.string().min(1),
  sessionId: z.string().min(1),
  optedInAtMs: z.number().int().nonnegative(),
  elapsedAtOptInMs: z.number().int().nonnegative(),
  disconnectedAtMs: z.number().int().nonnegative().nullable(),
  elapsedAtDisconnectMs: z.number().int().nonnegative().nullable(),
});

/** Bounded retries of a compare-and-swap that lost a race with another change of the same entry. */
const MAX_CAS_ATTEMPTS = 5;

// KEYS: the timer hash, the run hash, the participants hash. ARGV: the run id, the user id,
// the entry JSON. Replies 0 when the timer is not in this run's open focus phase (nothing
// written), 1 when added, or the existing entry's JSON string (HSETNX never replaces).
const ADD_SCRIPT = `
if redis.call('HGET', KEYS[1], 'phase') ~= 'focus' then return 0 end
if redis.call('HGET', KEYS[1], 'focusRunId') ~= ARGV[1] then return 0 end
if redis.call('HGET', KEYS[2], 'status') ~= 'open' then return 0 end
if redis.call('HSETNX', KEYS[3], ARGV[2], ARGV[3]) == 1 then
  redis.call('HINCRBY', KEYS[2], 'participantsVersion', 1)
  return 1
end
return redis.call('HGET', KEYS[3], ARGV[2])
`;

// KEYS: the timer hash, the run hash, the participants hash. ARGV: the user id, the entry
// JSON the caller read, the replacement JSON, the timer version the elapsed time came from.
// Replies 0 not a participant, 3 run not open, 2 conflict (the entry or the timer version
// changed), 1 replaced.
const MARK_SCRIPT = `
local current = redis.call('HGET', KEYS[3], ARGV[1])
if not current then return 0 end
if redis.call('HGET', KEYS[2], 'status') ~= 'open' then return 3 end
if redis.call('HGET', KEYS[1], 'version') ~= ARGV[4] then return 2 end
if current ~= ARGV[2] then return 2 end
redis.call('HSET', KEYS[3], ARGV[1], ARGV[3])
redis.call('HINCRBY', KEYS[2], 'participantsVersion', 1)
return 1
`;

// KEYS: the participants hash, the run hash. ARGV: the user id, the entry JSON the caller read,
// the replacement. Replies 1 replaced, 0 the entry is no longer exactly that. The version is
// bumped only while the run record exists (HINCRBY would otherwise create a stray record).
const SWAP_SCRIPT = `
if redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
if redis.call('EXISTS', KEYS[2]) == 1 then redis.call('HINCRBY', KEYS[2], 'participantsVersion', 1) end
return 1
`;

// KEYS: the participants hash, the run hash. ARGV: the user id, the entry JSON the caller read.
// Replies 1 when it deleted exactly that entry, 0 when the entry is no longer exactly that.
const REMOVE_SCRIPT = `
if redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call('HDEL', KEYS[1], ARGV[1])
if redis.call('EXISTS', KEYS[2]) == 1 then redis.call('HINCRBY', KEYS[2], 'participantsVersion', 1) end
return 1
`;

// KEYS: the run hash, the participants hash, the unsettled index. ARGV: the index member.
// Never touches an open run or a run that still has participants; replies 1 when it removed
// the record, the participants hash or the index member (so a lost run record cannot keep a
// stale index member forever), else 0.
const FINISH_SCRIPT = `
if redis.call('HGET', KEYS[1], 'status') == 'open' then return 0 end
if redis.call('HLEN', KEYS[2]) > 0 then return 0 end
local removed = redis.call('DEL', KEYS[1], KEYS[2])
removed = removed + redis.call('ZREM', KEYS[3], ARGV[1])
if removed > 0 then return 1 end
return 0
`;

const replyOf = (replies: [Error | null, unknown][] | null, index: number): unknown => {
  if (replies === null) {
    throw new Error('the ledger read transaction was aborted');
  }
  const entry = replies[index];
  if (entry === undefined || entry[0] !== null) {
    throw entry?.[0] ?? new Error('the ledger read transaction failed');
  }
  return entry[1];
};

const stringRecord = (reply: unknown): Record<string, string> => {
  if (typeof reply !== 'object' || reply === null) {
    throw new Error('unexpected Redis HGETALL reply');
  }
  return Object.fromEntries(Object.entries(reply).map(([key, value]) => [key, String(value)]));
};

const parseParticipant = (roomId: string, raw: string): LedgerParticipant => {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`a participant entry of room ${roomId} is malformed`);
  }
  const parsed = participantSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`a participant entry of room ${roomId} is malformed`);
  }
  return parsed.data;
};

/** Fixed key order, so equal entries serialise to equal strings. */
const serialise = (p: LedgerParticipant): string =>
  JSON.stringify({
    userId: p.userId,
    sessionId: p.sessionId,
    optedInAtMs: p.optedInAtMs,
    elapsedAtOptInMs: p.elapsedAtOptInMs,
    disconnectedAtMs: p.disconnectedAtMs,
    elapsedAtDisconnectMs: p.elapsedAtDisconnectMs,
  });

const parseRun = (roomId: string, runId: string, hash: Record<string, string>) => {
  if (Object.keys(hash).length === 0) {
    return undefined;
  }
  const parsed = runHashSchema.safeParse(hash);
  if (!parsed.success) {
    throw new Error(`the stored run ${runId} of room ${roomId} is malformed`);
  }
  const data = parsed.data;
  const run: RunRecord = {
    roomId,
    runId,
    status: data.status,
    closeReason: data.closeReason ?? null,
    openedAtMs: data.openedAtMs ?? 0,
    closedAtMs: data.closedAtMs ?? null,
    elapsedAtCloseMs: data.elapsedAtCloseMs ?? null,
  };
  return run;
};

/** The participant-list version of the run hash; 0 while the run has had no change. */
const parseRunVersion = (hash: Record<string, string>): number => {
  const raw = hash.participantsVersion;
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : 0;
};

const unexpected = (): never => {
  throw new Error('unexpected Redis script reply');
};

export const createRunLedger = (redis: Redis): RunLedger => {
  const readRaw = async (
    roomId: string,
    runId: string,
    userId: string,
  ): Promise<string | undefined> => {
    const raw = await redis.hget(redisKeys.roomRunParticipants(roomId, runId), userId);
    return raw ?? undefined;
  };

  return {
    read: async (roomId, runId): Promise<RunSnapshot> => {
      const replies = await redis
        .multi()
        .hgetall(redisKeys.roomRun(roomId, runId))
        .hgetall(redisKeys.roomRunParticipants(roomId, runId))
        .time()
        .exec();
      const entries = stringRecord(replyOf(replies, 1));
      const runHash = stringRecord(replyOf(replies, 0));
      return {
        run: parseRun(roomId, runId, runHash),
        participants: Object.values(entries).map((raw) => parseParticipant(roomId, raw)),
        participantsVersion: parseRunVersion(runHash),
        nowMs: redisTimeReplyToMs(replyOf(replies, 2)),
      };
    },

    addParticipant: async (roomId, runId, participant) => {
      const reply: unknown = await redis.eval(
        ADD_SCRIPT,
        3,
        redisKeys.roomTimer(roomId),
        redisKeys.roomRun(roomId, runId),
        redisKeys.roomRunParticipants(roomId, runId),
        runId,
        participant.userId,
        serialise(participant),
      );
      if (reply === 0) {
        return { result: 'run_changed' };
      }
      if (reply === 1) {
        return { result: 'added' };
      }
      if (typeof reply === 'string') {
        return { result: 'exists', participant: parseParticipant(roomId, reply) };
      }
      return unexpected();
    },

    removeParticipant: async (roomId, runId, userId, sessionId) => {
      // Compare-and-delete on the session: a late cleanup of an ended session must never
      // remove the entry of the user's next session in the same run (Rev J1).
      for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
        const raw = await readRaw(roomId, runId, userId);
        if (raw === undefined || parseParticipant(roomId, raw).sessionId !== sessionId) {
          return false;
        }
        const reply: unknown = await redis.eval(
          REMOVE_SCRIPT,
          2,
          redisKeys.roomRunParticipants(roomId, runId),
          redisKeys.roomRun(roomId, runId),
          userId,
          raw,
        );
        if (reply === 1) {
          return true;
        }
        if (reply !== 0) {
          return unexpected();
        }
      }
      throw new Error(`the ledger entry of user ${userId} in room ${roomId} kept changing`);
    },

    markDisconnected: async (roomId, runId, userId, disconnect) => {
      const raw = await readRaw(roomId, runId, userId);
      if (raw === undefined) {
        return 'not_participant';
      }
      const participant = parseParticipant(roomId, raw);
      if (participant.disconnectedAtMs !== null) {
        return 'already_disconnected';
      }
      const reply: unknown = await redis.eval(
        MARK_SCRIPT,
        3,
        redisKeys.roomTimer(roomId),
        redisKeys.roomRun(roomId, runId),
        redisKeys.roomRunParticipants(roomId, runId),
        userId,
        raw,
        serialise({
          ...participant,
          disconnectedAtMs: disconnect.disconnectedAtMs,
          elapsedAtDisconnectMs: disconnect.elapsedAtDisconnectMs,
        }),
        String(disconnect.timerVersion),
      );
      switch (reply) {
        case 0:
          return 'not_participant';
        case 1:
          return 'marked';
        case 2:
          return 'conflict';
        case 3:
          return 'run_closed';
        default:
          return unexpected();
      }
    },

    clearDisconnected: async (roomId, runId, userId, expectedDisconnectedAtMs) => {
      for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
        const raw = await readRaw(roomId, runId, userId);
        if (raw === undefined) {
          return false;
        }
        const participant = parseParticipant(roomId, raw);
        if (participant.disconnectedAtMs !== expectedDisconnectedAtMs) {
          return false;
        }
        const reply: unknown = await redis.eval(
          SWAP_SCRIPT,
          2,
          redisKeys.roomRunParticipants(roomId, runId),
          redisKeys.roomRun(roomId, runId),
          userId,
          raw,
          serialise({ ...participant, disconnectedAtMs: null, elapsedAtDisconnectMs: null }),
        );
        if (reply === 1) {
          return true;
        }
        if (reply !== 0) {
          return unexpected();
        }
      }
      // The entry kept changing under us: the caller must not read "false" as "no longer
      // this disconnect", so it retries (a job) or defers (the reconciler).
      throw new Error(`the ledger entry of user ${userId} in room ${roomId} kept changing`);
    },

    unsettled: async (limit) => {
      if (limit <= 0) {
        return [];
      }
      const members = await redis.zrange(redisKeys.unsettledRuns, 0, String(limit - 1));
      return members.flatMap((member) => {
        const split = member.indexOf(':');
        return split <= 0 || split === member.length - 1
          ? []
          : [{ roomId: member.slice(0, split), runId: member.slice(split + 1) }];
      });
    },

    finishRun: async (roomId, runId) => {
      const reply: unknown = await redis.eval(
        FINISH_SCRIPT,
        3,
        redisKeys.roomRun(roomId, runId),
        redisKeys.roomRunParticipants(roomId, runId),
        redisKeys.unsettledRuns,
        `${roomId}:${runId}`,
      );
      if (reply !== 0 && reply !== 1) {
        return unexpected();
      }
      return reply === 1;
    },
  };
};
