import type { Redis } from 'ioredis';
import { z } from 'zod';

import { redisTimeReplyToMs } from '../../platform/redis.js';
import { redisKeys } from '../../platform/redis-keys.js';
import {
  instanceIndexEntry,
  isLiveEntry,
  type LocalRoomSocket,
  parseIndexEntry,
  planRoomSync,
  type RoomSocketRef,
  userSetEntry,
} from './entries.js';

// Room presence in Redis (docs/architecture/redis-keys.md, M5). Three structures change
// together, so every change that decides "is this user still present?" is one small
// script (the documented exception to "no Lua", which stays free of business rules): it
// reads Redis TIME and the instance heartbeats, edits the sets and the profile hash, and
// answers whether this call made the user's first or last live socket. The first/last
// answer is what the caller announces, so it must come from the same atomic step as the
// write.

export type RoomProfile = {
  readonly displayName: string;
  readonly avatarUrl: string | null;
};

export type PresentUser = RoomProfile & {
  readonly userId: string;
  readonly firstJoinedAtMs: number;
};

export type JoinResult = {
  /** The user had no other live socket in the room: announce `room:presence:joined`. */
  readonly first: boolean;
  /** The room already had `maxPresent` other people and the user was not one: nothing was written. */
  readonly full: boolean;
  readonly nowMs: number;
};

export type LeaveResult = {
  /** The user has no live socket left in the room: announce `room:presence:left`. */
  readonly last: boolean;
  /** This call removed the socket's entry. */
  readonly removed: boolean;
  readonly nowMs: number;
};

export type UserInRoom = { readonly roomId: string; readonly userId: string };

export type RoomSyncResult = {
  /** Sockets this sync added, with whether each made its user newly present. */
  readonly joined: readonly { readonly socket: LocalRoomSocket; readonly first: boolean }[];
  /** Users whose last live socket in a room this sync removed. */
  readonly left: readonly UserInRoom[];
};

export type RoomPresenceStore = {
  /**
   * Records the socket. `maxPresent` (> 0) is checked atomically with the write (F5): a
   * new person is refused (`full`) when that many others with a live socket are present; a
   * person who is already present is never refused. `0` (the default) means no cap.
   */
  readonly join: (
    ref: RoomSocketRef,
    profile: RoomProfile,
    maxPresent?: number,
  ) => Promise<JoinResult>;
  /** Removes one socket's entry of `instanceId` (default: this instance). */
  readonly leave: (ref: RoomSocketRef, instanceId?: string) => Promise<LeaveResult>;
  /**
   * Removes every entry of a user in a room, on every instance (membership ended).
   * Answers whether the user was present.
   */
  readonly evictUser: (roomId: string, userId: string) => Promise<boolean>;
  /** People with a live socket in each room, oldest arrival first. */
  readonly readPresent: (roomIds: readonly string[]) => Promise<Map<string, PresentUser[]>>;
  /**
   * Makes this instance's room entries match its sockets' Socket.IO rooms, both ways.
   * `readLocal` is called after the reverse index was read, and every write is queued in
   * the same synchronous step, so a socket that leaves concurrently is never re-added.
   */
  readonly sync: (readLocal: () => readonly LocalRoomSocket[]) => Promise<RoomSyncResult>;
  /** Removes all room entries of a dead or stopped instance; the users who left rooms. */
  readonly removeInstance: (instanceId: string) => Promise<readonly UserInRoom[]>;
  /**
   * Whether the user has a live socket in the room other than `ref`'s own (several tabs):
   * one socket leaving must not count as the user leaving the room.
   */
  readonly hasOtherLiveSocket: (ref: RoomSocketRef) => Promise<boolean>;
};

// KEYS: instances, the user's socket set, the room's profile hash, the instance's index.
// ARGV: entry, index entry, userId, profile json, instance ttl ms, max present (0 = no cap),
// the already-prefixed key prefix of the room's per-user socket sets (`…room:{id}:presence:`).
const JOIN_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local ttl = tonumber(ARGV[5])
local beats = {}
local flat = redis.call('ZRANGE', KEYS[1], 0, -1, 'WITHSCORES')
for i = 1, #flat, 2 do beats[flat[i]] = tonumber(flat[i + 1]) end
local already = redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1
local live = false
for _, member in ipairs(redis.call('SMEMBERS', KEYS[2])) do
  if member ~= ARGV[1] then
    local instance = string.match(member, '^([^:]+):')
    local beat = instance and beats[instance]
    if beat and beat >= now - ttl then
      live = true
      break
    end
  end
end
local max = tonumber(ARGV[6])
if max > 0 and not live and not already then
  local others = 0
  for _, other in ipairs(redis.call('HKEYS', KEYS[3])) do
    if other ~= ARGV[3] then
      for _, member in ipairs(redis.call('SMEMBERS', ARGV[7] .. other)) do
        local instance = string.match(member, '^([^:]+):')
        local beat = instance and beats[instance]
        if beat and beat >= now - ttl then
          others = others + 1
          break
        end
      end
    end
  end
  if others >= max then
    return { 0, now, 1 }
  end
