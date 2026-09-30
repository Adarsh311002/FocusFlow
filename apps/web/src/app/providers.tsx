import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { AuthProvider } from '../features/auth/auth-context';

/**
 * Created once for the lifetime of the module so the cache survives re-renders.
 * Tests build their own client instead of importing this one.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 5_000,
      refetchOnWindowFocus: false,
    },
  },
});

/**
 * `AuthProvider` sits inside the query client because it clears the cache whenever the
 * session changes; the session itself is not stored in TanStack Query.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
}
