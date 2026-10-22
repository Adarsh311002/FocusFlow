import type {
  FocusSessionId,
  FocusSessionView,
  StartFocusSessionRequest,
} from '@focus-flow/contracts';
import {
  type QueryClient,
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';

import { useAuth } from '../auth/auth-context';
import { useRealtimeClient, useRealtimeStatus } from '../realtime/realtime-provider';
import { focusSessionKeys } from '../review/review-queries';
import {
  getCurrentFocusSession,
  pauseFocusSession,
  resumeFocusSession,
  sessionInProgressFrom,
  startFocusSession,
  stopFocusSession,
} from './focus-client';

// Server state for the solo timer lives in TanStack Query, under the same per-user prefix
// as the Review queries, so one invalidation refreshes the timer, history and summary.
//
// Truth comes from `GET /focus-sessions/current`. A mutation response is written into the
// cache because the user just asked for it; a `focus:session:updated` event is only a hint
// (docs/api/socket-events.md): it triggers a refetch and never sets the current session,
// so duplicate, late or missed events heal themselves. No optimistic updates (E12).

const NO_USER = 'signed-out';

function useUserId(): string {
  return useAuth().user?.id ?? NO_USER;
}

export const focusCurrentKey = (userId: string): readonly unknown[] =>
  [...focusSessionKeys.all(userId), 'current'] as const;

const lastEndedKey = (userId: string): readonly unknown[] =>
  [...focusSessionKeys.all(userId), 'last-ended'] as const;

const isEnded = (session: FocusSessionView): boolean => session.status !== 'in_progress';

/** The in-progress session, or `null`; always refetched when a component mounts. */
export function useCurrentFocusSession(): UseQueryResult<FocusSessionView | null> {
  const userId = useUserId();
  return useQuery({
    queryKey: focusCurrentKey(userId),
    queryFn: getCurrentFocusSession,
    enabled: userId !== NO_USER,
    staleTime: 0,
    refetchOnMount: 'always',
  });
}

/**
 * Asks the server for the current session again without becoming another observer of the
 * query: a second `useCurrentFocusSession()` would also refetch on its own mount.
 */
export function useRefetchCurrentFocusSession(): () => Promise<void> {
  const queryClient = useQueryClient();
  const userId = useUserId();
  return useCallback(
    () =>
      queryClient.refetchQueries({ queryKey: focusCurrentKey(userId) }, { cancelRefetch: false }),
    [queryClient, userId],
  );
}

function rememberEnded(queryClient: QueryClient, userId: string, session: FocusSessionView): void {
  if (!isEnded(session) || session.status === 'in_progress') {
    return;
  }
  // A late event about an older session must not shadow a newer one that is running now.
  const current = queryClient.getQueryData<FocusSessionView | null>(focusCurrentKey(userId));
  if (
    current?.status === 'in_progress' &&
    Date.parse(current.startedAt) > Date.parse(session.startedAt)
  ) {
    return;
  }
  // A late or duplicated event about an older session must not replace a newer notice.
  const known = queryClient.getQueryData<FocusSessionView | null>(lastEndedKey(userId));
  if (
    known?.status !== undefined &&
    known.status !== 'in_progress' &&
    Date.parse(known.endedAt) > Date.parse(session.endedAt)
  ) {
    return;
  }
  queryClient.setQueryData(lastEndedKey(userId), session);
}

/**
 * The most recent completed or abandoned session seen on this page load, for the "what
 * just happened" notice. Held as cache data (never fetched: `skipToken`) and kept forever
 * (`gcTime: Infinity`) so the notice does not vanish while no component observes it; it
 * is cleared with the rest of the cache when the session changes.
 */
export function useLastEndedFocusSession(): FocusSessionView | null {
  const userId = useUserId();
  const { data } = useQuery<FocusSessionView | null>({
    queryKey: lastEndedKey(userId),
    queryFn: skipToken,
    gcTime: Infinity,
  });
  return data ?? null;
}

export function useDismissLastEnded(): () => void {
  const queryClient = useQueryClient();
  const userId = useUserId();
  return useCallback(() => {
    queryClient.setQueryData(lastEndedKey(userId), null);
  }, [queryClient, userId]);
}

/**
 * One mutation per action. While a request with the same variables is in flight, a second
 * call joins it instead of sending another (a double click must not start two sessions);
 * `isPending` lets the UI disable the control as well.
 */
function useFocusMutation<TVariables>(
  action: (variables: TVariables) => Promise<FocusSessionView>,
  key: (variables: TVariables) => string,
  /** Only a start may put a session into an empty cache; the others update the one held. */
  creates = false,
) {
  const queryClient = useQueryClient();
  const userId = useUserId();
  const inFlight = useRef<{ key: string; promise: Promise<FocusSessionView> } | null>(null);
  // A response that lands after sign-out or a switch of user belongs to the old user.
  const latestUserId = useRef(userId);
  useEffect(() => {
    latestUserId.current = userId;
  }, [userId]);

  const refresh = useCallback(() => invalidateFocus(queryClient, userId), [queryClient, userId]);

  return useMutation({
    mutationFn: (variables: TVariables) => {
      const variablesKey = key(variables);
      if (inFlight.current?.key === variablesKey) {
        return inFlight.current.promise;
      }
      const promise = action(variables).finally(() => {
        if (inFlight.current?.promise === promise) {
          inFlight.current = null;
        }
      });
      inFlight.current = { key: variablesKey, promise };
      return promise;
    },
    onSuccess: async (session) => {
      if (latestUserId.current !== userId) {
        return;
      }
      // A slow response must not overwrite what a refetch or an event already settled.
      await queryClient.cancelQueries({ queryKey: focusCurrentKey(userId) });
      writeCurrent(queryClient, userId, session, creates);
      rememberEnded(queryClient, userId, session);
      await refresh();
    },
    onError: async () => {
      // Whatever went wrong (a 404 for a vanished session, a 503 or a dropped connection
      // after which the request may still have committed), the screen may be out of date:
      // ask the server again.
      if (latestUserId.current === userId) {
        await refresh();
      }
    },
  });
}

/**
 * Refetches the active focus queries. A read already in flight is restarted rather than
 * joined: it may have been answered by the server before the change that triggered this
 * refresh, and joining it would hand back that older state with nothing left to ask again
 * (there is no polling). Restarting costs one repeated GET.
 */
async function invalidateFocus(queryClient: QueryClient, userId: string): Promise<void> {
  const filters = { queryKey: focusSessionKeys.all(userId) };
  // TanStack restarts a read that already has data, but always joins one still loading its
  // first data. Those reads were sent before this refresh was asked for, so once they
  // settle, ask those queries once more: any read from then on starts after the change.
  const firstLoads = new Set(
    queryClient
      .getQueryCache()
      .findAll({ ...filters, fetchStatus: 'fetching' })
      .filter((query) => query.state.data === undefined),
  );
  await queryClient.invalidateQueries(filters);
  if (firstLoads.size > 0) {
    await queryClient.invalidateQueries({
      ...filters,
      predicate: (query) => firstLoads.has(query),
    });
  }
}

/**
 * Applies a mutation's answer to the current session, but only where it can be placed
 * without ranking it against anything newer. A view has no version, so a late answer cannot
 * be told apart from a fresh one; it may therefore only touch the session it is about:
 * - an answer about the session the cache holds replaces it (terminal: clears it);
 * - an answer about any other session leaves the cache alone, since the cache may already
 *   hold a newer session, or `null` after a read saw this one end;
 * - only a start (`creates`) may fill an empty cache.
 * Whatever is left unwritten is corrected by the refetch that always follows.
 */
function writeCurrent(
  queryClient: QueryClient,
  userId: string,
  session: FocusSessionView,
  creates: boolean,
): void {
  const key = focusCurrentKey(userId);
  const current = queryClient.getQueryData<FocusSessionView | null>(key);
  const holdsThisSession = current?.id === session.id;
  if (isEnded(session)) {
    if (holdsThisSession) {
      queryClient.setQueryData(key, null);
    }
    return;
  }
  const lastEnded = queryClient.getQueryData<FocusSessionView | null>(lastEndedKey(userId));
  if (lastEnded?.id === session.id) {
    return;
  }
  if (holdsThisSession || (creates && (current === null || current === undefined))) {
    queryClient.setQueryData(key, session);
  }
}

export function useStartFocusSession() {
  return useFocusMutation(
    // A 409 carries the session that already exists (a double click, or another tab):
    // adopt it instead of failing, so no duplicate is created and no error is shown.
    async (request: StartFocusSessionRequest) => {
      try {
        return await startFocusSession(request);
      } catch (error) {
        const existing = sessionInProgressFrom(error);
        if (existing === null) {
          throw error;
        }
        return existing;
      }
    },
    (request) => `${String(request.plannedSeconds)}:${request.taskId ?? ''}`,
    true,
  );
}

export function usePauseFocusSession() {
  return useFocusMutation(
    (id: FocusSessionId) => pauseFocusSession(id),
    (id) => id,
  );
}

export function useResumeFocusSession() {
  return useFocusMutation(
    (id: FocusSessionId) => resumeFocusSession(id),
    (id) => id,
  );
}

export function useStopFocusSession() {
  return useFocusMutation(
    (id: FocusSessionId) => stopFocusSession(id),
    (id) => id,
  );
}

/**
 * Whether the live connection is up. A running session whose user stays disconnected is
 * abandoned after about 60 s (D19, D35), so the UI warns while this is `not-connected`.
 */
export function useFocusConnection(): 'connected' | 'not-connected' {
  return useRealtimeStatus() === 'connected' ? 'connected' : 'not-connected';
}

/**
 * Subscribes to `focus:session:updated` once for the signed-in user. Every event, and every
 * (re)connect of the socket, only invalidates: `GET /focus-sessions/current` decides what is
 * true, and history and summary refresh with it. A terminal session in the payload is
 * remembered for the notice (display only; the refetch still decides the timer). Listeners
 * are removed on cleanup, so StrictMode's double effect leaves exactly one.
 */
export function useFocusSessionEvents(): void {
  const client = useRealtimeClient();
  const queryClient = useQueryClient();
  const userId = useUserId();

  useEffect(() => {
    if (userId === NO_USER) {
      return undefined;
    }
    // `userId` is captured per effect run: cleanup removes these exact listeners, so none
    // can fire for a previous user after a sign-out and sign-in.
    const refresh = (): void => {
      void invalidateFocus(queryClient, userId);
    };
    const offEvent = client.onFocusSessionUpdated((event) => {
      // Only a terminal session is remembered; an in-progress payload is never cached.
      rememberEnded(queryClient, userId, event.session);
      refresh();
    });
    // Events between the handshake and the room join are lost, so every connect (including
    // the first, and one that happened before this subscription) refetches.
    const offConnected = client.onConnected(refresh);
    if (client.getStatus() === 'connected') {
      refresh();
    }
    return () => {
      offEvent();
      offConnected();
    };
  }, [client, queryClient, userId]);
}
