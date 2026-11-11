import type { RoomFocusParticipant } from '@focus-flow/contracts';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import type { SocketEmitter } from '../../platform/socket.js';
import type { RoomFocusChange, RoomFocusService } from '../room-focus/types.js';
import type { RoomTimerScheduler } from '../room-timer/jobs.js';
import type { TimerChange, TimerState } from '../room-timer/types.js';
import { attachFocusAnnouncers } from './focus-announcers.js';
import { createPresenceHooks, type RoomFocusPort } from './focus-hooks.js';
import { createRoomPresence } from './room-presence.js';
import type { RoomPresenceStore } from './store.js';
import { attachTimerFollowUps } from './timer-follow-ups.js';

// The glue between rooms and room focus runs, without Redis or sockets: what the timer
// follow-ups, the announcers and the presence hooks do with a fake service (RF3, RF7, RF12).

const ROOM = '01a0ed0d-55de-7d1b-8495-82fb5050d815';
const USER = '01a0ed0d-55de-7d1b-8495-82fb5050d816';
const RUN_OLD = '01a0ed0d-55de-7d1b-8495-82fb5050d817';
const RUN_NEW = '01a0ed0d-55de-7d1b-8495-82fb5050d818';

type Emitted = { room: string; event: string; payload: unknown };

const recordingEmitter = (log: string[] = []) => {
  const emitted: Emitted[] = [];
  const emitter = {
    to: (room: string) => ({
      except: () => ({ emit: () => undefined }),
      emit: (event: string, payload: unknown) => {
        emitted.push({ room, event, payload });
        log.push(`emit:${event}`);
      },
    }),
  } as unknown as SocketEmitter;
  return { emitter, emitted };
};

const fakeLogger = () => {
  const warn = vi.fn();
  return { logger: { warn, info: vi.fn(), error: vi.fn() } as unknown as Logger, warn };
};

const state = (overrides: Partial<TimerState> = {}): TimerState => ({
  phase: 'focus',
  status: 'idle',
  durationMs: 1_500_000,
  elapsedBeforeMs: 0,
  segmentStartedAtMs: null,
  version: 10,
  focusRunId: RUN_NEW,
  ...overrides,
});

const participant = (): RoomFocusParticipant =>
  ({
    userId: USER,
    displayName: 'Ada',
    avatarUrl: null,
    optedInAtMs: 5,
    connected: true,
    disconnectedAtMs: null,
  }) as RoomFocusParticipant;

