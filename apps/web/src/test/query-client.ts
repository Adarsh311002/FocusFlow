import { QueryClient } from '@tanstack/react-query';

/**
 * A fresh client per test, so no cached data leaks between tests. Retries are off so a
 * stubbed failure surfaces immediately instead of after a backoff.
 *
 * `staleTime` and `refetchOnWindowFocus` mirror `app/providers.tsx` on purpose: with the
 * library defaults (`staleTime: 0`) every mount refetches anyway, so a test could not tell
 * whether a feature asks for fresh data itself. The review queries do (V8), and only a
 * client that would otherwise serve the cache proves it.
 */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 5_000, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}
