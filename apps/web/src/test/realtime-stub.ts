import type { RealtimeClient, RealtimeStatus } from '../features/realtime/realtime-client';

/** A realtime client that never opens a socket; it records the calls it receives. */
export function createStubRealtimeClient(): RealtimeClient & { readonly calls: string[] } {
  const calls: string[] = [];
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
  };
}
