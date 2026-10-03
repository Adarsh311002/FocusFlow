import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createClock } from '../../lib/time-sync';
import type { RefreshOutcome, SessionEndedCode } from '../auth/auth-client';
import {
  createRealtimeClient,
  type RealtimeDeps,
  type RealtimeSocket,
  type SocketFactory,
} from './realtime-client';

/** Mutable where the test drives the socket; still assignable to RealtimeSocket. */
type FakeSocket = Omit<RealtimeSocket, 'connected' | 'active'> & {
  connected: boolean;
  active: boolean;
  connectCalls: number;
  disconnectCalls: number;
  handshakes: Record<string, unknown>[];
  timeSyncRequests: unknown[];
  serverConnects: () => void;
  serverRefuses: (code: string | undefined, options?: { transport?: boolean }) => void;
  serverDisconnects: (reason: string) => void;
};

/** A fake Socket.IO client driven by the test, mirroring the real client's semantics. */
const createFakeSocket = (
  serverNowMs = 5_050,
): { factory: SocketFactory; socket: () => FakeSocket } => {
  let current: FakeSocket | undefined;
  const factory: SocketFactory = (auth) => {
    const connectListeners: (() => void)[] = [];
    const disconnectListeners: ((reason: string) => void)[] = [];
    const errorListeners: ((error: Error) => void)[] = [];
    const fake: FakeSocket = {
      connected: false,
      active: false,
      connectCalls: 0,
      disconnectCalls: 0,
      handshakes: [],
      timeSyncRequests: [],
      connect: () => {
        fake.connectCalls += 1;
        fake.active = true;
        auth((data) => fake.handshakes.push(data));
      },
      disconnect: () => {
        fake.disconnectCalls += 1;
        const wasConnected = fake.connected;
        fake.connected = false;
        fake.active = false;
        if (wasConnected) {
          disconnectListeners.forEach((listener) => {
            listener('io client disconnect');
          });
        }
      },
      onConnect: (listener) => connectListeners.push(listener),
      onDisconnect: (listener) => disconnectListeners.push(listener),
      onConnectError: (listener) => errorListeners.push(listener),
      timeSync: (request) => {
        fake.timeSyncRequests.push(request);
        return Promise.resolve({ ok: true, serverNowMs });
      },
      serverConnects: () => {
        fake.connected = true;
        connectListeners.forEach((listener) => {
          listener();
        });
      },
      serverRefuses: (code, options = {}) => {
        fake.connected = false;
        // Middleware refusals stop Socket.IO's own reconnection; transport errors do not.
        fake.active = options.transport === true;
        const error = Object.assign(
          new Error(code ?? 'xhr poll error'),
          code === undefined ? {} : { data: { code } },
        );
        errorListeners.forEach((listener) => {
          listener(error);
        });
      },
      serverDisconnects: (reason) => {
        fake.connected = false;
        fake.active = reason !== 'io server disconnect';
        disconnectListeners.forEach((listener) => {
          listener(reason);
        });
      },
    };
    current = fake;
    return fake;
  };
  return {
    factory,
    socket: () => {
      if (current === undefined) {
        throw new Error('no socket created yet');
      }
      return current;
    },
  };
};

