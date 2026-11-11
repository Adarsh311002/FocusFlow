import { configure, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { stubFetch } from '../../test/api-stub';
import {
  createFakeFocusSessionApi,
  emptySummary,
  fakeSession,
} from '../../test/fake-focus-session-api';
import { renderReview } from '../../test/review-route';
import { resetPendingRefresh } from '../auth/auth-client';
import { clearAccessToken } from '../auth/token-store';

configure({ asyncUtilTimeout: 4_000 });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-03-09T05:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearAccessToken();
  resetPendingRefresh();
});

const ROOM_ID = '0192f8a0-3333-7aaa-8bbb-000000000003';
const RUN_ID = '0192f8a0-1111-7aaa-8bbb-000000000001';

describe('Review and room focus sessions', () => {
  it('labels room sessions with how they ended and links to their room', async () => {
    const api = createFakeFocusSessionApi();
    api.setSummary(emptySummary());
    api.sessions.push(
      fakeSession({
        context: { kind: 'room', roomId: ROOM_ID, focusRunId: RUN_ID },
        status: 'abandoned',
        abandonReason: 'reset',
        focusedSeconds: 300,
        task: null,
        startedAt: '2026-03-08T10:00:00.000Z',
        endedAt: '2026-03-08T10:05:00.000Z',
      }),
      fakeSession({ startedAt: '2026-03-07T10:00:00.000Z', endedAt: '2026-03-07T10:25:00.000Z' }),
    );
    stubFetch((request) => api.handle(request));

    renderReview();

    const list = await screen.findByRole('list', { name: 'Focus sessions' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    const room = items[0];
    expect(room?.getAttribute('aria-label')).toBe('No task, Timer reset');
    expect(within(room as HTMLElement).getByText(/Focused together in a room/)).not.toBeNull();
    expect(
      within(room as HTMLElement)
        .getByRole('link', { name: 'Open the room' })
        .getAttribute('href'),
    ).toBe(`/rooms/${ROOM_ID}`);
    // A solo session shows no room line.
    expect(within(items[1] as HTMLElement).queryByText(/Focused together/)).toBeNull();
  });
});
