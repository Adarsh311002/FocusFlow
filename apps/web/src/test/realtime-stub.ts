import type { FocusSessionUpdatedEvent } from '@focus-flow/contracts';

import type { RealtimeClient, RealtimeStatus } from '../features/realtime/realtime-client';
import type { RoomFailureAck, RoomServerEvent } from '../features/realtime/room-events';

const OFFLINE: RoomFailureAck = {
  ok: false,
  error: { code: 'INTERNAL', message: 'The stub client has no live connection.' },
};

/**
 * A realtime client that never opens a socket; it records the calls it receives. Tests push
 * server events with `emitFocusSessionUpdated` and simulate a (re)connect with
 * `emitConnected` (connect() alone does not fire it, to keep unrelated tests quiet). Room
 * events are pushed with `emitRoomEvent`; room requests are refused (rooms tests use the
 * the fake client in `fake-room-client.ts` instead).
 */
export function createStubRealtimeClient(): RealtimeClient & {
  readonly calls: string[];
  readonly emitFocusSessionUpdated: (event: FocusSessionUpdatedEvent) => void;
  readonly emitConnected: () => void;
  readonly emitRoomEvent: (event: RoomServerEvent) => void;
  /** Moves the status without connect()/disconnect() side effects (for example reconnecting). */
  readonly setStatus: (next: RealtimeStatus) => void;
  readonly focusListenerCount: () => number;
} {
  const calls: string[] = [];
  const focusListeners = new Set<(event: FocusSessionUpdatedEvent) => void>();
  const connectedListeners = new Set<() => void>();
  const roomListeners = new Set<(event: RoomServerEvent) => void>();
  let status: RealtimeStatus = 'idle';
  const listeners = new Set<() => void>();
  const setStatus = (next: RealtimeStatus): void => {
    status = next;
    for (const listener of listeners) {
      listener();
    }
  };
  return {
    calls,
    connect: () => {
      calls.push('connect');
      setStatus('connected');
    },
    disconnect: () => {
      calls.push('disconnect');
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
    joinRoom: () => Promise.resolve(OFFLINE),
    leaveRoom: () => Promise.resolve(OFFLINE),
    knockRoom: () => Promise.resolve(OFFLINE),
    cancelKnock: () => Promise.resolve(OFFLINE),
    sendChat: () => Promise.resolve(OFFLINE),
    sendTimerCommand: () => Promise.resolve(OFFLINE),
    setStatus,
    emitRoomEvent: (event) => {
      for (const listener of [...roomListeners]) {
        listener(event);
      }
    },
    emitFocusSessionUpdated: (event) => {
      for (const listener of [...focusListeners]) {
        listener(event);
      }
    },
    emitConnected: () => {
      for (const listener of [...connectedListeners]) {
        listener();
      }
    },
    focusListenerCount: () => focusListeners.size,
  };
}