end
redis.call('SADD', KEYS[2], ARGV[1])
redis.call('SADD', KEYS[4], ARGV[2])
local first = (not live) and (not already)
if first or redis.call('HEXISTS', KEYS[3], ARGV[3]) == 0 then
  local profile = cjson.decode(ARGV[4])
  profile.firstJoinedAtMs = now
  redis.call('HSET', KEYS[3], ARGV[3], cjson.encode(profile))
end
return { first and 1 or 0, now, 0 }
`;

// Same KEYS; ARGV: entry, index entry, userId, instance ttl ms.
const LEAVE_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local ttl = tonumber(ARGV[4])
local beats = {}
local flat = redis.call('ZRANGE', KEYS[1], 0, -1, 'WITHSCORES')
for i = 1, #flat, 2 do beats[flat[i]] = tonumber(flat[i + 1]) end
local removed = redis.call('SREM', KEYS[2], ARGV[1])
redis.call('SREM', KEYS[4], ARGV[2])
local live = false
for _, member in ipairs(redis.call('SMEMBERS', KEYS[2])) do
  local instance = string.match(member, '^([^:]+):')
  local beat = instance and beats[instance]
  if beat and beat >= now - ttl then
    live = true
    break
  end
end
local dropped = 0
if not live then
  dropped = redis.call('HDEL', KEYS[3], ARGV[3])
end
local last = (not live) and (removed == 1 or dropped == 1)
return { last and 1 or 0, removed, now }
`;

const profileSchema = z.object({
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  firstJoinedAtMs: z.number(),
});

