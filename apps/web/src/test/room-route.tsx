import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render } from '@testing-library/react';

import { router as appRouter } from '../app/router';
import { AuthProvider } from '../features/auth/auth-context';
import { RealtimeProvider } from '../features/realtime/realtime-provider';
import { type RecordedRequest, stubFetch } from './api-stub';
import { createGate, type Gate } from './fake-focus-session-api';
import { createFakeRoomApi } from './fake-room-api';
import { createFakeRoomClient } from './fake-room-client';
import { createTestQueryClient } from './query-client';

/**
 * The application's own route tree (real guards, shell and `/rooms` routes) over an in-memory
 * history, with the real providers, a fake room API behind a stubbed `fetch` and a
 * programmable fake realtime client. The caller seeds the API first (rooms need ids to visit),
 * then calls `render(path)`.
 */
export function prepareRooms() {
  const api = createFakeRoomApi();
  const holds: Array<{ match: (request: RecordedRequest) => boolean; gate: Gate }> = [];
  const calls = stubFetch(async (request) => {
    // The answer is computed on arrival and delivered when the gate opens: a slow response.
    const response = api.handle(request);
    const index = holds.findIndex((hold) => hold.match(request));
    const [hold] = index < 0 ? [] : holds.splice(index, 1);
    await hold?.gate.wait;
    return response;
  });
  const client = createFakeRoomClient();
  const queryClient = createTestQueryClient();
  return {
    api,
    calls,
    client,
    queryClient,
    /** Holds the next request the matcher accepts until the returned function is called. */
    hold: (match: (request: RecordedRequest) => boolean): (() => void) => {
      const gate = createGate();
      holds.push({ match, gate });
      return gate.open;
    },
    render: (initialPath: string) => {
      const router = createRouter({
        routeTree: appRouter.routeTree,
        history: createMemoryHistory({ initialEntries: [initialPath] }),
      });
      render(
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <RealtimeProvider client={client}>
              <RouterProvider router={router} />
            </RealtimeProvider>
          </AuthProvider>
        </QueryClientProvider>,
      );
      return router;
    },
  };
}
