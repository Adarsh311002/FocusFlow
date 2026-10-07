import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import type { AppSocket } from '../realtime/types.js';
import { createPresence, type UserOfflineEvent } from './presence.js';
import type {
  InstanceSnapshot,
  PresenceStore,
  RemoveResult,
  SocketRef,
  SyncResult,
} from './store.js';

// The presence module's own rules over a scripted store: which path reports a user
// offline, with which timestamp, and how syncs are serialised and retried. The Redis
// behaviour of the store itself is covered by presence.int.test.ts.

const logger = pino({ level: 'silent' });

const NOOP_SYNC: SyncResult = {
  added: 0,
  removed: 0,
  cameOnline: [],
  wentOffline: [],
  syncedAtMs: undefined,
};

const unexpected = (): Promise<never> => Promise.reject(new Error('not scripted'));

const fakeStore = (overrides: Partial<PresenceStore>): PresenceStore => ({
  add: () => Promise.resolve(),
  remove: unexpected,
  checkUser: unexpected,
  sync: () => Promise.resolve(NOOP_SYNC),
  readInstance: unexpected,
  dropInstance: () => Promise.resolve(),
  ...overrides,
});

const deferred = <T>() => {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A socket that only records its `disconnect` listener. */
const fakeSocket = (userId: string, socketId: string) => {
  let onDisconnect: (() => void) | undefined;
  const socket = {
    id: socketId,
    data: { userId },
    on: (event: string, listener: () => void) => {
      if (event === 'disconnect') {
        onDisconnect = listener;
      }
    },
  };
  return {
    socket: socket as unknown as AppSocket,
    disconnect: () => {
      onDisconnect?.();
    },
  };
};

const recordEvents = (presence: ReturnType<typeof createPresence>) => {
  const offline: UserOfflineEvent[] = [];
  const online: string[] = [];
  presence.onUserOffline((event) => {
    offline.push(event);
  });
  presence.onUserOnline((userId) => {
    online.push(userId);
  });
  return { offline, online };
};

describe('disconnect reporting', () => {
  const removal = (result: RemoveResult) =>
    createPresence({
      store: fakeStore({ remove: () => Promise.resolve(result) }),
      listLocalSockets: () => [],
      logger,
    });

  it('reports the user offline with the Redis TIME of the removal', async () => {
    const presence = removal({ removed: true, removedAtMs: 5_000, userOffline: true });
    const { offline, online } = recordEvents(presence);
    const { socket, disconnect } = fakeSocket('user-a', 's1');

    presence.track(socket);
    await flush();
    expect(online).toEqual(['user-a']);
    disconnect();
    await flush();

    expect(offline).toEqual([{ userId: 'user-a', reason: 'disconnect', disconnectedAtMs: 5_000 }]);
  });

  it('stays silent while another socket keeps the user online', async () => {
    const presence = removal({ removed: true, removedAtMs: 5_000, userOffline: false });
    const { offline } = recordEvents(presence);
    const { socket, disconnect } = fakeSocket('user-a', 's1');

    presence.track(socket);
    disconnect();
    await flush();

    expect(offline).toEqual([]);
  });

  it('collapses a duplicate: the removal a sync already made is not reported again', async () => {
    const presence = removal({ removed: false, removedAtMs: 5_000, userOffline: true });
    const { offline } = recordEvents(presence);
    const { socket, disconnect } = fakeSocket('user-a', 's1');

    presence.track(socket);
    disconnect();
    await flush();

    expect(offline).toEqual([]);
  });

  it('reports nothing when the removal fails (the next sync detects it)', async () => {
    const presence = createPresence({
      store: fakeStore({ remove: () => Promise.reject(new Error('Redis is down')) }),
      listLocalSockets: () => [],
      logger,
    });
    const { offline } = recordEvents(presence);
    const { socket, disconnect } = fakeSocket('user-a', 's1');

    presence.track(socket);
    disconnect();
    await flush();

    expect(offline).toEqual([]);
  });
});

describe('syncLocal', () => {
  it('reports users it re-added as online and users it found gone as missed disconnects', async () => {
    const local: SocketRef[] = [{ userId: 'user-a', socketId: 's1' }];
    const reads: (readonly SocketRef[])[] = [];
    const presence = createPresence({
      store: fakeStore({
        sync: (readLocal) => {
          reads.push(readLocal());
          return Promise.resolve({
            added: 1,
            removed: 2,
            cameOnline: ['user-a'],
            wentOffline: ['user-b'],
            syncedAtMs: 7_000,
          });
        },
      }),
      listLocalSockets: () => local,
      logger,
    });
    const { offline, online } = recordEvents(presence);

    expect(await presence.syncLocal()).toEqual({ added: 1, removed: 2 });

    expect(reads).toEqual([local]);
    expect(online).toEqual(['user-a']);
    expect(offline).toEqual([
      { userId: 'user-b', reason: 'missed_disconnect', disconnectedAtMs: 7_000 },
    ]);
  });

  it('is single-flight: requests during a sync share one follow-up sync', async () => {
    const runs = [deferred<SyncResult>(), deferred<SyncResult>()];
    let started = 0;
    const presence = createPresence({
      store: fakeStore({
        sync: () => {
          const run = runs[started];
          started += 1;
          return run === undefined ? Promise.resolve(NOOP_SYNC) : run.promise;
        },
      }),
      listLocalSockets: () => [],
      logger,
    });

    const first = presence.syncLocal();
    const second = presence.syncLocal();
    const third = presence.syncLocal();
    await flush();
    expect(started).toBe(1);
    expect(second).toBe(third);

    runs[0]!.resolve(NOOP_SYNC);
    await first;
    await flush();
    expect(started).toBe(2);

    runs[1]!.resolve({ ...NOOP_SYNC, added: 3 });
    expect(await second).toEqual({ added: 3, removed: 0 });
    expect(started).toBe(2);
  });

  it('runs the follow-up even when the running sync fails', async () => {
    const run = deferred<SyncResult>();
    let started = 0;
    const presence = createPresence({
      store: fakeStore({
        sync: () => {
          started += 1;
          return started === 1 ? run.promise : Promise.resolve(NOOP_SYNC);
        },
      }),
      listLocalSockets: () => [],
      logger,
    });

    const first = presence.syncLocal();
    const second = presence.syncLocal();
    run.reject(new Error('Redis is down'));

    await expect(first).rejects.toThrow('Redis is down');
    await expect(second).resolves.toEqual({ added: 0, removed: 0 });
    expect(started).toBe(2);
  });

  it('runs again on the next request after a failure (the heartbeat retries it)', async () => {
    let attempts = 0;
    const presence = createPresence({
      store: fakeStore({
        sync: () => {
          attempts += 1;
          return attempts === 1
            ? Promise.reject(new Error('Redis is down'))
            : Promise.resolve({ ...NOOP_SYNC, added: 1, cameOnline: ['user-a'], syncedAtMs: 1 });
        },
      }),
      listLocalSockets: () => [],
      logger,
    });
    const { online } = recordEvents(presence);

    await expect(presence.syncLocal()).rejects.toThrow('Redis is down');
    expect(await presence.syncLocal()).toEqual({ added: 1, removed: 0 });
    expect(online).toEqual(['user-a']);
  });
});

describe('removeInstance', () => {
  const snapshot: InstanceSnapshot = {
    members: ['user-a:s1', 'user-b:s2'],
    offlineUsers: ['user-a'],
    lastHeartbeatMs: 4_000,
    readAtMs: 9_000,
  };

  it('reports a dead instance’s users as disconnected at its last heartbeat', async () => {
    const dropped: (readonly string[])[] = [];
    const presence = createPresence({
      store: fakeStore({
        readInstance: () => Promise.resolve(snapshot),
        dropInstance: (_id, members) => {
          dropped.push(members);
          return Promise.resolve();
        },
      }),
      listLocalSockets: () => [],
      logger,
    });
    const { offline } = recordEvents(presence);

    await presence.removeInstance('dead', 'instance_dead');

    expect(offline).toEqual([
      { userId: 'user-a', reason: 'instance_dead', disconnectedAtMs: 4_000 },
    ]);
    expect(dropped).toEqual([snapshot.members]);
  });

  it('uses the read time when the instance has no heartbeat left (clean shutdown)', async () => {
    const presence = createPresence({
      store: fakeStore({
        readInstance: () => Promise.resolve({ ...snapshot, lastHeartbeatMs: undefined }),
      }),
      listLocalSockets: () => [],
      logger,
    });
    const { offline } = recordEvents(presence);

    await presence.removeInstance('self', 'disconnect');

    expect(offline).toEqual([{ userId: 'user-a', reason: 'disconnect', disconnectedAtMs: 9_000 }]);
  });

  it('recovers a lost offline signal: a run that dies before removing reports again, identically', async () => {
    let drops = 0;
    const presence = createPresence({
      store: fakeStore({
        readInstance: () => Promise.resolve(snapshot),
        dropInstance: () => {
          drops += 1;
          return drops === 1 ? Promise.reject(new Error('worker died')) : Promise.resolve();
        },
      }),
      listLocalSockets: () => [],
      logger,
    });
    const { offline } = recordEvents(presence);

    await expect(presence.removeInstance('dead', 'instance_dead')).rejects.toThrow('worker died');
    await presence.removeInstance('dead', 'instance_dead');

    // The same (userId, disconnectedAtMs) twice: a consumer collapses it by that key.
    expect(offline).toEqual([
      { userId: 'user-a', reason: 'instance_dead', disconnectedAtMs: 4_000 },
      { userId: 'user-a', reason: 'instance_dead', disconnectedAtMs: 4_000 },
    ]);
  });
});

describe('handlers', () => {
  it('keeps running the other handlers when one fails', async () => {
    const presence = createPresence({
      store: fakeStore({
        remove: () => Promise.resolve({ removed: true, removedAtMs: 1, userOffline: true }),
      }),
      listLocalSockets: () => [],
      logger,
    });
    const seen: string[] = [];
    presence.onUserOffline(() => {
      throw new Error('handler bug');
    });
    presence.onUserOffline(({ userId }) => {
      seen.push(userId);
    });
    const { socket, disconnect } = fakeSocket('user-a', 's1');

    presence.track(socket);
    disconnect();
    await flush();

    expect(seen).toEqual(['user-a']);
  });
});
