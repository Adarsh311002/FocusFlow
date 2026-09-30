import {
  type ClientToServerEvents,
  connectErrorDataSchema,
  type ServerToClientEvents,
  SOCKET_IO_PATH,
  timeSyncAckSchema,
  type TimeSyncRequest,
} from '@focus-flow/contracts';
import { io, type Socket } from 'socket.io-client';

import { type Clock, clock as appClock, sampleFromRoundTrip } from '../../lib/time-sync';
import {
  notifySessionEnded,
  refresh,
  type RefreshOutcome,
  type SessionEndedCode,
} from '../auth/auth-client';
import { clearAccessToken, getAccessToken } from '../auth/token-store';

// The live connection to the API (docs/architecture/auth.md, "Socket authentication").
// Like the access token, it lives in a module rather than React state: non-component code
// owns it, and React only renders its status.
//
// Phase 3 carries no product events: the socket authenticates, keeps presence alive and
// measures the clock offset. Reconnection rules:
// - The handshake sends the current in-memory access token (never in the URL).
// - UNAUTHENTICATED (expired or missing token): one shared refresh, then one reconnect.
//   Refused again with a fresh token → the session is over.
// - SESSION_REVOKED: the session is over (the normal session-ended path signs out).
// - INTERNAL: a temporary server problem; retry with backoff.
// - The server disconnected us (token expiry or revocation): reconnect once and let the
//   handshake decide.
// - Network drops: Socket.IO's own reconnection handles them.

export type RealtimeStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting';

/** The part of a Socket.IO client this module uses; tests provide a fake. */
export type RealtimeSocket = {
  readonly connected: boolean;
  /** Socket.IO keeps reconnecting by itself while this is true. */
  readonly active: boolean;
  readonly connect: () => void;
  readonly disconnect: () => void;
  readonly onConnect: (listener: () => void) => void;
  readonly onDisconnect: (listener: (reason: string) => void) => void;
  readonly onConnectError: (listener: (error: Error) => void) => void;
  readonly timeSync: (request: TimeSyncRequest) => Promise<unknown>;
};

type HandshakeAuth = (callback: (data: Record<string, unknown>) => void) => void;

export type SocketFactory = (auth: HandshakeAuth) => RealtimeSocket;

const TIME_SYNC_TIMEOUT_MS = 5_000;

/** The real socket: same origin, default transports (polling upgraded to WebSocket). */
export const createSocketIoSocket: SocketFactory = (auth) => {
  const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io({
    path: SOCKET_IO_PATH,
    autoConnect: false,
    auth,
  });
  return {
    get connected() {
      return socket.connected;
    },
    get active() {
      return socket.active;
    },
    connect: () => {
      socket.connect();
    },
    disconnect: () => {
      socket.disconnect();
    },
    onConnect: (listener) => {
      socket.on('connect', listener);
    },
    onDisconnect: (listener) => {
      socket.on('disconnect', (reason) => {
        listener(reason);
      });
    },
    onConnectError: (listener) => {
      socket.on('connect_error', listener);
    },
    timeSync: (request) =>
      new Promise((resolve, reject) => {
        socket
          .timeout(TIME_SYNC_TIMEOUT_MS)
          .emit('time:sync', request, (error: Error | null, response: unknown) => {
            if (error) {
              reject(error);
            } else {
              resolve(response);
            }
          });
      }),
  };
};

const connectErrorCode = (error: Error): string | undefined => {
  if (!('data' in error)) {
    return undefined;
  }
  const parsed = connectErrorDataSchema.safeParse(error.data);
  return parsed.success ? parsed.data.code : undefined;
};

export type RealtimeClient = {
  /** Idempotent: connects if not connected or connecting. */
  readonly connect: () => void;
  /** Stops the connection and every retry; idempotent. */
  readonly disconnect: () => void;
  readonly getStatus: () => RealtimeStatus;
  readonly subscribe: (listener: () => void) => () => void;
};

export type RealtimeDeps = {
  readonly createSocket?: SocketFactory;
  readonly getToken?: () => string | null;
  readonly refreshSession?: () => Promise<RefreshOutcome>;
  readonly endSession?: (reason: SessionEndedCode) => void;
  readonly clock?: Clock;
  readonly now?: () => number;
  /** Samples per clock sync burst; the best (shortest round trip) one wins. */
  readonly syncSamples?: number;
  readonly syncIntervalMs?: number;
  readonly initialRetryMs?: number;
  readonly maxRetryMs?: number;
};

