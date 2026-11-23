import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { useAuth } from '../auth/auth-context';
import { getFocusSessionSummary, listFocusSessions } from './review-client';
import type { ReviewRange } from './review-range';

// Server state for the Review page lives in TanStack Query, keyed by user id like the
// tasks (task-queries.ts). No realtime event updates these yet, so they are always
// considered stale and refetched whenever the page mounts again.

const NO_USER = 'signed-out';

/** The first page has no cursor; typed so later pages can carry one. */
const FIRST_PAGE: string | undefined = undefined;

export const focusSessionKeys = {
  all: (userId: string) => ['focus-sessions', userId] as const,
  history: (userId: string) => ['focus-sessions', userId, 'history'] as const,
  summary: (userId: string, range: ReviewRange) =>
    ['focus-sessions', userId, 'summary', range.from, range.to, range.tz] as const,
};

const FRESHNESS = { staleTime: 0, refetchOnMount: 'always' } as const;

function useUserId(): string {
  return useAuth().user?.id ?? NO_USER;
}

/** Newest-started first, one page at a time; `fetchNextPage` follows `nextCursor`. */
export function useFocusSessionHistory() {
  const userId = useUserId();
  return useInfiniteQuery({
    queryKey: focusSessionKeys.history(userId),
    queryFn: ({ pageParam }) => listFocusSessions({ cursor: pageParam }),
    initialPageParam: FIRST_PAGE,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: userId !== NO_USER,
    ...FRESHNESS,
  });
}

export function useFocusSessionSummary(range: ReviewRange) {
  const userId = useUserId();
  return useQuery({
    queryKey: focusSessionKeys.summary(userId, range),
    queryFn: () => getFocusSessionSummary(range),
    enabled: userId !== NO_USER,
    ...FRESHNESS,
  });
}
