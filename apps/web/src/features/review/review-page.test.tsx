import { authPaths, focusSessionPaths } from '@focus-flow/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  errorResponse,
  jsonResponse,
  type RecordedRequest,
  refreshBody,
  stubFetch,
} from '../../test/api-stub';
import {
  createFakeFocusSessionApi,
  emptySummary,
  fakeSession,
} from '../../test/fake-focus-session-api';
import { renderReview, REVIEW_DASHBOARD_TEXT, REVIEW_LOGIN_TEXT } from '../../test/review-route';
import { resetPendingRefresh } from '../auth/auth-client';
import { clearAccessToken } from '../auth/token-store';
import { formatDayLabel } from './review-format';

// 05:00 UTC on 9 March 2026 is the evening of 8 March in Los Angeles.
const NOW = '2026-03-09T05:00:00.000Z';
const BROWSER_ZONE = 'America/Los_Angeles';
const RANGE_DATES = [
  '2026-03-02',
  '2026-03-03',
  '2026-03-04',
  '2026-03-05',
  '2026-03-06',
  '2026-03-07',
  '2026-03-08',
];
const SERVER_ERROR = 'Something went wrong on the server. Please try again.';

/** Pretends the browser reports `zone` as its time zone. */
function useBrowserZone(zone: string): void {
  const real = new Intl.DateTimeFormat().resolvedOptions();
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
    ...real,
    timeZone: zone,
  });
}

beforeEach(() => {
  // Only `Date` is faked, so Testing Library's waits keep their real timers.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  useBrowserZone(BROWSER_ZONE);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearAccessToken();
  resetPendingRefresh();
});

const isList = (request: RecordedRequest) =>
  new URL(request.url, 'http://localhost').pathname.endsWith(focusSessionPaths.collection);
const isSummary = (request: RecordedRequest) =>
  new URL(request.url, 'http://localhost').pathname.endsWith(focusSessionPaths.summary);
const params = (request: RecordedRequest) => new URL(request.url, 'http://localhost').searchParams;

function start(options?: { pageSize?: number }) {
  const api = createFakeFocusSessionApi(options);
  api.setSummary(emptySummary(RANGE_DATES));
  const calls = stubFetch((request) => api.handle(request));
  return { api, calls };
}

const summarySection = () => screen.findByRole('region', { name: 'Last 7 days' });
const historySection = () => screen.findByRole('region', { name: 'Focus sessions' });
const sessionItems = () =>
  within(screen.getByRole('list', { name: 'Focus sessions' })).getAllByRole('listitem');

