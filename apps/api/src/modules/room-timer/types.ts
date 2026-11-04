import type { TimerCommand, TimerPhase, TimerStatus, TimerView } from '@focus-flow/contracts';

// Shared types of the room timer (Phase 7; RT1-RT13 in docs/decisions/decision-log.md). The
// interfaces here are the contract between the pure machine (machine.ts), the Redis store
// (store.ts), the service (service.ts) and the scheduling/realtime layer (jobs.ts and the
// room-realtime handlers). Owned by the lead: change them only by agreement.

/** Durable timer state in Redis (`ff:room:{roomId}:timer`). All instants are Redis TIME ms. */
export type TimerState = {
  readonly phase: TimerPhase;
  readonly status: TimerStatus;
  /** Fixed from the room's settings when the phase was created (D16). */
  readonly durationMs: number;
  /** Time elapsed before the current running stretch; `0 ≤ elapsedBeforeMs ≤ durationMs`. */
  readonly elapsedBeforeMs: number;
  /** Set only while `running`. */
  readonly segmentStartedAtMs: number | null;
  /** Incremented by exactly 1 on every accepted change (RT2: a new timer starts at the Redis TIME base in milliseconds). */
  readonly version: number;
};

/** The room's saved phase durations, in milliseconds (the room row stores seconds). */
export type TimerSettings = {
  readonly focusMs: number;
  readonly shortBreakMs: number;
  readonly longBreakMs: number;
};

export type TimerRejection =
  /** The command is not allowed from the current phase/status. */
  | { readonly code: 'INVALID_TRANSITION'; readonly message: string }
  /** `expectedVersion` differs from the state's version. */
  | { readonly code: 'VERSION_CONFLICT'; readonly message: string }
  /** `completePhase` was called but the running phase has not reached zero yet. */
  | { readonly code: 'NOT_DUE'; readonly message: string; readonly remainingMs: number };

export type TimerTransition =
  | {
      readonly ok: true;
      readonly state: TimerState;
      /** False for a repeated pause/resume: nothing to write, the version is unchanged. */
      readonly changed: boolean;
    }
  | { readonly ok: false; readonly rejection: TimerRejection };

/**
 * The pure timer machine (machine.ts). No I/O, no clock: `nowMs` is always Redis TIME.
 * Every function is total over valid states and never returns a state with
 * `elapsedBeforeMs > durationMs` or a decreasing version.
 */
export type TimerMachine = {
  /** A new idle timer in `phase` (default focus), `version = baseVersion` (RT2). */
  readonly initial: (
    settings: TimerSettings,
    baseVersion: number,
    phase?: TimerPhase,
  ) => TimerState;
  /** Applies a host command (start/pause/resume/reset/setPhase) at `nowMs`. */
  readonly apply: (
    state: TimerState,
    command: TimerCommand,
    nowMs: number,
    settings: TimerSettings,
  ) => TimerTransition;
  /**
   * The automatic phase end: valid only for a `running` timer with `endsAtMs ≤ nowMs`.
   * Result: `idle` in the next phase (focus → short_break, any break → focus; D32: never
   * started automatically), duration from `settings`, version + 1.
   */
  readonly completePhase: (
    state: TimerState,
    nowMs: number,
    settings: TimerSettings,
  ) => TimerTransition;
  /** Elapsed time at `nowMs`, clamped to `[0, durationMs]`. */
  readonly elapsedMs: (state: TimerState, nowMs: number) => number;
  /** Running only: `segmentStartedAtMs + durationMs − elapsedBeforeMs`; otherwise null. */
  readonly endsAtMs: (state: TimerState) => number | null;
  readonly toView: (roomId: string, state: TimerState) => TimerView;
};

/** One timer read: the state (absent if the key does not exist) and Redis TIME, together. */
export type TimerRead = { readonly state: TimerState | undefined; readonly nowMs: number };

/** Redis access for the timer (store.ts). */
export type RoomTimerStore = {
  /** Reads the hash and Redis TIME in one `MULTI`. */
  readonly read: (roomId: string) => Promise<TimerRead>;
  /**
   * Atomic version-checked write (small Lua, no business logic): succeeds only if the stored
   * version equals `expectedVersion` (`null` = the key must not exist). Writes the hash and
   * keeps `ff:rooms:timers:running` equal to the state (member added with `endsAtMs` while
   * `running`, removed otherwise) in the same operation.
   */
  readonly write: (
    roomId: string,
    expectedVersion: number | null,
    next: TimerState,
  ) => Promise<'ok' | 'conflict'>;
  /**
   * Removes `roomId` from the running index when its hash is absent or not running (one small
   * Lua: check then ZREM). Never touches a running timer. Returns whether a member was removed.
   */
  readonly forget: (roomId: string) => Promise<boolean>;
  /** Running timers whose `endsAtMs ≤ nowMs`, oldest first, at most `limit`. */
  readonly due: (nowMs: number, limit: number) => Promise<readonly string[]>;
  /** Running timers as `{ roomId, endsAtMs }`, paged by `offset`. */
  readonly running: (
    offset: number,
    limit: number,
  ) => Promise<readonly { readonly roomId: string; readonly endsAtMs: number }[]>;
};

/** Why a committed change happened (the reason `onChange` listeners receive). */
export type TimerChangeCause = 'created' | 'command' | 'phase_end';

export type TimerChange = {
  readonly roomId: string;
  readonly cause: TimerChangeCause;
  readonly state: TimerState;
  /** Redis TIME at which the change was computed. */
  readonly nowMs: number;
};

export type CommandOutcome =
  | { readonly ok: true; readonly state: TimerState; readonly nowMs: number }
  | {
      readonly ok: false;
      readonly code: 'ROOM_NOT_FOUND' | 'INVALID_TRANSITION' | 'VERSION_CONFLICT';
      readonly message: string;
      /** The current state, for INVALID_TRANSITION and VERSION_CONFLICT. */
      readonly state?: TimerState;
      readonly nowMs?: number;
    };

export type PhaseEndOutcome =
  /** The job's version is not current, or the timer is not running: nothing to do. */
  | { readonly result: 'noop' }
  /** Not due yet (the job fired early or the clock disagrees): run again after `delayMs`. */
  | { readonly result: 'early'; readonly delayMs: number }
  | { readonly result: 'advanced'; readonly state: TimerState; readonly nowMs: number };

/** The timer use cases (service.ts). The caller has already authorised the host. */
export type RoomTimerService = {
  /** The current timer; creates it (idle focus from saved settings) when absent (RT1). */
  readonly get: (roomId: string) => Promise<{ state: TimerState; nowMs: number } | undefined>;
  /** Applies a host command with a bounded retry on write conflicts (RT7). */
  readonly command: (roomId: string, command: TimerCommand) => Promise<CommandOutcome>;
  /** The phase-end job's use case: re-reads, re-evaluates, writes (never trusts the job). */
  readonly completePhase: (roomId: string, jobVersion: number) => Promise<PhaseEndOutcome>;
  /**
   * Registers a listener called after every committed change (created, command, phase
   * end), never before the write. A throwing listener is logged and never fails the change.
   */
  readonly onChange: (listener: (change: TimerChange) => void | Promise<void>) => void;
};
