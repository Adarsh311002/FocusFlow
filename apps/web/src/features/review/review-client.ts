import {
  type FocusSessionListResponse,
  focusSessionListResponseSchema,
  focusSessionPaths,
  type FocusSessionSummaryResponse,
  focusSessionSummaryResponseSchema,
} from '@focus-flow/contracts';

import { authedApiRequest } from '../auth/auth-client';
import type { ReviewRange } from './review-range';

// Typed calls for the review routes (docs/api/rest.md "Focus sessions"). Every response is
// validated against the shared contract before it reaches a component.

export type ListFocusSessionsParams = {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
};

/** `GET /focus-sessions`: newest-started first, every status, one page at a time. */
export function listFocusSessions(
  params: ListFocusSessionsParams = {},
): Promise<FocusSessionListResponse> {
  const query = new URLSearchParams();
  if (params.cursor !== undefined) {
    query.set('cursor', params.cursor);
  }
  if (params.limit !== undefined) {
    query.set('limit', String(params.limit));
  }
  const search = query.toString();
  return authedApiRequest<FocusSessionListResponse>(
    search.length === 0
      ? focusSessionPaths.collection
      : `${focusSessionPaths.collection}?${search}`,
    focusSessionListResponseSchema,
  );
}

/** `GET /focus-sessions/summary`: dates in `tz`, both ends included. */
export function getFocusSessionSummary(range: ReviewRange): Promise<FocusSessionSummaryResponse> {
  const query = new URLSearchParams({ from: range.from, to: range.to, tz: range.tz });
  return authedApiRequest<FocusSessionSummaryResponse>(
    `${focusSessionPaths.summary}?${query.toString()}`,
    focusSessionSummaryResponseSchema,
  );
}