describe('Review page', () => {
  it('shows loading states while the requests are in flight', async () => {
    const api = createFakeFocusSessionApi();
    stubFetch((request) =>
      isList(request) || isSummary(request)
        ? new Promise<never>(() => undefined)
        : api.handle(request),
    );

    renderReview();

    expect(await screen.findByText('Loading your summary…')).not.toBeNull();
    expect(screen.getByText('Loading your focus sessions…')).not.toBeNull();
  });

  it('shows the empty states', async () => {
    start();
    renderReview();

    expect(await screen.findByText('No focus sessions yet.')).not.toBeNull();
    expect(
      await within(await summarySection()).findByText(
        'No finished focus sessions in this period yet.',
      ),
    ).not.toBeNull();
  });

  it('shows an alert when the history or the summary fails', async () => {
    const api = createFakeFocusSessionApi();
    stubFetch((request) =>
      isList(request) || isSummary(request) ? errorResponse(500, 'INTERNAL') : api.handle(request),
    );

    renderReview();

    expect(await within(await historySection()).findByRole('alert')).toHaveProperty(
      'textContent',
      SERVER_ERROR,
    );
    expect(await within(await summarySection()).findByRole('alert')).toHaveProperty(
      'textContent',
      SERVER_ERROR,
    );
  });

  it('asks for the last 7 days in the browser time zone and shows the summary', async () => {
    const { api, calls } = start();
    api.setSummary({
      completedCount: 2,
      completedFocusedSeconds: 3_000,
      totalFocusedSeconds: 3_600,
      days: RANGE_DATES.map((date) =>
        date === '2026-03-08'
          ? { date, completedFocusedSeconds: 3_000, totalFocusedSeconds: 3_600 }
          : { date, completedFocusedSeconds: 0, totalFocusedSeconds: 0 },
      ),
    });

    renderReview();

    const section = await summarySection();
    expect(await within(section).findByRole('table')).not.toBeNull();
    const terms = within(section)
      .getAllByRole('term')
      .map((term) => term.textContent);
    const values = within(section)
      .getAllByRole('definition')
      .map((value) => value.textContent);
    expect(terms).toEqual([
      'Completed sessions',
      'Completed focus time',
      'Total focus time (incl. stopped and abandoned)',
    ]);
    expect(values).toEqual(['2', '50 min', '1 h']);

    const table = within(section).getByRole('table', { name: 'Focus time per day' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Day', 'Completed focus', 'Total focus (incl. abandoned)']);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(7);
    const lastRow = rows[6];
    expect(lastRow).toBeDefined();
    if (lastRow !== undefined) {
      // The label uses the browser's locale; the date itself is what matters.
      expect(within(lastRow).getByRole('rowheader').textContent).toBe(formatDayLabel('2026-03-08'));
      expect(within(lastRow).getByRole('time').getAttribute('datetime')).toBe('2026-03-08');
      expect(
        within(lastRow)
          .getAllByRole('cell')
          .map((cell) => cell.textContent),
      ).toEqual(['50 min', '1 h']);
    }

    const summaryRequests = calls.filter(isSummary);
    expect(summaryRequests).toHaveLength(1);
    const query = summaryRequests[0] === undefined ? null : params(summaryRequests[0]);
    expect(query?.get('from')).toBe('2026-03-02');
    expect(query?.get('to')).toBe('2026-03-08');
    expect(query?.get('tz')).toBe(BROWSER_ZONE);
    expect(screen.queryByText(/could not be used/)).toBeNull();
  });

  it('falls back to UTC, and says so, when the browser zone is unusable', async () => {
    useBrowserZone('EST5EDT');
    const { calls } = start();

    renderReview();

    expect(
      await within(await summarySection()).findByText(
        "Your browser's time zone could not be used, so days are shown in UTC.",
      ),
    ).not.toBeNull();
    await waitFor(() => {
      expect(calls.filter(isSummary)).toHaveLength(1);
    });
    const request = calls.find(isSummary);
    expect(request === undefined ? null : params(request).get('tz')).toBe('UTC');
    // In UTC it is already 9 March.
    expect(request === undefined ? null : params(request).get('to')).toBe('2026-03-09');
  });

  it('lists sessions with their task, status, and focused against planned time', async () => {
    const { api } = start();
    api.sessions.push(
      fakeSession({
        task: { id: crypto.randomUUID(), title: 'Running now', deleted: false },
        status: 'in_progress',
        runningSince: '2026-03-09T04:50:00.000Z',
        focusedSeconds: 600,
      }),
      fakeSession({
        task: { id: crypto.randomUUID(), title: 'Paused one', deleted: false },
        status: 'in_progress',
        runningSince: null,
        focusedSeconds: 300,
      }),
      fakeSession({ task: { id: crypto.randomUUID(), title: 'Write report', deleted: false } }),
      fakeSession({
        task: { id: crypto.randomUUID(), title: 'Old task', deleted: true },
        status: 'abandoned',
        abandonReason: 'stopped',
        focusedSeconds: 750,
        endedAt: '2026-03-09T10:12:30.000Z',
      }),
      fakeSession({
        task: null,
        status: 'abandoned',
        abandonReason: 'grace_expired',
        focusedSeconds: 90,
        endedAt: '2026-03-09T10:02:00.000Z',
      }),
      fakeSession({
        task: { id: crypto.randomUUID(), title: 'Forgotten', deleted: false },
        status: 'abandoned',
        abandonReason: 'expired',
        focusedSeconds: 0,
        endedAt: '2026-03-09T22:00:00.000Z',
      }),
    );

    renderReview();

    const running = await screen.findByRole('listitem', { name: 'Running now, In progress' });
    expect(running.textContent).toContain('Focused 10 min of 25 min planned');
    expect(running.textContent).toContain('plus the current running stretch');
    expect(running.textContent).not.toContain('Ended');

    const paused = screen.getByRole('listitem', { name: 'Paused one, Paused' });
    expect(paused.textContent).toContain('Focused 5 min of 25 min planned');
    expect(paused.textContent).not.toContain('running stretch');

    const completed = screen.getByRole('listitem', { name: 'Write report, Completed' });
    expect(completed.textContent).toContain('Focused 25 min of 25 min planned');
    expect(
      within(completed)
        .getAllByRole('time')
        .map((t) => t.getAttribute('datetime')),
    ).toEqual(['2026-03-09T10:00:00.000Z', '2026-03-09T10:25:00.000Z']);

    const stopped = screen.getByRole('listitem', { name: 'Old task, Stopped early' });
    expect(within(stopped).getByText('(deleted)')).not.toBeNull();
    expect(stopped.textContent).toContain('Focused 12 min of 25 min planned');

    const noTask = screen.getByRole('listitem', { name: 'No task, Disconnected' });
    expect(noTask.textContent).toContain('Focused 1 min of 25 min planned');

    expect(screen.getByRole('listitem', { name: 'Forgotten, Expired' })).not.toBeNull();
    expect(within(completed).queryByText('(deleted)')).toBeNull();

    // Newest started first, in the order the API sent them.
    expect(sessionItems().map((item) => item.getAttribute('aria-label'))).toEqual([
      'Running now, In progress',
      'Paused one, Paused',
      'Write report, Completed',
      'Old task, Stopped early',
      'No task, Disconnected',
      'Forgotten, Expired',
    ]);
  });

  it('pages through the history with Load more, sending the cursor and without duplicates', async () => {
    const { api, calls } = start({ pageSize: 2 });
    for (const title of ['s1', 's2', 's3']) {
      api.sessions.push(fakeSession({ task: { id: crypto.randomUUID(), title, deleted: false } }));
    }
    renderReview();

    await screen.findByRole('listitem', { name: 's2, Completed' });
    expect(screen.queryByRole('listitem', { name: 's3, Completed' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByRole('listitem', { name: 's3, Completed' })).not.toBeNull();
    expect(sessionItems()).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    const cursors = calls.filter(isList).map((request) => params(request).get('cursor'));
    expect(cursors).toEqual([null, `c-${api.sessions[1]?.id ?? ''}`]);
  });

  it('disables Load more while the next page is loading', async () => {
    const api = createFakeFocusSessionApi({ pageSize: 1 });
    api.setSummary(emptySummary(RANGE_DATES));
    api.sessions.push(fakeSession(), fakeSession());
    let release: (() => void) | undefined;
    stubFetch((request) => {
      if (isList(request) && params(request).has('cursor')) {
        return new Promise<Response>((resolve) => {
          release = () => {
            resolve(api.handle(request));
          };
        });
      }
      return api.handle(request);
    });
    renderReview();
    await screen.findByRole('button', { name: 'Load more' });

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    const pending = await screen.findByRole('button', { name: 'Loading…' });
    expect(pending).toHaveProperty('disabled', true);
    release?.();
    await waitFor(() => {
      expect(sessionItems()).toHaveLength(2);
    });
  });

  it('keeps the loaded sessions and shows an error when the next page fails', async () => {
    const api = createFakeFocusSessionApi({ pageSize: 1 });
    api.setSummary(emptySummary(RANGE_DATES));
    api.sessions.push(
      fakeSession({ task: { id: crypto.randomUUID(), title: 'First', deleted: false } }),
      fakeSession({ task: { id: crypto.randomUUID(), title: 'Second', deleted: false } }),
    );
    let failNext = true;
    stubFetch((request) => {
      if (isList(request) && params(request).has('cursor') && failNext) {
        failNext = false;
        return errorResponse(500, 'INTERNAL');
      }
      return api.handle(request);
    });
    renderReview();
    await screen.findByRole('listitem', { name: 'First, Completed' });

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    const section = await historySection();
    expect(await within(section).findByRole('alert')).toHaveProperty('textContent', SERVER_ERROR);
    expect(screen.getByRole('listitem', { name: 'First, Completed' })).not.toBeNull();

    // Trying again once the API recovers loads the page and clears the error.
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('listitem', { name: 'Second, Completed' })).not.toBeNull();
    expect(within(section).queryByRole('alert')).toBeNull();
  });

  it('redirects an anonymous visitor to the sign-in page', async () => {
    const calls = stubFetch(() => errorResponse(401, 'SESSION_INVALID', 'No session.'));

    renderReview();

    expect(await screen.findByText(REVIEW_LOGIN_TEXT)).not.toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    expect(calls.filter((request) => isList(request) || isSummary(request))).toEqual([]);
  });

  it('navigates between Dashboard and Review and refetches when coming back', async () => {
    const { calls } = start();
    renderReview();
    await screen.findByText('No focus sessions yet.');

    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Review' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Dashboard' }).getAttribute('aria-current')).toBe(
      null,
    );
    const listRequestsBefore = calls.filter(isList).length;
    const summaryRequestsBefore = calls.filter(isSummary).length;

    fireEvent.click(within(nav).getByRole('link', { name: 'Dashboard' }));
    expect(await screen.findByText(REVIEW_DASHBOARD_TEXT)).not.toBeNull();
    expect(within(nav).getByRole('link', { name: 'Dashboard' }).getAttribute('aria-current')).toBe(
      'page',
    );

    fireEvent.click(within(nav).getByRole('link', { name: 'Review' }));
    await screen.findByText('No focus sessions yet.');
    // Both halves of the page ask again (V8). The test client keeps data fresh for five
    // seconds like the real one, so neither of these counts moves unless the query itself
    // asks to refetch on mount.
    await waitFor(() => {
      expect(calls.filter(isList).length).toBe(listRequestsBefore + 1);
    });
    await waitFor(() => {
      expect(calls.filter(isSummary).length).toBe(summaryRequestsBefore + 1);
    });
  });

  it('restores a session before asking for the history', async () => {
    const api = createFakeFocusSessionApi();
    const calls = stubFetch((request) =>
      request.url.endsWith(authPaths.refresh)
        ? jsonResponse(200, refreshBody('restored'))
        : api.handle(request),
    );

    renderReview();

    await screen.findByText('No focus sessions yet.');
    const list = calls.find(isList);
    expect(list?.headers.get('Authorization')).toBe('Bearer restored');
  });
});
