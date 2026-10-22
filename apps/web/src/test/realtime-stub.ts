import type { FocusSessionUpdatedEvent } from '@focus-flow/contracts';

import type { RealtimeClient, RealtimeStatus } from '../features/realtime/realtime-client';

/**
 * A realtime client that never opens a socket; it records the calls it receives. Tests push
 * server events with `emitFocusSessionUpdated` and simulate a (re)connect with
 * `emitConnected` (connect() alone does not fire it, to keep unrelated tests quiet).
 */
export function createStubRealtimeClient(): RealtimeClient & {
  readonly calls: string[];
  readonly emitFocusSessionUpdated: (event: FocusSessionUpdatedEvent) => void;
  readonly emitConnected: () => void;
  readonly focusListenerCount: () => number;
} {
  const calls: string[] = [];
  const focusListeners = new Set<(event: FocusSessionUpdatedEvent) => void>();
  const connectedListeners = new Set<() => void>();
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