const numberTuple = (reply: unknown, length: number): number[] => {
  if (
    !Array.isArray(reply) ||
    reply.length !== length ||
    !reply.every((value: unknown): value is number => typeof value === 'number')
  ) {
    throw new Error('unexpected Redis script reply');
  }
  return reply;
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

/** `ZRANGE … WITHSCORES` → instanceId → last heartbeat. */
const heartbeatsOf = (reply: unknown): Map<string, number> => {
  const heartbeats = new Map<string, number>();
  const flat = stringList(reply);
  for (let index = 0; index + 1 < flat.length; index += 2) {
    heartbeats.set(flat[index] ?? '', Number(flat[index + 1]));
  }
  return heartbeats;
};

const distinctUsers = (refs: readonly UserInRoom[]): UserInRoom[] => {
  const seen = new Map<string, UserInRoom>();
  for (const { roomId, userId } of refs) {
    seen.set(`${roomId}:${userId}`, { roomId, userId });
  }
  return [...seen.values()];
};

type StoreDeps = {
  readonly redis: Redis;
  readonly instanceId: string;
  readonly instanceTtlMs: number;
};

export const createRoomPresenceStore = ({
  redis,
  instanceId,
  instanceTtlMs,
}: StoreDeps): RoomPresenceStore => {
  const keysFor = (ref: RoomSocketRef, onInstance: string): string[] => [
    redisKeys.instances,
    redisKeys.roomPresenceSockets(ref.roomId, ref.userId),
    redisKeys.roomPresence(ref.roomId),
    redisKeys.instanceRooms(onInstance),
  ];

  const runJoin = async (
    ref: RoomSocketRef,
    profile: RoomProfile,
    maxPresent = 0,
  ): Promise<JoinResult> => {
    const keyPrefix = redis.options.keyPrefix ?? '';
    const [first, nowMs, full] = numberTuple(
      await redis.eval(
        JOIN_SCRIPT,
        4,
        ...keysFor(ref, instanceId),
        userSetEntry(instanceId, ref.socketId),
        instanceIndexEntry(ref),
        ref.userId,
        JSON.stringify({ displayName: profile.displayName, avatarUrl: profile.avatarUrl }),
        String(instanceTtlMs),
        String(maxPresent),
        `${keyPrefix}${redisKeys.roomPresenceSockets(ref.roomId, '')}`,
      ),
      3,
    );
    return { first: first === 1, full: full === 1, nowMs: nowMs ?? 0 };
  };

  const runLeave = async (ref: RoomSocketRef, onInstance: string): Promise<LeaveResult> => {
    const [last, removed, nowMs] = numberTuple(
      await redis.eval(
        LEAVE_SCRIPT,
        4,
        ...keysFor(ref, onInstance),
        userSetEntry(onInstance, ref.socketId),
        instanceIndexEntry(ref),
        ref.userId,
        String(instanceTtlMs),
      ),
      3,
    );
    return { last: last === 1, removed: removed === 1, nowMs: nowMs ?? 0 };
  };

  return {
    join: runJoin,

    leave: (ref, onInstance = instanceId) => runLeave(ref, onInstance),

    evictUser: async (roomId, userId) => {
      const setKey = redisKeys.roomPresenceSockets(roomId, userId);
      const members = await redis.smembers(setKey);
      const transaction = redis.multi();
      for (const member of members) {
        const separator = member.indexOf(':');
        if (separator > 0) {
          transaction.srem(
            redisKeys.instanceRooms(member.slice(0, separator)),
            instanceIndexEntry({ roomId, userId, socketId: member.slice(separator + 1) }),
          );
        }
      }
      transaction.del(setKey).hdel(redisKeys.roomPresence(roomId), userId);
      const replies = await transaction.exec();
      if (replies === null) {
        throw new Error('the room eviction transaction was aborted');
      }
      for (const [error] of replies) {
        if (error !== null) {
          throw error;
        }
      }
      const dropped = replies[replies.length - 1]?.[1];
      return members.length > 0 || dropped === 1;
    },

    readPresent: async (roomIds) => {
      const result = new Map<string, PresentUser[]>(roomIds.map((roomId) => [roomId, []]));
      if (roomIds.length === 0) {
        return result;
      }
      const profileReads = redis.pipeline();
      for (const roomId of roomIds) {
        profileReads.hgetall(redisKeys.roomPresence(roomId));
      }
      const profileReplies = (await profileReads.exec()) ?? [];
      const candidates: { roomId: string; user: PresentUser }[] = [];
      profileReplies.forEach(([error, reply], index) => {
        if (error !== null) {
          throw error;
        }
        const roomId = roomIds[index];
        if (roomId === undefined || typeof reply !== 'object' || reply === null) {
          return;
        }
        for (const [userId, raw] of Object.entries(reply)) {
          try {
            const parsed = profileSchema.safeParse(JSON.parse(String(raw)));
            if (parsed.success) {
              candidates.push({ roomId, user: { userId, ...parsed.data } });
            }
          } catch {
            // A value that is not JSON is skipped; the next join rewrites it.
          }
        }
      });
      if (candidates.length === 0) {
        return result;
      }

      const liveness = redis.multi().time().zrange(redisKeys.instances, '0', '-1', 'WITHSCORES');
      for (const { roomId, user } of candidates) {
        liveness.smembers(redisKeys.roomPresenceSockets(roomId, user.userId));
      }
      const replies = await liveness.exec();
      if (replies === null) {
        throw new Error('the room presence read was aborted');
      }
      const values = replies.map(([error, value]) => {
        if (error !== null) {
          throw error;
        }
        return value;
      });
      const nowMs = redisTimeReplyToMs(values[0]);
      const heartbeats = heartbeatsOf(values[1]);
      candidates.forEach(({ roomId, user }, index) => {
        const entries = stringList(values[2 + index]);
        if (entries.some((entry) => isLiveEntry(entry, heartbeats, nowMs, instanceTtlMs))) {
          result.get(roomId)?.push(user);
        }
      });
      for (const users of result.values()) {
        users.sort((a, b) => a.firstJoinedAtMs - b.firstJoinedAtMs);
      }
      return result;
    },

    sync: async (readLocal) => {
      const indexed = await redis.smembers(redisKeys.instanceRooms(instanceId));
      // From here until the last command is queued nothing may await: see the doc above.
      const { missing, stale } = planRoomSync(indexed, readLocal());
      const joins = missing.map(async (socket) => ({
        socket,
        first: (await runJoin(socket, socket)).first,
      }));
      const leaves = stale.map(async (entry) => {
        const ref = parseIndexEntry(entry);
        if (ref === undefined) {
          // Malformed members are dropped from the index.
          await redis.srem(redisKeys.instanceRooms(instanceId), entry);
          return undefined;
        }
        const result = await runLeave(ref, instanceId);
        return result.last ? { roomId: ref.roomId, userId: ref.userId } : undefined;
      });
      const [joined, left] = await Promise.all([Promise.all(joins), Promise.all(leaves)]);
      return {
        joined,
        left: distinctUsers(left.filter((entry) => entry !== undefined)),
      };
    },

    hasOtherLiveSocket: async (ref) => {
      const replies = await redis
        .multi()
        .time()
        .zrange(redisKeys.instances, '0', '-1', 'WITHSCORES')
        .smembers(redisKeys.roomPresenceSockets(ref.roomId, ref.userId))
        .exec();
      if (replies === null) {
        throw new Error('the room presence read was aborted');
      }
      const values = replies.map(([error, value]) => {
        if (error !== null) {
          throw error;
        }
        return value;
      });
      const nowMs = redisTimeReplyToMs(values[0]);
      const heartbeats = heartbeatsOf(values[1]);
      const own = userSetEntry(instanceId, ref.socketId);
      return stringList(values[2]).some(
        (entry) => entry !== own && isLiveEntry(entry, heartbeats, nowMs, instanceTtlMs),
      );
    },

    removeInstance: async (targetId) => {
      const members = await redis.smembers(redisKeys.instanceRooms(targetId));
      const left: UserInRoom[] = [];
      for (const member of members) {
        const ref = parseIndexEntry(member);
        if (ref === undefined) {
          await redis.srem(redisKeys.instanceRooms(targetId), member);
          continue;
        }
        const result = await runLeave(ref, targetId);
        if (result.last) {
          left.push({ roomId: ref.roomId, userId: ref.userId });
        }
      }
      return distinctUsers(left);
    },
  };
};
