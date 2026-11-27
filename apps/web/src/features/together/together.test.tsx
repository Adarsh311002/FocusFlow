import type { BuddyNudgeEvent, UpcomingSession } from '@focus-flow/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { jsonResponse, noContentResponse, parsedBody, stubFetch } from '../../test/api-stub';
import { createFakeTaskApi } from '../../test/fake-task-api';
import { createTestQueryClient } from '../../test/query-client';
import { createStubRealtimeClient } from '../../test/realtime-stub';
import { resetPendingRefresh } from '../auth/auth-client';
import { AuthProvider } from '../auth/auth-context';
import { clearAccessToken } from '../auth/token-store';
import { RealtimeProvider } from '../realtime/realtime-provider';
import { BuddiesPage } from './buddies-page';
import { RoomSchedule } from './room-together';
import { TogetherNotices, whenLabel } from './together-notices';

// Focusing with others on the web (BD5, SC4).

afterEach(() => {
  vi.unstubAllGlobals();
  clearAccessToken();
  resetPendingRefresh();
});

const BEN = '01900000-0000-7000-8000-0000000000b1';
const CLEO = '01900000-0000-7000-8000-0000000000c1';

function world() {
  const api = createFakeTaskApi();
  let incoming = [
    {
      userId: CLEO,
      displayName: 'Cleo',
      avatarPreset: 'owl',
      requestedAt: '2026-11-25T08:00:00.000Z',
    },
  ];
  const buddies = [
    {
      userId: BEN,
      displayName: 'Ben',
      avatarPreset: null,
      focusingNow: false,
      currentStreak: 4,
      weekFocusedSeconds: 7_200,
    },
  ];
  const calls = stubFetch((request) => {
    const path = new URL(request.url, 'http://x').pathname.replace('/api/v1', '');
    if (path === '/buddies' && request.method === 'GET') {
      return jsonResponse(200, { code: 'K7MQ2RXA', buddies, incoming, outgoing: [] });
    }
    if (path === '/buddies' && request.method === 'POST') {
      return jsonResponse(200, { status: 'requested' });
    }
    if (path === `/buddies/${CLEO}/accept`) {
      incoming = [];
      return noContentResponse();
    }
    if (path.endsWith('/nudge')) {
      return noContentResponse();
    }
    if (path.startsWith('/rooms/') && path.endsWith('/schedules') && request.method === 'GET') {
      return jsonResponse(200, { schedules: [] });
    }
    if (path.startsWith('/rooms/') && path.endsWith('/schedules') && request.method === 'POST') {
      const body = parsedBody(request);
      return jsonResponse(201, {
        schedule: {
          id: crypto.randomUUID(),
          roomId: '01900000-0000-7000-8000-0000000000aa',
          title: String(body.title),
          startsAt: String(body.startsAt),
          durationMinutes: Number(body.durationMinutes),
          repeatsWeekly: Boolean(body.repeatsWeekly),
          nextStartsAt: String(body.startsAt),
        },
      });
    }
    if (path === '/me/upcoming-sessions') {
      return jsonResponse(200, { sessions: [] });
    }
    return api.handle(request);
  });
  return { calls };
}

function renderWith(element: React.ReactNode, client = createStubRealtimeClient()) {
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <AuthProvider>
        <RealtimeProvider client={client}>{element}</RealtimeProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe('the buddies page', () => {
  it('shows your code and your buddies, accepts a request, asks by code and nudges', async () => {
    const { calls } = world();
    renderWith(<BuddiesPage />);

    expect(await screen.findByText('K7MQ2RXA')).not.toBeNull();
    const ben = screen.getByRole('listitem', { name: 'Ben' });
    expect(within(ben).getByText('4-day streak · 2 h this week')).not.toBeNull();

    const cleo = screen.getByRole('listitem', { name: 'Cleo' });
    fireEvent.click(within(cleo).getByRole('button', { name: 'Accept' }));
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Asking to join you' })).toBeNull();
    });

    fireEvent.change(screen.getByLabelText('Their buddy code'), { target: { value: 'abcd2345' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByText('Asked. You become buddies when they accept.')).not.toBeNull();

    fireEvent.click(within(ben).getByRole('button', { name: 'Nudge' }));
    expect(await within(ben).findByRole('button', { name: 'Nudged 🌿' })).not.toBeNull();
    const posts = calls.filter((call) => call.method === 'POST' && call.url.includes('/buddies'));
    expect(
      posts.map((call) => new URL(call.url, 'http://x').pathname.replace('/api/v1', '')),
    ).toEqual([`/buddies/${CLEO}/accept`, '/buddies', `/buddies/${BEN}/nudge`]);
  });
});

describe('notices', () => {
  it('shows a nudge that arrives live', async () => {
    world();
    const stub = createStubRealtimeClient();
    let deliver: ((event: BuddyNudgeEvent) => void) | null = null;
    const client = {
      ...stub,
      onBuddyNudge: (listener: (event: BuddyNudgeEvent) => void) => {
        deliver = listener;
        return () => {
          deliver = null;
        };
      },
    };
    renderWith(<TogetherNotices />, client);
    await waitFor(() => {
      expect(deliver).not.toBeNull();
    });
    act(() => {
      deliver?.({ fromUserId: BEN as BuddyNudgeEvent['fromUserId'], displayName: 'Ben' });
    });
    expect(await screen.findByText(/nudged you/)).not.toBeNull();
  });

  it('words a session that is coming or under way', () => {
    const session = { startsAt: '2026-11-26T09:00:00.000Z' } as UpcomingSession;
    const start = Date.parse(session.startsAt);
    expect(whenLabel(session, start - 8 * 60_000)).toBe('starts in 8 min');
    expect(whenLabel(session, start + 60_000)).toBe('under way now');
  });
});

describe('planning a room session', () => {
  it('lets the host plan a weekly session; members only see the plans', async () => {
    const { calls } = world();
    renderWith(<RoomSchedule roomId="01900000-0000-7000-8000-0000000000aa" isHost />);
    fireEvent.change(await screen.findByLabelText('What'), {
      target: { value: 'Morning deep work' },
    });
    fireEvent.change(screen.getByLabelText('When'), { target: { value: '2030-01-07T08:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Plan it' }));
    await waitFor(() => {
      expect(calls.some((call) => call.method === 'POST' && call.url.includes('/schedules'))).toBe(
        true,
      );
    });
    const post = calls.find((call) => call.method === 'POST' && call.url.includes('/schedules'));
    expect(post === undefined ? null : parsedBody(post)).toMatchObject({
      title: 'Morning deep work',
      durationMinutes: 50,
      repeatsWeekly: true,
    });
  });

  it('shows no planning form to a member', async () => {
    world();
    renderWith(<RoomSchedule roomId="01900000-0000-7000-8000-0000000000aa" isHost={false} />);
    expect(await screen.findByText('Nothing planned yet.')).not.toBeNull();
    expect(screen.queryByRole('form', { name: 'Plan a session' })).toBeNull();
  });
});