describe('timer follow-ups with focus runs', () => {
  const setup = (
    focusOverrides: Partial<Pick<RoomFocusService, 'participants' | 'settleRun'>> = {},
    scheduleTimeoutMs = 50,
  ) => {
    const log: string[] = [];
    const { emitter, emitted } = recordingEmitter(log);
    const { logger, warn } = fakeLogger();
    const scheduler = {
      ensurePhaseEnd: () => {
        log.push('schedule');
        return Promise.resolve('added');
      },
    } as unknown as RoomTimerScheduler;
    const participants = vi.fn(() => {
      log.push('participants');
      return Promise.resolve({ focusRunId: RUN_NEW, participants: [], participantsVersion: 0 });
    });
    const settleRun = vi.fn(() => {
      log.push('settle');
      return Promise.resolve('settled' as const);
    });
    let listener: ((change: TimerChange) => void | Promise<void>) | undefined;
    attachTimerFollowUps(
      {
        onChange: (next) => {
          listener = next;
        },
      },
      {
        scheduler,
        emitter,
        logger,
        scheduleTimeoutMs,
        focus: { participants, settleRun, ...focusOverrides },
      },
    );
    const fire = async (change: Partial<TimerChange> & { state: TimerState }) => {
      await listener?.({ roomId: ROOM, cause: 'command', nowMs: 1_000, ...change });
    };
    return { log, emitted, warn, participants, settleRun, fire };
  };

  it('does nothing extra for a change without run effects', async () => {
    const { log, participants, settleRun, fire } = setup();
    await fire({ state: state({ status: 'paused' }) });
    expect(log).toEqual(['emit:room:timer:state']);
    expect(participants).not.toHaveBeenCalled();
    expect(settleRun).not.toHaveBeenCalled();
  });

  it('after the timer event: announces the new run and settles the closed one, detached', async () => {
    const { log, emitted, settleRun, fire } = setup();
    await fire({
      state: state({ status: 'running', segmentStartedAtMs: 1_000 }),
      runs: {
        close: { runId: RUN_OLD, reason: 'reset', closedAtMs: 1_000, elapsedAtCloseMs: 10 },
        open: { runId: RUN_NEW, openedAtMs: 1_000 },
      },
    });
    // The timer event is first; the two follow-ups run detached and in parallel, so their
    // relative order is incidental.
    await vi.waitFor(() => {
      expect(log).toHaveLength(5);
    });
    expect(log.slice(0, 2)).toEqual(['schedule', 'emit:room:timer:state']);
    expect(log.slice(2).sort()).toEqual(['emit:room:focus:participants', 'participants', 'settle']);
    expect(settleRun).toHaveBeenCalledWith(ROOM, RUN_OLD);
    expect(emitted.find((entry) => entry.event === 'room:focus:participants')).toMatchObject({
      room: `room:${ROOM}`,
      event: 'room:focus:participants',
      payload: { roomId: ROOM, focusRunId: RUN_NEW, participants: [], participantsVersion: 0 },
    });
  });

  it('a run that only opens (a break ended) is announced and settles nothing', async () => {
    const { settleRun, participants, fire } = setup();
    await fire({ state: state(), runs: { open: { runId: RUN_NEW, openedAtMs: 1_000 } } });
    expect(participants).toHaveBeenCalledTimes(1);
    expect(settleRun).not.toHaveBeenCalled();
  });

  it('a run that only closes (focus to break) is announced with no run and settled', async () => {
    const { emitted, settleRun, fire } = setup({
      participants: vi.fn(() =>
        Promise.resolve({ focusRunId: null, participants: [], participantsVersion: 0 }),
      ),
    });
    await fire({
      state: state({ phase: 'short_break', focusRunId: null }),
      runs: {
        close: { runId: RUN_OLD, reason: 'completed', closedAtMs: 1_000, elapsedAtCloseMs: 1 },
      },
    });
    await vi.waitFor(() => {
      expect(emitted.at(-1)).toMatchObject({
        event: 'room:focus:participants',
        payload: { focusRunId: null, participants: [], participantsVersion: 0 },
      });
    });
    expect(settleRun).toHaveBeenCalledWith(ROOM, RUN_OLD);
  });

  it('a failing announcement still settles, and a failing settlement is only logged', async () => {
    const failing = vi.fn(() => Promise.reject(new Error('postgres down')));
    const { warn, fire } = setup({
      participants: () => Promise.reject(new Error('redis down')),
      settleRun: failing,
    });
    await expect(
      fire({
        state: state(),
        runs: {
          close: { runId: RUN_OLD, reason: 'reset', closedAtMs: 1, elapsedAtCloseMs: 1 },
          open: { runId: RUN_NEW, openedAtMs: 1 },
        },
      }),
    ).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledTimes(2);
    });
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it('a settlement that hangs does not delay the change and is logged after the bound', async () => {
    const { warn, fire } = setup({ settleRun: () => new Promise(() => undefined) }, 30);
    await fire({
      state: state(),
      runs: { close: { runId: RUN_OLD, reason: 'reset', closedAtMs: 1, elapsedAtCloseMs: 1 } },
    });
    expect(warn).not.toHaveBeenCalled(); // fire() returned before the bound elapsed.
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ runId: RUN_OLD }),
        expect.stringContaining('reconciler finishes it'),
      );
    });
  });

  it('without a focus service the run effects are ignored', async () => {
    const { emitter, emitted } = recordingEmitter();
    const { logger } = fakeLogger();
    let listener: ((change: TimerChange) => void | Promise<void>) | undefined;
    attachTimerFollowUps(
      {
        onChange: (next) => {
          listener = next;
        },
      },
      { scheduler: {} as RoomTimerScheduler, emitter, logger },
    );
    await listener?.({
      roomId: ROOM,
      cause: 'command',
      nowMs: 1,
      state: state(),
      runs: { open: { runId: RUN_NEW, openedAtMs: 1 } },
    });
    expect(emitted.map((entry) => entry.event)).toEqual(['room:timer:state']);
  });
});

