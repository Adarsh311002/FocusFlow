import {
  type ClientToServerEvents,
  connectErrorDataSchema,
  type FocusSessionUpdatedEvent,
  focusSessionUpdatedEventSchema,
  type RoomId,
  type RoomTimerCommandRequest,
  type ServerToClientEvents,
  SOCKET_IO_PATH,
  timeSyncAckSchema,
  type TimeSyncRequest,
} from '@focus-flow/contracts';
import { io, type Socket } from 'socket.io-client';
import type { z } from 'zod';

import { type Clock, clock as appClock, sampleFromRoundTrip } from '../../lib/time-sync';
import {
  notifySessionEnded,
  refresh,
  type RefreshOutcome,
  type SessionEndedCode,
} from '../auth/auth-client';
import { clearAccessToken, getAccessToken } from '../auth/token-store';
import {
  type ChatAck,
  type EmptyRoomAck,
  isRoomServerEventName,
  type JoinAck,
  type KnockAck,
  parseRoomServerEvent,
  type RoomAck,
  roomAckSchemas,
  type RoomClientEventName,
  type RoomFailureAck,
  type RoomServerEvent,
  type SocketFailureCode,
  type TimerAck,
} from './room-events';

// The live connection to the API (docs/architecture/auth.md, "Socket authentication").
// Like the access token, it lives in a module rather than React state: non-component code
// owns it, and React only renders its status.
//
// The socket authenticates, keeps presence alive, measures the clock offset and delivers
// `focus:session:updated` (a hint: consumers refetch, docs/api/socket-events.md). Since
// Phase 6 it also delivers the validated `room:*` events and sends the room events
// (`room:join`, `room:leave`, knocks, chat) with typed acknowledgements; it never queues a
// room event for later, and the room features re-send `room:join` on every connect (M6).
// Reconnection rules:
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
  /** The raw payload; the client validates it before anyone sees it. */
  readonly onFocusSessionUpdated: (listener: (payload: unknown) => void) => void;
  readonly timeSync: (request: TimeSyncRequest) => Promise<unknown>;
  /** Every `room:*` event the server sends: its name and raw payload, validated later. */
  readonly onRoomEvent: (listener: (name: string, payload: unknown) => void) => void;
  /** Sends a client event and resolves with its raw acknowledgement; rejects on timeout. */
  readonly emitWithAck: (event: RoomClientEventName, payload: unknown) => Promise<unknown>;
};

type HandshakeAuth = (callback: (data: Record<string, unknown>) => void) => void;

export type SocketFactory = (auth: HandshakeAuth) => RealtimeSocket;

const TIME_SYNC_TIMEOUT_MS = 5_000;
const ACK_TIMEOUT_MS = 5_000;

/**
 * The one place the typed Socket.IO client is used loosely: its `emit` overloads cannot take
 * an event name that is only known to be one of several. The payload comes from the typed
 * helpers on `RealtimeClient` and the acknowledgement is validated against the contract.
 */
