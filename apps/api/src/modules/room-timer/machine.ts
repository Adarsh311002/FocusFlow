import type { TimerCommand, TimerPhase, TimerView } from '@focus-flow/contracts';

import type {
  TimerMachine,
  TimerRejection,
  TimerSettings,
  TimerState,
  TimerTransition,
} from './types.js';

// The pure room timer machine (Phase 7; docs/architecture/focus-timing-protocol.md, "Room
// timer"). No I/O and no clock: `nowMs` is always Redis TIME, supplied by the caller. Every
// accepted change bumps `version` by exactly 1; a no-op (a repeated pause or resume) returns
// the same state object with `changed: false`.

const durationFor = (settings: TimerSettings, phase: TimerPhase): number => {
  switch (phase) {
    case 'focus':
      return settings.focusMs;
    case 'short_break':
      return settings.shortBreakMs;
    case 'long_break':
      return settings.longBreakMs;
  }
};

const nextPhaseAfter = (phase: TimerPhase): TimerPhase =>
  phase === 'focus' ? 'short_break' : 'focus';

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const reject = (rejection: TimerRejection): TimerTransition => ({ ok: false, rejection });

const accept = (state: TimerState): TimerTransition => ({ ok: true, state, changed: true });

const noop = (state: TimerState): TimerTransition => ({ ok: true, state, changed: false });

const invalid = (message: string): TimerTransition =>
  reject({ code: 'INVALID_TRANSITION', message });

const conflict = (): TimerTransition =>
  reject({ code: 'VERSION_CONFLICT', message: 'The timer changed since you last saw it' });

const idleIn = (phase: TimerPhase, settings: TimerSettings, version: number): TimerState => ({
  phase,
  status: 'idle',
  durationMs: durationFor(settings, phase),
  elapsedBeforeMs: 0,
  segmentStartedAtMs: null,
  version,
});

const elapsedMs = (state: TimerState, nowMs: number): number => {
  const duration = Math.max(0, state.durationMs);
  const before = clamp(state.elapsedBeforeMs, 0, duration);
  if (state.status !== 'running' || state.segmentStartedAtMs === null) return before;
  // A clock that went backwards counts as no progress, never as negative time.
  const stretch = Math.max(0, nowMs - state.segmentStartedAtMs);
  return clamp(before + stretch, 0, duration);
};

const endsAtMs = (state: TimerState): number | null => {
  if (state.status !== 'running' || state.segmentStartedAtMs === null) return null;
  return state.segmentStartedAtMs + state.durationMs - state.elapsedBeforeMs;
};

export const createTimerMachine = (): TimerMachine => {
  const initial: TimerMachine['initial'] = (settings, baseVersion, phase = 'focus') =>
    idleIn(phase, settings, baseVersion);

  const apply = (
    state: TimerState,
    command: TimerCommand,
    nowMs: number,
    settings: TimerSettings,
  ): TimerTransition => {
    const next = state.version + 1;
    switch (command.type) {
      case 'start':
        if (state.status !== 'idle') {
          return invalid(`Cannot start a timer that is ${state.status}`);
        }
        return accept({ ...state, status: 'running', segmentStartedAtMs: nowMs, version: next });
      case 'pause':
        if (state.status === 'paused') return noop(state);
        if (state.status === 'idle') return invalid('Cannot pause a timer that is idle');
        // A pause at or after zero would bump the version and turn the pending phase-end job
        // into a no-op, leaving a timer paused at zero that never advances on its own.
        if (nowMs >= (endsAtMs(state) ?? Infinity)) return invalid('The phase has just ended.');
        return accept({
          ...state,
          status: 'paused',
          elapsedBeforeMs: elapsedMs(state, nowMs),
          segmentStartedAtMs: null,
          version: next,
        });
      case 'resume':
        if (state.status === 'running') return noop(state);
        if (state.status === 'idle') return invalid('Cannot resume a timer that is idle');
        return accept({ ...state, status: 'running', segmentStartedAtMs: nowMs, version: next });
      case 'reset':
        if (command.expectedVersion !== state.version) return conflict();
        return accept(idleIn(state.phase, settings, next));
      case 'setPhase':
        if (command.expectedVersion !== state.version) return conflict();
        if (command.phase === state.phase) {
          return invalid(`The timer is already in the ${state.phase} phase`);
        }
        return accept(idleIn(command.phase, settings, next));
    }
  };

  const completePhase: TimerMachine['completePhase'] = (state, nowMs, settings) => {
    if (state.status !== 'running') {
      return invalid(`Cannot complete a phase of a timer that is ${state.status}`);
    }
    const endsAt = endsAtMs(state);
    if (endsAt === null) return invalid('A running timer without a start instant');
    if (nowMs < endsAt) {
      return reject({
        code: 'NOT_DUE',
        message: 'The phase has not reached zero yet',
        remainingMs: endsAt - nowMs,
      });
    }
    return accept(idleIn(nextPhaseAfter(state.phase), settings, state.version + 1));
  };

  const toView = (roomId: string, state: TimerState): TimerView => {
    const isRunning = state.status === 'running' && state.segmentStartedAtMs !== null;
    return {
      roomId: roomId as TimerView['roomId'],
      phase: state.phase,
      status: state.status,
      durationMs: state.durationMs,
      elapsedBeforeMs: state.elapsedBeforeMs,
      segmentStartedAtMs: isRunning ? state.segmentStartedAtMs : null,
      endsAtMs: isRunning ? endsAtMs(state) : null,
      version: state.version,
    };
  };

  return { initial, apply, completePhase, elapsedMs, endsAtMs, toView };
};

export const timerMachine: TimerMachine = createTimerMachine();
