import type { FocusSessionView, RoomId, TaskId } from '@focus-flow/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef } from 'react';

import { useAuth } from '../auth/auth-context';
import { useRememberEndedFocusSession } from '../focus/focus-queries';
import { focusSessionKeys } from '../review/review-queries';
import {
  getRoomFocusState,
  isStaleFocusAnswer,
  optInRoomFocus,
  optOutRoomFocus,
} from './room-focus-client';

// Room focus participation (Phase 8). The live picture (participants, run) is the room
// store; this is the REST side: it restores a reloaded page (the caller's own session) and
// is the truth the page re-reads after every change. It lives under the focus-sessions key
// prefix so a `focus:session:updated` event, a reconnect or any mutation refreshes it
// together with the solo timer and Review. No optimistic updates (E12 style).

const NO_USER = 'signed-out';

function useUserId(): string {
  return useAuth().user?.id ?? NO_USER;
}

export const roomFocusKey = (userId: string, roomId: RoomId): readonly unknown[] =>
  [...focusSessionKeys.all(userId), 'room', roomId] as const;

/** `GET /rooms/:roomId/focus-participation`, re-read whenever the room is shown. */
export function useRoomFocusState(roomId: RoomId) {
  const userId = useUserId();
  return useQuery({
    queryKey: roomFocusKey(userId, roomId),
    queryFn: () => getRoomFocusState(roomId),
    enabled: userId !== NO_USER,
    staleTime: 0,
    refetchOnMount: 'always',
    retry: false,
  });
}

export type RoomFocusActions = {
  /** True from sending a request until its answer; every control is disabled meanwhile. */
  readonly pending: boolean;
  readonly error: unknown;
  readonly clearError: () => void;
  readonly join: (taskId: TaskId | null) => Promise<boolean>;
  readonly leave: () => Promise<boolean>;
};

/**
 * Opt in and opt out, one request at a time (a ref, not state: two clicks in one tick must
 * not send two). Whatever the answer, the page re-reads what the server says, because a
 * failed request may still have committed (a dropped connection, a 503).
 */
export function useRoomFocusActions(roomId: RoomId, onStale: () => void): RoomFocusActions {
  const queryClient = useQueryClient();
  const userId = useUserId();
  const remember = useRememberEndedFocusSession();
  const inFlight = useRef(false);

  const mutation = useMutation({
    mutationFn: (request: { kind: 'join'; taskId: TaskId | null } | { kind: 'leave' }) =>
      request.kind === 'join'
        ? optInRoomFocus(roomId, request.taskId === null ? {} : { taskId: request.taskId })
        : optOutRoomFocus(roomId),
    onSuccess: (session: FocusSessionView) => {
      // An opt-out answers with the ended session: show what happened right away.
      if (session.status !== 'in_progress') {
        remember(session);
      }
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: focusSessionKeys.all(userId) });
    },
    onError: (error) => {
      // The picture the person acted on is out of date: ask for the authoritative snapshot.
      if (isStaleFocusAnswer(error)) {
        onStale();
      }
    },
  });

  const run = useCallback(
    async (request: { kind: 'join'; taskId: TaskId | null } | { kind: 'leave' }) => {
      if (inFlight.current) {
        return false;
      }
      inFlight.current = true;
      try {
        await mutation.mutateAsync(request);
        return true;
      } catch {
        return false;
      } finally {
        inFlight.current = false;
      }
    },
    [mutation],
  );

  return {
    pending: mutation.isPending,
    error: mutation.error,
    // Resetting while a request is out would orphan it (and show the controls as idle).
    clearError: () => {
      if (!inFlight.current) {
        mutation.reset();
      }
    },
    join: (taskId) => run({ kind: 'join', taskId }),
    leave: () => run({ kind: 'leave' }),
  };
}
