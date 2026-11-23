import type {
  CreateRoomRequest,
  RoomId,
  RoomTimerSettingsInput,
  UserId,
} from '@focus-flow/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { useAuth } from '../auth/auth-context';
import { roomKeys } from './room-keys';
import { getRoomLiveStore, useKnockStore } from './room-live-store';
import { isApiErrorCode } from './room-messages';
import {
  approveKnock,
  createRoom,
  getRoom,
  getRoomMembers,
  joinPublicRoom,
  leaveRoomPermanently,
  listMyRooms,
  lookupRoomByCode,
  rejectKnock,
  removeRoomMember,
  updateRoomTimerSettings,
} from './rooms-client';

// Durable room data (the rooms, a room, its members) lives in TanStack Query under
// per-user keys. Like tasks, there are no optimistic updates: every write waits for the
// server's answer, shows a pending state meanwhile and then re-reads what changed. Live
// state (presence, chat, knocks) is not here; see room-live-store.ts.

const NO_USER = 'signed-out';

function useUserId(): string {
  return useAuth().user?.id ?? NO_USER;
}

/** "My rooms", re-read whenever the page is shown: presence counts change without events. */
export function useRoomList() {
  const userId = useUserId();
  return useQuery({
    queryKey: roomKeys.list(userId),
    queryFn: listMyRooms,
    enabled: userId !== NO_USER,
    staleTime: 0,
    refetchOnMount: 'always',
  });
}

export function useRoom(roomId: RoomId) {
  const userId = useUserId();
  return useQuery({
    queryKey: roomKeys.detail(userId, roomId),
    queryFn: () => getRoom(roomId),
    enabled: userId !== NO_USER,
    staleTime: 0,
    refetchOnMount: 'always',
    retry: false,
  });
}

export function useRoomMembers(roomId: RoomId, enabled: boolean) {
  const userId = useUserId();
  return useQuery({
    queryKey: roomKeys.members(userId, roomId),
    queryFn: () => getRoomMembers(roomId),
    enabled: enabled && userId !== NO_USER,
    staleTime: 0,
    refetchOnMount: 'always',
  });
}

/** Re-reads every room query of the signed-in user. */
function useInvalidateRooms(): () => Promise<void> {
  const queryClient = useQueryClient();
  const userId = useUserId();
  return useCallback(
    () => queryClient.invalidateQueries({ queryKey: roomKeys.all(userId) }),
    [queryClient, userId],
  );
}

export function useCreateRoom() {
  const invalidate = useInvalidateRooms();
  return useMutation({
    mutationFn: (request: CreateRoomRequest) => createRoom(request),
    onSuccess: () => invalidate(),
  });
}

/** `GET /rooms/by-code/:code`: a lookup the form asks for, not cached data. */
export function useLookupRoom() {
  return useMutation({ mutationFn: (code: string) => lookupRoomByCode(code) });
}

/** A public room's membership (D9). Forgets any earlier "you were removed" notice for it. */
export function useJoinPublicRoom() {
  const invalidate = useInvalidateRooms();
  return useMutation({
    mutationFn: (roomId: RoomId) => joinPublicRoom(roomId),
    onSuccess: async (_result, roomId) => {
      getRoomLiveStore(roomId).getState().reset();
      useKnockStore.getState().clearOutgoing(roomId);
      await invalidate();
    },
  });
}

/**
 * Leaving for good. The room page stays mounted until the caller has navigated away, so
 * this must not re-read or drop the room's own queries (a 404 would replace the page before
 * the navigation); the caller does that afterwards with useForgetRoom. The list is
 * re-read when it is next shown.
 */
export function useLeaveRoomPermanently() {
  const queryClient = useQueryClient();
  const userId = useUserId();
  return useMutation({
    mutationFn: (roomId: RoomId) => leaveRoomPermanently(roomId),
    onSuccess: (_result, roomId) => {
      getRoomLiveStore(roomId).getState().reset();
      void queryClient.invalidateQueries({ queryKey: roomKeys.list(userId) });
    },
  });
}

/** Drops a room's cached detail and members, once nothing on screen shows the room. */
export function useForgetRoom(): (roomId: RoomId) => void {
  const queryClient = useQueryClient();
  const userId = useUserId();
  return useCallback(
    (roomId: RoomId) => {
      queryClient.removeQueries({ queryKey: roomKeys.detail(userId, roomId) });
      queryClient.removeQueries({ queryKey: roomKeys.members(userId, roomId) });
    },
    [queryClient, userId],
  );
}

export function useRemoveRoomMember(roomId: RoomId) {
  const invalidate = useInvalidateRooms();
  return useMutation({
    mutationFn: (memberId: UserId) => removeRoomMember(roomId, memberId),
    // Repeatable on the server; either way the member list on screen is out of date.
    onSettled: () => invalidate(),
  });
}

export function useUpdateRoomTimerSettings(roomId: RoomId) {
  const invalidate = useInvalidateRooms();
  return useMutation({
    mutationFn: (settings: RoomTimerSettingsInput) => updateRoomTimerSettings(roomId, settings),
    onSuccess: () => invalidate(),
  });
}

/** Approve and reject answer for one knock; the entry leaves the host's list on success. */
export function useAnswerKnock(roomId: RoomId) {
  const invalidate = useInvalidateRooms();
  return useMutation({
    mutationFn: ({ userId, answer }: { userId: UserId; answer: 'approve' | 'reject' }) =>
      answer === 'approve' ? approveKnock(roomId, userId) : rejectKnock(roomId, userId),
    onSuccess: async (_result, { userId }) => {
      useKnockStore.getState().knockRemoved(roomId, userId);
      await invalidate();
    },
    onError: (error, { userId }) => {
      // A knock that expired (410) or no longer exists is gone for good: stop offering it.
      if (isApiErrorCode(error, 'KNOCK_EXPIRED')) {
        useKnockStore.getState().knockRemoved(roomId, userId);
      }
    },
  });
}