type LooseAckEmitter = {
  timeout: (ms: number) => {
    emit: (
      event: string,
      payload: unknown,
      callback: (error: Error | null, response: unknown) => void,
    ) => void;
  };
};

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
    onFocusSessionUpdated: (listener) => {
      socket.on('focus:session:updated', listener);
    },
    onRoomEvent: (listener) => {
      socket.onAny((name: string, payload: unknown) => {
        if (isRoomServerEventName(name)) {
          listener(name, payload);
        }
      });
    },
    emitWithAck: (event, payload) =>
      new Promise((resolve, reject) => {
        const emitter = socket as unknown as LooseAckEmitter;
        emitter
          .timeout(ACK_TIMEOUT_MS)
          .emit(event, payload, (error: Error | null, response: unknown) => {
            if (error) {
              reject(error);
            } else {
              resolve(response);
            }
          });
      }),
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
  /**
   * Validated `focus:session:updated` events. Registered on the client, not the socket, so
   * it survives the socket being re-created. Malformed payloads are dropped.
   */
  readonly onFocusSessionUpdated: (
    listener: (event: FocusSessionUpdatedEvent) => void,
  ) => () => void;
  /** Fires on every successful (re)connect, so consumers can heal events missed meanwhile. */
  readonly onConnected: (listener: () => void) => () => void;
  /** Validated `room:*` events; malformed payloads are dropped. Survives socket re-creation. */
  readonly onRoomEvent: (listener: (event: RoomServerEvent) => void) => () => void;
  // Client → server room events. Each resolves with the server's acknowledgement, or with an
  // OFFLINE / TIMEOUT / MALFORMED_RESPONSE failure; none ever rejects. Nothing is sent (or
  // queued for later) while the socket is not connected.
  readonly joinRoom: (roomId: RoomId) => Promise<JoinAck>;
  readonly leaveRoom: (roomId: RoomId) => Promise<EmptyRoomAck>;
  readonly knockRoom: (roomId: RoomId) => Promise<KnockAck>;
  readonly cancelKnock: (roomId: RoomId) => Promise<EmptyRoomAck>;
  /** A retry with the same `clientMessageId` is answered, not delivered twice (M8). */
  readonly sendChat: (roomId: RoomId, clientMessageId: string, body: string) => Promise<ChatAck>;
  /**
   * A host timer command (Phase 7). A rejection for a stale version or an impossible
   * transition carries the current timer in `error.details` (RT6).
   */
  readonly sendTimerCommand: (
    roomId: RoomId,
    command: RoomTimerCommandRequest['command'],
  ) => Promise<TimerAck>;
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
  const focusListeners = new Set<(event: FocusSessionUpdatedEvent) => void>();
  const connectedListeners = new Set<() => void>();
  const roomListeners = new Set<(event: RoomServerEvent) => void>();

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
      for (const listener of connectedListeners) {
        listener();
      }
      void syncClock(created);
      clearInterval(syncTimer);
      syncTimer = setInterval(() => {
        void syncClock(created);
      }, syncIntervalMs);
    });

    created.onFocusSessionUpdated((payload) => {
      const parsed = focusSessionUpdatedEventSchema.safeParse(payload);
      if (!parsed.success) {
        return;
      }
      for (const listener of focusListeners) {
        listener(parsed.data);
      }
    });

    created.onRoomEvent((name, payload) => {
      const event = parseRoomServerEvent(name, payload);
      if (event === null) {
        return;
      }
      for (const listener of [...roomListeners]) {
        listener(event);
      }
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

  const failure = (code: SocketFailureCode, message: string): RoomFailureAck => ({
    ok: false,
    error: { code, message },
  });

  const sendRoomEvent = async <Schema extends z.ZodType>(
    event: RoomClientEventName,
    payload: unknown,
    schema: Schema,
  ): Promise<RoomAck<Schema>> => {
    const target = socket;
    // Socket.IO would buffer an emit made while disconnected and send it on reconnect, long
    // after the caller was told it failed. Refusing here keeps "failed" meaning not sent.
    if (target === undefined || !target.connected) {
      return failure('OFFLINE', 'The live connection is down.');
    }
    let raw: unknown;
    try {
      raw = await target.emitWithAck(event, payload);
    } catch {
      return failure('TIMEOUT', 'The server did not answer in time.');
    }
    const parsed = schema.safeParse(raw);
    return parsed.success
      ? parsed.data
      : failure('MALFORMED_RESPONSE', 'The server answered in an unexpected shape.');
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
    onFocusSessionUpdated: (listener) => {
      focusListeners.add(listener);
      return () => {
        focusListeners.delete(listener);
      };
    },
    onConnected: (listener) => {
      connectedListeners.add(listener);
      return () => {
        connectedListeners.delete(listener);
      };
    },
    onRoomEvent: (listener) => {
      roomListeners.add(listener);
      return () => {
        roomListeners.delete(listener);
      };
    },
    joinRoom: (roomId) => sendRoomEvent('room:join', { roomId }, roomAckSchemas.join),
    leaveRoom: (roomId) => sendRoomEvent('room:leave', { roomId }, roomAckSchemas.empty),
    knockRoom: (roomId) => sendRoomEvent('room:knock', { roomId }, roomAckSchemas.knock),
    cancelKnock: (roomId) => sendRoomEvent('room:knock:cancel', { roomId }, roomAckSchemas.empty),
    sendChat: (roomId, clientMessageId, body) =>
      sendRoomEvent('room:chat:send', { roomId, clientMessageId, body }, roomAckSchemas.chat),
    sendTimerCommand: (roomId, command) =>
      sendRoomEvent('room:timer:command', { roomId, command }, roomAckSchemas.timer),
  };
};

let appClient: RealtimeClient | undefined;

/** The app's single connection, created on first use (never at import time). */
export const getRealtimeClient = (): RealtimeClient => {
  appClient ??= createRealtimeClient();
  return appClient;
};
