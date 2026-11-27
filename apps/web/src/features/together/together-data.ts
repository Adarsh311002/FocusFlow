import {
  buddiesResponseSchema,
  buddyRequestResponseSchema,
  type CreateRoomScheduleRequest,
  roomRecapResponseSchema,
  roomScheduleResponseSchema,
  roomSchedulesResponseSchema,
  upcomingSessionsResponseSchema,
} from '@focus-flow/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { authedApiRequest, authedApiRequestNoContent } from '../auth/auth-client';
import { useAuth } from '../auth/auth-context';
import { readBrowserTimeZone, resolveTimeZone } from '../review/review-range';

// Focusing with others on the web (BD5, SC4, RR3): TanStack Query for every read, a refetch
// after every write. Nothing here is live except the nudge (`buddy:nudge`).

const NO_USER = 'signed-out';

function useUserId(): string {
  return useAuth().user?.id ?? NO_USER;
}

function useZone(): string {
  const [tz] = useState(() => resolveTimeZone(readBrowserTimeZone()).timeZone);
  return tz;
}

const keys = {
  buddies: (userId: string) => ['buddies', userId] as const,
  schedules: (userId: string, roomId: string) => ['room-schedules', userId, roomId] as const,
  upcoming: (userId: string) => ['room-schedules', userId, 'upcoming'] as const,
  recap: (userId: string, roomId: string) =>
    ['focus-sessions', userId, 'room-recap', roomId] as const,
};

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined
    ? {}
    : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
});

// ---- Buddies -------------------------------------------------------------------------

export function useBuddies() {
  const userId = useUserId();
  const tz = useZone();
  return useQuery({
    queryKey: keys.buddies(userId),
    queryFn: () => authedApiRequest(`/buddies?tz=${encodeURIComponent(tz)}`, buddiesResponseSchema),
    enabled: userId !== NO_USER,
    // "Focusing now" changes without any event: look again every minute while shown.
    refetchInterval: 60_000,
  });
}

function useBuddyWrite<Variables, Result>(fn: (variables: Variables) => Promise<Result>) {
  const userId = useUserId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.buddies(userId) }),
  });
}

export const useRequestBuddy = () =>
  useBuddyWrite(
    async (code: string) =>
      (await authedApiRequest('/buddies', buddyRequestResponseSchema, json('POST', { code })))
        .status,
  );

export const useAcceptBuddy = () =>
  useBuddyWrite((otherId: string) =>
    authedApiRequestNoContent(`/buddies/${encodeURIComponent(otherId)}/accept`, json('POST')),
  );

export const useRemoveBuddy = () =>
  useBuddyWrite((otherId: string) =>
    authedApiRequestNoContent(`/buddies/${encodeURIComponent(otherId)}`, json('DELETE')),
  );

export function useNudgeBuddy() {
  return useMutation({
    mutationFn: (otherId: string) =>
      authedApiRequestNoContent(`/buddies/${encodeURIComponent(otherId)}/nudge`, json('POST')),
  });
}

// ---- Schedules -------------------------------------------------------------------------

export function useRoomSchedules(roomId: string) {
  const userId = useUserId();
  return useQuery({
    queryKey: keys.schedules(userId, roomId),
    queryFn: async () =>
      (
        await authedApiRequest(
          `/rooms/${encodeURIComponent(roomId)}/schedules`,
          roomSchedulesResponseSchema,
        )
      ).schedules,
    enabled: userId !== NO_USER,
  });
}

function useScheduleWrite<Variables, Result>(fn: (variables: Variables) => Promise<Result>) {
  const userId = useUserId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['room-schedules', userId] }),
  });
}

export const useCreateSchedule = (roomId: string) =>
  useScheduleWrite(
    async (request: CreateRoomScheduleRequest) =>
      (
        await authedApiRequest(
          `/rooms/${encodeURIComponent(roomId)}/schedules`,
          roomScheduleResponseSchema,
          json('POST', request),
        )
      ).schedule,
  );

export const useDeleteSchedule = (roomId: string) =>
  useScheduleWrite((scheduleId: string) =>
    authedApiRequestNoContent(
      `/rooms/${encodeURIComponent(roomId)}/schedules/${encodeURIComponent(scheduleId)}`,
      json('DELETE'),
    ),
  );

/** SC4: the next 24 hours across the user's rooms, read again every minute. */
export function useUpcomingSessions() {
  const userId = useUserId();
  return useQuery({
    queryKey: keys.upcoming(userId),
    queryFn: async () =>
      (await authedApiRequest('/me/upcoming-sessions', upcomingSessionsResponseSchema)).sessions,
    enabled: userId !== NO_USER,
    refetchInterval: 60_000,
  });
}

// ---- Recap ----------------------------------------------------------------------------

/** RR3: under the focus-session keys, so a session ending refreshes it like Review. */
export function useRoomRecap(roomId: string) {
  const userId = useUserId();
  const tz = useZone();
  return useQuery({
    queryKey: keys.recap(userId, roomId),
    queryFn: () =>
      authedApiRequest(
        `/rooms/${encodeURIComponent(roomId)}/recap?tz=${encodeURIComponent(tz)}`,
        roomRecapResponseSchema,
      ),
    enabled: userId !== NO_USER,
  });
}
