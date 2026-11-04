import type { TimerCommand } from '@focus-flow/contracts';
import type { Logger } from 'pino';

import { timerMachine } from './machine.js';
import type { ReadTimerSettings } from './settings.js';
import type {
  CommandOutcome,
  PhaseEndOutcome,
  RoomTimerService,
  RoomTimerStore,
  TimerChange,
  TimerMachine,
  TimerRead,
  TimerSettings,
  TimerState,
} from './types.js';

// The room timer use cases (RT1, RT2, RT7, RT13). Every change is the same loop: read the
// state and Redis TIME together, compute with the pure machine, write with the version
// check, and on a conflict read again and re-evaluate (a bounded number of times). Listeners
// run after the write and never affect the outcome.

/** Write attempts per operation (RT7). */
const MAX_ATTEMPTS = 3;

export type RoomTimerServiceDeps = {
  readonly store: RoomTimerStore;
  readonly readSettings: ReadTimerSettings;
  readonly logger: Logger;
  readonly machine?: TimerMachine;
};

type Current = { readonly state: TimerState; readonly nowMs: number };

export const createRoomTimerService = ({
  store,
  readSettings,
  logger,
  machine = timerMachine,
}: RoomTimerServiceDeps): RoomTimerService => {
  const listeners: ((change: TimerChange) => void | Promise<void>)[] = [];

  const notify = async (change: TimerChange): Promise<void> => {
    for (const listener of listeners) {
      try {
        await listener(change);
      } catch (error) {
        logger.error(
          { err: error, roomId: change.roomId, cause: change.cause },
          'timer listener failed',
        );
      }
    }
  };

  /**
   * The timer, created when absent (RT1). `undefined`: no such room. Creating is a write from
   * "absent": of several concurrent callers exactly one succeeds and announces `created`,
   * the others read what it wrote.
   */
  const materialise = async (roomId: string): Promise<Current | undefined> => {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const read: TimerRead = await store.read(roomId);
      if (read.state !== undefined) {
        return { state: read.state, nowMs: read.nowMs };
      }
      const settings = await readSettings(roomId);
      if (settings === undefined) {
        return undefined;
      }
      // RT2: the version base is Redis TIME in milliseconds, so a recreated timer's version
      // exceeds any version a client or an old job holds.
      const state = machine.initial(settings, read.nowMs);
      if ((await store.write(roomId, null, state)) === 'ok') {
        await notify({ roomId, cause: 'created', state, nowMs: read.nowMs });
        return { state, nowMs: read.nowMs };
      }
    }
    throw new Error(`the timer of room ${roomId} could not be created`);
  };

  const get: RoomTimerService['get'] = (roomId) => materialise(roomId);

  const command = async (roomId: string, timerCommand: TimerCommand): Promise<CommandOutcome> => {
    const settings: TimerSettings | undefined = await readSettings(roomId);
    if (settings === undefined) {
      return { ok: false, code: 'ROOM_NOT_FOUND', message: 'The room does not exist.' };
    }
    let last: Current | undefined;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const read = await store.read(roomId);
      let current: Current;
      if (read.state === undefined) {
        const created = await materialise(roomId);
        if (created === undefined) {
          return { ok: false, code: 'ROOM_NOT_FOUND', message: 'The room does not exist.' };
        }
        current = created;
      } else {
        current = { state: read.state, nowMs: read.nowMs };
      }
      last = current;

      const transition = machine.apply(current.state, timerCommand, current.nowMs, settings);
      if (!transition.ok) {
        return {
          ok: false,
          code:
            transition.rejection.code === 'VERSION_CONFLICT'
              ? 'VERSION_CONFLICT'
              : 'INVALID_TRANSITION',
          message: transition.rejection.message,
          state: current.state,
          nowMs: current.nowMs,
        };
      }
      if (!transition.changed) {
        return { ok: true, state: current.state, nowMs: current.nowMs };
      }
      if ((await store.write(roomId, current.state.version, transition.state)) === 'ok') {
        await notify({ roomId, cause: 'command', state: transition.state, nowMs: current.nowMs });
        return { ok: true, state: transition.state, nowMs: current.nowMs };
      }
    }
    // Every attempt lost a race: report the latest state so the caller can decide again.
    const latest = (await store.read(roomId)).state ?? last?.state;
    const nowMs = last?.nowMs;
    return {
      ok: false,
      code: 'VERSION_CONFLICT',
      message: 'The timer kept changing; try again.',
      ...(latest === undefined ? {} : { state: latest }),
      ...(nowMs === undefined ? {} : { nowMs }),
    };
  };

  const completePhase = async (roomId: string, jobVersion: number): Promise<PhaseEndOutcome> => {
    let settings: TimerSettings | undefined;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const read = await store.read(roomId);
      const state = read.state;
      if (state === undefined || state.version !== jobVersion || state.status !== 'running') {
        return { result: 'noop' };
      }
      settings ??= await readSettings(roomId);
      if (settings === undefined) {
        logger.warn({ roomId }, 'timer phase end for a room that no longer exists');
        return { result: 'noop' };
      }
      const transition = machine.completePhase(state, read.nowMs, settings);
      if (!transition.ok) {
        if (transition.rejection.code === 'NOT_DUE') {
          return { result: 'early', delayMs: Math.max(1, transition.rejection.remainingMs) };
        }
        logger.warn({ roomId, code: transition.rejection.code }, 'timer phase end rejected');
        return { result: 'noop' };
      }
      if (!transition.changed) {
        return { result: 'noop' };
      }
      if ((await store.write(roomId, state.version, transition.state)) === 'ok') {
        await notify({ roomId, cause: 'phase_end', state: transition.state, nowMs: read.nowMs });
        return { result: 'advanced', state: transition.state, nowMs: read.nowMs };
      }
    }
    // Three lost races: the next retry of the job (or the reconciler) decides again.
    throw new Error(`the phase end of room ${roomId} kept conflicting`);
  };

  return {
    get,
    command,
    completePhase,
    onChange: (listener) => {
      listeners.push(listener);
    },
  };
};