export const createRealtimeClient = ({
  createSocket = createSocketIoSocket,
  getToken = getAccessToken,
  refreshSession = refresh,
  endSession = (reason) => {
    clearAccessToken();
    notifySessionEnded(reason);
  },
  clock = appClock,
  now = Date.now,
  syncSamples = 3,
  syncIntervalMs = 5 * 60_000,
  initialRetryMs = 1_000,
  maxRetryMs = 30_000,
}: RealtimeDeps = {}): RealtimeClient => {
  let status: RealtimeStatus = 'idle';
  let wanted = false;
  let refreshedSinceConnect = false;
  let retryDelayMs = initialRetryMs;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let syncTimer: ReturnType<typeof setInterval> | undefined;
  let socket: RealtimeSocket | undefined;
  const listeners = new Set<() => void>();

  const setStatus = (next: RealtimeStatus): void => {
    if (next !== status) {
      status = next;
      for (const listener of listeners) {
        listener();
      }
    }
  };

  const syncClock = async (target: RealtimeSocket): Promise<void> => {
    for (let index = 0; index < syncSamples; index += 1) {
      try {
        const sentAt = now();
        const response = timeSyncAckSchema.parse(
          await target.timeSync({ clientSentAtMs: Math.max(0, Math.round(sentAt)) }),
        );
        const receivedAt = now();
        if (response.ok) {
          clock.addSample(sampleFromRoundTrip(sentAt, response.serverNowMs, receivedAt));
        }
      } catch {
        // A failed or malformed sample is simply skipped; the next burst tries again.
      }
    }
  };

  const stopTimers = (): void => {
    clearTimeout(retryTimer);
    retryTimer = undefined;
    clearInterval(syncTimer);
    syncTimer = undefined;
  };

  const scheduleRetry = (target: RealtimeSocket): void => {
    setStatus('reconnecting');
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      if (wanted) {
        target.connect();
      }
    }, retryDelayMs);
    retryDelayMs = Math.min(retryDelayMs * 2, maxRetryMs);
  };

  const end = (reason: SessionEndedCode): void => {
    wanted = false;
    stopTimers();
    socket?.disconnect();
    setStatus('idle');
    endSession(reason);
  };

  const ensureSocket = (): RealtimeSocket => {
    if (socket !== undefined) {
      return socket;
    }
    const created = createSocket((callback) => {
      callback({ token: getToken() ?? '' });
    });

    created.onConnect(() => {
      refreshedSinceConnect = false;
      retryDelayMs = initialRetryMs;
      setStatus('connected');
      void syncClock(created);
      clearInterval(syncTimer);
      syncTimer = setInterval(() => {
        void syncClock(created);
      }, syncIntervalMs);
    });

    created.onDisconnect((reason) => {
      clearInterval(syncTimer);
      syncTimer = undefined;
      if (!wanted) {
        setStatus('idle');
        return;
      }
      setStatus('reconnecting');
      // Token expiry or revocation: Socket.IO does not reconnect after a server-side
      // disconnect, so try once; the handshake decides what happens next.
      if (reason === 'io server disconnect') {
        created.connect();
      }
    });

    created.onConnectError((error) => {
      if (!wanted) {
        return;
      }
      if (created.active) {
        // A transport-level failure: Socket.IO keeps retrying on its own.
        setStatus('reconnecting');
        return;
      }
      const code = connectErrorCode(error);
      if (code === 'SESSION_REVOKED') {
        end('SESSION_REVOKED');
        return;
      }
      if (code === 'UNAUTHENTICATED') {
        if (refreshedSinceConnect) {
          end('UNAUTHENTICATED');
          return;
        }
        refreshedSinceConnect = true;
        setStatus('reconnecting');
        refreshSession().then(
          (outcome) => {
            if (outcome.status === 'no-session') {
              end(outcome.reason);
            } else if (wanted) {
              created.connect();
            }
          },
          () => {
            scheduleRetry(created);
          },
        );
        return;
      }
      scheduleRetry(created);
    });

    socket = created;
    return created;
  };

  return {
    connect: () => {
      wanted = true;
      const target = ensureSocket();
      if (target.connected || target.active) {
        return;
      }
      setStatus(status === 'idle' ? 'connecting' : 'reconnecting');
      target.connect();
    },
    disconnect: () => {
      wanted = false;
      stopTimers();
      socket?.disconnect();
      setStatus('idle');
    },
    getStatus: () => status,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

let appClient: RealtimeClient | undefined;

/** The app's single connection, created on first use (never at import time). */
export const getRealtimeClient = (): RealtimeClient => {
  appClient ??= createRealtimeClient();
  return appClient;
};
