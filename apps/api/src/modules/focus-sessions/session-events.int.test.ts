import {
  API_BASE_PATH,
  focusSessionIdSchema,
  focusSessionPath,
  focusSessionPaths,
  focusSessionResponseSchema,
  type FocusSessionUpdatedEvent,
  focusSessionUpdatedEventSchema,
  type FocusSessionView,
} from '@focus-flow/contracts';
import { eq, sql } from 'drizzle-orm';
import type { Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { startTestHarness, stopTestHarness, type TestHarness } from '../../../test/harness.js';
import { closeAllSockets, connectSocket } from '../../../test/sockets.js';
import { signUpTestUser, type TestUser } from '../../../test/users.js';
import { focusSessions } from '../../db/schema.js';

// `focus:session:updated` (E6) over a real Socket.IO connection: the owner's every tab
// receives the committed session after each REST transition, in order, and nobody else
// does. The event is a hint: it only has to carry the committed view; clients refetch.

let harness: TestHarness | undefined;

const requireHarness = (): TestHarness => {
  if (harness === undefined) {
    throw new Error('the harness failed to start');
  }
  return harness;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (condition: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition().catch(() => false)) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error('condition not met in time');
    }
    await sleep(50);
  }
};

const call = async (user: TestUser, path: string, body?: unknown) => {
  const response = await fetch(`${requireHarness().baseUrl}${API_BASE_PATH}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${user.accessToken}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return focusSessionResponseSchema.parse(await response.json()).session;
};

const start = (user: TestUser) =>
  call(user, focusSessionPaths.collection, { plannedSeconds: 1_500 });

const act = (user: TestUser, verb: 'pause' | 'resume' | 'stop', session: FocusSessionView) =>
  call(user, focusSessionPath(focusSessionPaths[verb], focusSessionIdSchema.parse(session.id)));

/** Collects every `focus:session:updated` payload this socket receives, validated. */
const recordEvents = (socket: Socket): FocusSessionUpdatedEvent[] => {
  const received: FocusSessionUpdatedEvent[] = [];
  socket.on('focus:session:updated', (payload: unknown) => {
    received.push(focusSessionUpdatedEventSchema.parse(payload));
  });
  return received;
};

const onlineUser = async (label: string) => {
  const h = requireHarness();
  const user = await signUpTestUser(h, label);
  const socket = await connectSocket(h.baseUrl, user.accessToken);
  await waitFor(() => h.runtime.presence.isUserOnline(user.userId));
  return { user, socket };
};

beforeAll(async () => {
  // Redis is made to look a week old: a fresh epoch is inside the presence-recovery window
  // (E18), where starting a session answers 503 by design.
  harness = await startTestHarness({}, { epochAgeMs: 7 * 86_400_000 });
}, 180_000);

afterEach(() => {
  closeAllSockets();
});

afterAll(async () => {
  closeAllSockets();
  if (harness !== undefined) {
    await stopTestHarness(harness);
  }
}, 60_000);

describe('focus:session:updated', () => {
  it('reaches every tab of the owner after each committed transition, in order', async () => {
    const h = requireHarness();
    const { user, socket } = await onlineUser('events-owner');
    const secondTab = await connectSocket(h.baseUrl, user.accessToken);
    const first = recordEvents(socket);
    const second = recordEvents(secondTab);

    const started = await start(user);
    await act(user, 'pause', started);
    await act(user, 'resume', started);
    await act(user, 'stop', started);

    const expected = ['in_progress', 'in_progress', 'in_progress', 'abandoned'];
    await waitFor(() => Promise.resolve(first.length === 4 && second.length === 4));
    expect(first.map((event) => event.session.status)).toEqual(expected);
    expect(second.map((event) => event.session.status)).toEqual(expected);
    expect(first.map((event) => event.session.id)).toEqual(Array(4).fill(started.id));
    // pause leaves the stretch (`runningSince: null`), resume starts a new one.
    expect(
      first.map(
        (event) => event.session.status === 'in_progress' && event.session.runningSince === null,
      ),
    ).toEqual([false, true, false, false]);
    const ended = first[3]?.session;
    expect(ended).toMatchObject({ status: 'abandoned', abandonReason: 'stopped' });
  });

  it('is never delivered to another user', async () => {
    const owner = await onlineUser('events-a');
    const bystander = await onlineUser('events-b');
    const ownerEvents = recordEvents(owner.socket);
    const bystanderEvents = recordEvents(bystander.socket);

    await start(owner.user);

    await waitFor(() => Promise.resolve(ownerEvents.length === 1));
    // Give a wrongly routed event time to arrive before asserting its absence.
    await sleep(300);
    expect(bystanderEvents).toEqual([]);
  });

  it('is not sent for a request that changes nothing (a repeated stop, E11)', async () => {
    const { user, socket } = await onlineUser('events-repeat');
    const events = recordEvents(socket);

    const started = await start(user);
    await act(user, 'stop', started);
    await waitFor(() => Promise.resolve(events.length === 2));
    await act(user, 'stop', started);
    await sleep(300);

    expect(events).toHaveLength(2);
  });

  it('also reaches the socket when a job, not a request, settles the session', async () => {
    const h = requireHarness();
    const { user, socket } = await onlineUser('events-job');
    const events = recordEvents(socket);
    const started = await start(user);
    await waitFor(() => Promise.resolve(events.length === 1));

    // Age the session past the 12 h stale window (E2) and let the reconciler settle it, as
    // the worker would: no HTTP request is involved in this transition.
    const shift = sql`make_interval(secs => ${13 * 3_600})`;
    await h.db
      .update(focusSessions)
      .set({
        startedAt: sql`${focusSessions.startedAt} - ${shift}`,
        runningSince: sql`${focusSessions.runningSince} - ${shift}`,
      })
      .where(eq(focusSessions.id, started.id));
    await h.runtime.reconciler.run({
      schemaVersion: 1,
      trigger: 'recovery',
      correlationId: 'events',
    });

    await waitFor(() => Promise.resolve(events.length === 2));
    const settled = events[1]?.session;
    expect(settled?.id).toBe(started.id);
    expect(settled?.status).not.toBe('in_progress');
    const [stored] = await h.db
      .select()
      .from(focusSessions)
      .where(eq(focusSessions.id, started.id));
    expect(stored?.status).toBe(settled?.status);
  });
});
