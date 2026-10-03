import { createContext, type ReactNode, useContext, useEffect, useSyncExternalStore } from 'react';

import { useAuth } from '../auth/auth-context';
import { getRealtimeClient, type RealtimeClient, type RealtimeStatus } from './realtime-client';

const RealtimeContext = createContext<RealtimeClient | null>(null);

/**
 * Keeps the live connection in step with the session: connected while a user is signed
 * in, disconnected otherwise. Keyed by the user id, so signing in as someone else always
 * reconnects with the new identity. Safe under StrictMode's double effects: connect and
 * disconnect are idempotent.
 */
export function RealtimeProvider({
  children,
  client = getRealtimeClient(),
}: {
  children: ReactNode;
  client?: RealtimeClient;
}) {
  const { status, user } = useAuth();
  const signedInAs = status === 'authenticated' ? (user?.id ?? null) : null;

  useEffect(() => {
    if (signedInAs === null) {
      client.disconnect();
      return undefined;
    }
    client.connect();
    return () => {
      client.disconnect();
    };
  }, [client, signedInAs]);

  return <RealtimeContext value={client}>{children}</RealtimeContext>;
}

/** The live connection's status, for rendering. */
export function useRealtimeStatus(): RealtimeStatus {
  const client = useContext(RealtimeContext);
  if (client === null) {
    throw new Error('useRealtimeStatus must be called inside a <RealtimeProvider>.');
  }
  return useSyncExternalStore(client.subscribe, client.getStatus);
}
