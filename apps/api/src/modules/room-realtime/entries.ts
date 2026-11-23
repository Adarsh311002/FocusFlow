// Pure helpers for room presence entries (docs/architecture/redis-keys.md, M5). Three
// related strings describe one socket in one room:
//
//   room:{roomId}:presence:{userId}  member  {instanceId}:{socketId}
//   instance:{instanceId}:rooms      member  {roomId}:{userId}:{socketId}
//
// Ids are UUIDs and socket ids never contain `:`, so splitting on the first colons is exact.

export type RoomSocketRef = {
  readonly roomId: string;
  readonly userId: string;
  readonly socketId: string;
};

/** A local socket joined to a room, with what presence shows about its user. */
export type LocalRoomSocket = RoomSocketRef & {
  readonly displayName: string;
  readonly avatarUrl: string | null;
};

export const userSetEntry = (instanceId: string, socketId: string): string =>
  `${instanceId}:${socketId}`;

export const instanceIndexEntry = ({ roomId, userId, socketId }: RoomSocketRef): string =>
  `${roomId}:${userId}:${socketId}`;

/** Parses a reverse-index member; `undefined` when it is malformed. */
export const parseIndexEntry = (entry: string): RoomSocketRef | undefined => {
  const first = entry.indexOf(':');
  const second = first < 0 ? -1 : entry.indexOf(':', first + 1);
  if (first <= 0 || second <= first + 1 || second === entry.length - 1) {
    return undefined;
  }
  return {
    roomId: entry.slice(0, first),
    userId: entry.slice(first + 1, second),
    socketId: entry.slice(second + 1),
  };
};

export type RoomSyncPlan = {
  /** Local sockets in a room that the reverse index does not know. */
  readonly missing: readonly LocalRoomSocket[];
  /** Reverse-index members with no local socket in that room behind them. */
  readonly stale: readonly string[];
};

/** Compares this instance's sockets' Socket.IO rooms with its reverse index (H1 for rooms). */
export const planRoomSync = (
  indexed: Iterable<string>,
  local: readonly LocalRoomSocket[],
): RoomSyncPlan => {
  const indexedEntries = new Set(indexed);
  const localEntries = new Set(local.map(instanceIndexEntry));
  return {
    missing: local.filter((socket) => !indexedEntries.has(instanceIndexEntry(socket))),
    stale: [...indexedEntries].filter((entry) => !localEntries.has(entry)),
  };
};

/** Whether an entry belongs to an instance whose last heartbeat is within the TTL. */
export const isLiveEntry = (
  entry: string,
  heartbeats: ReadonlyMap<string, number>,
  nowMs: number,
  ttlMs: number,
): boolean => {
  const separator = entry.indexOf(':');
  if (separator <= 0) {
    return false;
  }
  const heartbeat = heartbeats.get(entry.slice(0, separator));
  return heartbeat !== undefined && heartbeat >= nowMs - ttlMs;
};