describe('focus announcers', () => {
  const attach = (participants: RoomFocusService['participants']) => {
    const { emitter, emitted } = recordingEmitter();
    const { logger, warn } = fakeLogger();
    let listener: ((change: RoomFocusChange) => void | Promise<void>) | undefined;
    attachFocusAnnouncers(
      {
        participants,
        onChange: (next) => {
          listener = next;
        },
      },
      emitter,
      logger,
    );
    return {
      emitted,
      warn,
      fire: async (change: RoomFocusChange) => {
        await listener?.(change);
      },
    };
  };

  it('sends the current participants to the room', async () => {
    const { emitted, fire } = attach(() =>
      Promise.resolve({
        focusRunId: RUN_NEW,
        participants: [participant()],
        participantsVersion: 7,
      }),
    );
    await fire({ kind: 'participants', roomId: ROOM });
    expect(emitted).toEqual([
      {
        room: `room:${ROOM}`,
        event: 'room:focus:participants',
        payload: {
          roomId: ROOM,
          focusRunId: RUN_NEW,
          participants: [participant()],
          participantsVersion: 7,
        },
      },
    ]);
  });

  it('sends a session change to every tab of its owner only', async () => {
    const { emitted, fire } = attach(() =>
      Promise.resolve({ focusRunId: null, participants: [], participantsVersion: 0 }),
    );
    const session = { id: 'session' } as unknown as Extract<
      RoomFocusChange,
      { kind: 'session' }
    >['session'];
    await fire({ kind: 'session', userId: USER, session });
    expect(emitted).toEqual([
      { room: `user:${USER}`, event: 'focus:session:updated', payload: { session } },
    ]);
  });

  it('logs a failed read and never throws', async () => {
    const { emitted, warn, fire } = attach(() => Promise.reject(new Error('redis down')));
    await expect(fire({ kind: 'participants', roomId: ROOM })).resolves.toBeUndefined();
    expect(emitted).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('presence hooks', () => {
  const port = () => {
    const left = vi.fn(() => Promise.resolve());
    const joined = vi.fn(() => Promise.resolve());
    const focus: RoomFocusPort = {
      userLeftRoom: left,
      userJoinedRoom: joined,
      snapshot: vi.fn(),
      depart: vi.fn(),
    };
    return { focus, left, joined };
  };

  it('passes room and user to the service and logs rejections', async () => {
    const { focus, left, joined } = port();
    left.mockRejectedValueOnce(new Error('postgres down'));
    const { logger, warn } = fakeLogger();
    const hooks = createPresenceHooks(focus, logger);
    hooks.userLeft([{ roomId: ROOM, userId: USER }]);
    hooks.userJoined({
      roomId: ROOM,
      userId: USER,
      socketId: 's',
      displayName: 'Ada',
      avatarUrl: null,
    });
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledTimes(1);
    });
    expect(left).toHaveBeenCalledWith(USER, ROOM);
    expect(joined).toHaveBeenCalledWith(USER, ROOM);
  });

  describe('through room presence', () => {
    const socket = {
      roomId: ROOM,
      userId: USER,
      socketId: 's1',
      displayName: 'Ada',
      avatarUrl: null,
    };

    const build = (store: Partial<RoomPresenceStore>) => {
      const hooks = { userLeft: vi.fn(), userJoined: vi.fn() };
      const { emitter } = recordingEmitter();
      const { logger } = fakeLogger();
      const presence = createRoomPresence({
        store: store as RoomPresenceStore,
        emitter,
        logger,
        hooks,
      });
      return { presence, hooks };
    };

    it('reports only the last socket leaving, not an earlier tab', async () => {
      const results = [false, true];
      const { presence, hooks } = build({
        leave: () => Promise.resolve({ last: results.shift() ?? false, removed: true, nowMs: 1 }),
      });
      await presence.leave(socket);
      expect(hooks.userLeft).not.toHaveBeenCalled();
      await presence.leave(socket);
      expect(hooks.userLeft).toHaveBeenCalledTimes(1);
    });

    it('reports an eviction, an instance removal and a sync that dropped the last socket', async () => {
      const { presence, hooks } = build({
        evictUser: () => Promise.resolve(true),
        removeInstance: () => Promise.resolve([{ roomId: ROOM, userId: USER }]),
        sync: () =>
          Promise.resolve({
            joined: [{ socket, first: true }],
            left: [{ roomId: ROOM, userId: USER }],
          }),
      });
      await presence.evict(ROOM, USER);
      await presence.removeInstance('dead');
      await presence.syncLocal(() => []);
      expect(hooks.userLeft).toHaveBeenCalledTimes(3);
      expect(hooks.userJoined).toHaveBeenCalledTimes(1);
    });

    it('does not report a user who was not present, nor anything after a Redis loss', async () => {
      const { presence, hooks } = build({
        evictUser: () => Promise.resolve(false),
        sync: () =>
          Promise.resolve({
            joined: [{ socket, first: true }],
            left: [{ roomId: ROOM, userId: USER }],
          }),
      });
      await presence.evict(ROOM, USER);
      await presence.syncLocal(() => [], { announce: false });
      expect(hooks.userLeft).not.toHaveBeenCalled();
      expect(hooks.userJoined).not.toHaveBeenCalled();
    });

    it('a second tab found by a sync is not reported as newly present', async () => {
      const { presence, hooks } = build({
        sync: () => Promise.resolve({ joined: [{ socket, first: false }], left: [] }),
      });
      await presence.syncLocal(() => []);
      expect(hooks.userJoined).not.toHaveBeenCalled();
    });
  });
});
