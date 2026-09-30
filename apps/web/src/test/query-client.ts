import { QueryClient } from '@tanstack/react-query';

/**
 * A fresh client per test, so no cached data leaks between tests. Retries are off so a
 * stubbed failure surfaces immediately instead of after a backoff.
 */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}
