import { healthPaths } from '@focus-flow/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SystemStatus } from './system-status';

/** Only the parts of `Response` that the api-client actually reads. */
type StubResponse = Pick<Response, 'ok' | 'status'> & { json: () => Promise<unknown> };

function jsonResponse(status: number, body: unknown): StubResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

function stubFetch(handler: (path: string) => Promise<StubResponse>): void {
  vi.stubGlobal('fetch', (input: string) => handler(input));
}

function healthyLiveness(): StubResponse {
  return jsonResponse(200, { status: 'ok' });
}

function renderSystemStatus(): void {
  // A fresh cache per test, with retries off, keeps the assertions deterministic.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <SystemStatus />
    </QueryClientProvider>,
  );
}

/** The announced status region, as plain text. */
function statusText(): string {
  return screen.getByRole('status').textContent;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SystemStatus', () => {
  it('shows a loading state while the checks are in flight', () => {
    stubFetch(() => new Promise<StubResponse>(() => undefined));

    renderSystemStatus();

    expect(statusText()).toContain('Checking the API');
  });

  it('reports a ready API with both dependencies available', async () => {
    stubFetch((path) =>
      Promise.resolve(
        path.endsWith(healthPaths.readiness)
          ? jsonResponse(200, { status: 'ready', checks: { postgres: 'ok', redis: 'ok' } })
          : healthyLiveness(),
      ),
    );

    renderSystemStatus();

    expect(await screen.findByText('The API is ready.')).not.toBeNull();
    expect(statusText()).toContain('liveness: ok');
    expect(statusText()).toContain('postgres: ok');
    expect(statusText()).toContain('redis: ok');
  });

  it('names the unavailable dependency when readiness answers 503', async () => {
    stubFetch((path) =>
      Promise.resolve(
        path.endsWith(healthPaths.readiness)
          ? jsonResponse(503, {
              status: 'not_ready',
              checks: { postgres: 'ok', redis: 'unavailable' },
            })
          : healthyLiveness(),
      ),
    );

    renderSystemStatus();

    expect(await screen.findByText('The API is not ready.')).not.toBeNull();
    expect(statusText()).toContain('postgres: ok');
    expect(statusText()).toContain('redis: unavailable');
  });

  it('shows an error state when the API cannot be reached', async () => {
    stubFetch(() => Promise.reject(new Error('connection refused')));

    renderSystemStatus();

    expect(await screen.findByText('Unable to reach the API.')).not.toBeNull();
    expect(statusText()).toContain('The API could not be reached.');
  });
});