const setup = (overrides: Partial<RealtimeDeps> = {}) => {
  const fake = createFakeSocket();
  const ended: SessionEndedCode[] = [];
  const refreshCalls: number[] = [];
  let token = 'token-1';
  let refreshOutcome: RefreshOutcome | Error = { status: 'refreshed', accessToken: 'token-2' };
  const times = [1_000, 1_100];
  let timeIndex = 0;
  const clock = createClock(() => 0);
  const client = createRealtimeClient({
    createSocket: fake.factory,
    getToken: () => token,
    refreshSession: () => {
      refreshCalls.push(1);
      if (refreshOutcome instanceof Error) {
        return Promise.reject(refreshOutcome);
      }
      if (refreshOutcome.status === 'refreshed') {
        token = refreshOutcome.accessToken;
      }
      return Promise.resolve(refreshOutcome);
    },
    endSession: (reason) => ended.push(reason),
    clock,
    now: () => times[timeIndex++ % 2] ?? 0,
    syncSamples: 1,
    initialRetryMs: 1_000,
    maxRetryMs: 4_000,
    ...overrides,
  });
  return {
    client,
    fake,
    ended,
    refreshCalls,
    clock,
    setRefreshOutcome: (outcome: RefreshOutcome | Error) => {
      refreshOutcome = outcome;
    },
  };
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('realtime client', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('connects with the current access token in the handshake auth, never the URL', () => {
    const { client, fake } = setup();

    client.connect();

    expect(client.getStatus()).toBe('connecting');
    expect(fake.socket().handshakes).toEqual([{ token: 'token-1' }]);
  });

  it('is idempotent while connecting or connected', () => {
    const { client, fake } = setup();

    client.connect();
    client.connect();
    fake.socket().serverConnects();
    client.connect();

    expect(fake.socket().connectCalls).toBe(1);
  });

  it('measures the clock offset with time:sync on connect', async () => {
    const { client, fake, clock } = setup();

    client.connect();
    fake.socket().serverConnects();
    await vi.advanceTimersByTimeAsync(0);

    expect(client.getStatus()).toBe('connected');
    expect(fake.socket().timeSyncRequests).toEqual([{ clientSentAtMs: 1_000 }]);
    // Sent at 1000, received at 1100, server said 5050 → offset 4000.
    expect(clock.offsetMs()).toBe(4_000);
  });

  it('on UNAUTHENTICATED refreshes once and reconnects with the new token', async () => {
    const { client, fake, refreshCalls, ended } = setup();
    client.connect();

    fake.socket().serverRefuses('UNAUTHENTICATED');
    await vi.advanceTimersByTimeAsync(0);

    expect(refreshCalls).toHaveLength(1);
    expect(fake.socket().connectCalls).toBe(2);
    expect(fake.socket().handshakes.at(-1)).toEqual({ token: 'token-2' });
    expect(ended).toEqual([]);
  });

  it('ends the session when refused again right after a refresh', async () => {
    const { client, fake, ended } = setup();
    client.connect();
    fake.socket().serverRefuses('UNAUTHENTICATED');
    await vi.advanceTimersByTimeAsync(0);

    fake.socket().serverRefuses('UNAUTHENTICATED');

    expect(ended).toEqual(['UNAUTHENTICATED']);
    expect(client.getStatus()).toBe('idle');
  });

  it('ends the session when the refresh finds no session', async () => {
    const { client, fake, ended, setRefreshOutcome } = setup();
    setRefreshOutcome({ status: 'no-session', reason: 'SESSION_INVALID' });
    client.connect();

    fake.socket().serverRefuses('UNAUTHENTICATED');
    await vi.advanceTimersByTimeAsync(0);

    expect(ended).toEqual(['SESSION_INVALID']);
    expect(fake.socket().connectCalls).toBe(1);
  });

  it('ends the session on SESSION_REVOKED without reconnecting', () => {
    const { client, fake, ended } = setup();
    client.connect();

    fake.socket().serverRefuses('SESSION_REVOKED');

    expect(ended).toEqual(['SESSION_REVOKED']);
    expect(client.getStatus()).toBe('idle');
    expect(fake.socket().connectCalls).toBe(1);
  });

  it('retries INTERNAL refusals with exponential backoff, and keeps the session', async () => {
    const { client, fake, ended } = setup();
    client.connect();

    fake.socket().serverRefuses('INTERNAL');
    expect(client.getStatus()).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(999);
    expect(fake.socket().connectCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.socket().connectCalls).toBe(2);

    fake.socket().serverRefuses('INTERNAL');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fake.socket().connectCalls).toBe(3);
    expect(ended).toEqual([]);
  });

  it('retries with backoff when the refresh itself fails (network)', async () => {
    const { client, fake, setRefreshOutcome } = setup();
    setRefreshOutcome(new Error('offline'));
    client.connect();

    fake.socket().serverRefuses('UNAUTHENTICATED');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(fake.socket().connectCalls).toBe(2);
  });

  it('leaves transport-level failures to Socket.IO’s own reconnection', () => {
    const { client, fake } = setup();
    client.connect();

    fake.socket().serverRefuses(undefined, { transport: true });

    expect(client.getStatus()).toBe('reconnecting');
    expect(fake.socket().connectCalls).toBe(1);
  });

  it('reconnects once after a server-side disconnect (token expiry or revocation)', () => {
    const { client, fake } = setup();
    client.connect();
    fake.socket().serverConnects();

    fake.socket().serverDisconnects('io server disconnect');

    expect(client.getStatus()).toBe('reconnecting');
    expect(fake.socket().connectCalls).toBe(2);
  });

  it('stops everything on disconnect(): no retries, no reconnects', async () => {
    const { client, fake } = setup();
    client.connect();
    fake.socket().serverRefuses('INTERNAL');

    client.disconnect();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(client.getStatus()).toBe('idle');
    expect(fake.socket().connectCalls).toBe(1);
  });

  it('notifies subscribers of status changes', () => {
    const { client, fake } = setup();
    const seen: string[] = [];
    client.subscribe(() => seen.push(client.getStatus()));

    client.connect();
    fake.socket().serverConnects();
    client.disconnect();

    expect(seen).toEqual(['connecting', 'connected', 'idle']);
  });
});

describe('realtime client clock resync', () => {
  it('samples again on the sync interval while connected', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const { client, fake } = setup({ syncIntervalMs: 60_000 });
      client.connect();
      fake.socket().serverConnects();
      await vi.advanceTimersByTimeAsync(0);
      expect(fake.socket().timeSyncRequests).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(fake.socket().timeSyncRequests).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
    await flush();
  });
});
