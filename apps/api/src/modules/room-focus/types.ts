import type {
  AbandonReason,
  FocusSessionView,
  RoomFocusParticipant,
  RoomFocusSnapshot,
} from '@focus-flow/contracts';

// Shared types of room focus runs (Phase 8; RF1-RF16 in docs/decisions/decision-log.md,
// docs/architecture/focus-timing-protocol.md "Focus runs"). These interfaces are the contract
// between the workstreams: the pure model (model.ts), the Redis ledger (ledger.ts), the
// service (service.ts), the jobs/reconciler/recovery and the socket integration. Owned by
// the lead: change them only by agreement. Every instant is Redis TIME in milliseconds
// unless it is explicitly a PostgreSQL value.

// ---- The run ------------------------------------------------------------------------

/** Why a run closed. `completed` is the normal end of the focus phase (D17). */
export type RunCloseReason = 'reset' | 'phase_changed' | 'completed';

/** The run record in Redis (`ff:room:{roomId}:run:{runId}`). */
export type RunRecord = {
  readonly roomId: string;
  readonly runId: string;
  readonly status: 'open' | 'closed';
  readonly closeReason: RunCloseReason | null;
  readonly openedAtMs: number;
  /** Set when closed. */
  readonly closedAtMs: number | null;
  /** The timer's elapsed time at closure (`durationMs` for `completed`); set when closed. */
  readonly elapsedAtCloseMs: number | null;
};

/**
 * What a timer change does to runs, computed by the pure `planRun` and applied in the SAME
 * atomic Redis write as the timer (RF3). A change may close one run and open another
 * (reset in focus), only open (a break ends), only close (focus -> break), or neither.
 */
export type RunTransition = {
  readonly close?: {
    readonly runId: string;
    readonly reason: RunCloseReason;
    readonly closedAtMs: number;
    readonly elapsedAtCloseMs: number;
  };
  readonly open?: { readonly runId: string; readonly openedAtMs: number };
};

/** A person in a run's ledger (`ff:room:{roomId}:run:{runId}:participants`, field = userId). */
export type LedgerParticipant = {
  readonly userId: string;
  readonly sessionId: string;
  readonly optedInAtMs: number;
  /** The timer's elapsed time when the person opted in. */
  readonly elapsedAtOptInMs: number;
  /** Set while the person's last socket in the room is gone (D19). */
  readonly disconnectedAtMs: number | null;
  /** The timer's elapsed time at the disconnect (running or paused). */
  readonly elapsedAtDisconnectMs: number | null;
};

export type RunSnapshot = {
  /** `undefined`: no such run in Redis (never existed, settled and removed, or lost). */
  readonly run: RunRecord | undefined;
  readonly participants: readonly LedgerParticipant[];
  /**
   * The run's participant-list version (G2), read in the same `MULTI` as the participants, so
   * the pair is consistent. 0 for a run that has no changes yet or no record.
   */
  readonly participantsVersion: number;
  /** Redis TIME of the read. */
  readonly nowMs: number;
};

// ---- The pure model (model.ts; no I/O) ----------------------------------------------

/** How a session ends, decided by pure functions from ledger values. Instants are Redis TIME. */
export type Settlement =
  | { readonly kind: 'complete'; readonly endedAtMs: number }
  | {
      readonly kind: 'abandon';
      readonly reason: AbandonReason;
      /** Whole seconds, `0 <= x <= plannedSeconds`. */
      readonly focusedSeconds: number;
      readonly endedAtMs: number;
    }
  /** A disconnected participant of a run that ended normally: the grace decides. */
  | { readonly kind: 'wait_for_grace' };

// ---- The ledger (ledger.ts; Redis only) ---------------------------------------------

export type AddParticipantResult =
  | { readonly result: 'added' }
  /** Already in the ledger (a retry): the stored entry, so the caller can repair/return it. */
  | { readonly result: 'exists'; readonly participant: LedgerParticipant }
  /** The room's timer is no longer in this open focus run (or no run): nothing was written. */
  | { readonly result: 'run_changed' };

export type MarkDisconnectedResult =
  | 'marked'
  | 'already_disconnected'
  | 'not_participant'
  /** The timer version moved while the elapsed time was computed: read again. */
  | 'conflict'
  /** The run is closed (its settlement decides, not a disconnect). */
  | 'run_closed';

export type RunLedger = {
  /** Reads the run, its participants and Redis TIME in one `MULTI`. */
  readonly read: (roomId: string, runId: string) => Promise<RunSnapshot>;
  /**
   * One small atomic script (no business rules): adds the participant only if the room's
   * timer is still in phase `focus` with `focusRunId === runId`, and the run is `open`.
   * `HSETNX`: an existing entry is returned, never replaced.
   */
  readonly addParticipant: (
    roomId: string,
    runId: string,
    participant: LedgerParticipant,
  ) => Promise<AddParticipantResult>;
  /**
   * Removes the participant only if the stored entry belongs to `sessionId` (compare-and-delete,
   * so a late cleanup never removes the entry of the user's next session); whether it removed.
   * Idempotent.
   */
  readonly removeParticipant: (
    roomId: string,
    runId: string,
    userId: string,
    sessionId: string,
  ) => Promise<boolean>;
  /**
   * Records the disconnect only if the participant exists, is connected, the run is open and
   * the timer's version still equals `timerVersion` (the version the elapsed time came from).
   */
  readonly markDisconnected: (
    roomId: string,
    runId: string,
    userId: string,
    disconnect: {
      readonly disconnectedAtMs: number;
      readonly elapsedAtDisconnectMs: number;
      readonly timerVersion: number;
    },
  ) => Promise<MarkDisconnectedResult>;
  /**
   * Clears the disconnect fields only if they still hold exactly `expectedDisconnectedAtMs`.
   * Whether it cleared.
   */
  readonly clearDisconnected: (
    roomId: string,
    runId: string,
    userId: string,
    expectedDisconnectedAtMs: number,
  ) => Promise<boolean>;
  /** Closed, unsettled runs oldest first (`ff:rooms:runs:unsettled`, scored by `closedAtMs`). */
  readonly unsettled: (
    limit: number,
  ) => Promise<readonly { readonly roomId: string; readonly runId: string }[]>;
  /**
   * Deletes a CLOSED run's record and participants and removes it from the unsettled set,
   * only if no participant is left. Whether it deleted. Idempotent. Never touches an open run.
   */
  readonly finishRun: (roomId: string, runId: string) => Promise<boolean>;
};

// ---- The service (service.ts; PostgreSQL + ledger + timer) -----------------------------

/** Why a participant's session ended because they went away on purpose (RF8). */
export type DepartureReason = Extract<AbandonReason, 'opted_out' | 'left_room' | 'removed'>;

/** A committed change to the participant list or to a session, for the announcers. */
export type RoomFocusChange =
  | { readonly kind: 'participants'; readonly roomId: string }
  | { readonly kind: 'session'; readonly userId: string; readonly session: FocusSessionView };

export type RoomFocusService = {
  /** `POST /rooms/:roomId/focus-participation`. Throws `AppError` (RUN_CHANGED, RUN_ENDING, NOT_PRESENT, NOT_FOCUS_PHASE, SESSION_IN_PROGRESS, TASK_NOT_FOUND, TASK_NOT_OPEN, ROOM_NOT_FOUND, 503). */
  readonly optIn: (
    userId: string,
    roomId: string,
    taskId: string | undefined,
  ) => Promise<{ readonly session: FocusSessionView; readonly created: boolean }>;
  /** `DELETE /rooms/:roomId/focus-participation`: the ended session; throws ROOM_NOT_FOUND for non-members. Idempotent. */
  readonly optOut: (
    userId: string,
    roomId: string,
  ) => Promise<{ readonly session: FocusSessionView | null }>;
  /** `GET /rooms/:roomId/focus-participation` (members only). */
  readonly state: (
    userId: string,
    roomId: string,
  ) => Promise<RoomFocusSnapshot & { readonly session: FocusSessionView | null }>;
  /** The snapshot part of `room:join` (profiles from PostgreSQL, `connected` from the ledger). */
  readonly snapshot: (userId: string, roomId: string) => Promise<RoomFocusSnapshot>;
  /** The list that `room:focus:participants` carries for the room's current run. */
  readonly participants: (roomId: string) => Promise<{
    readonly focusRunId: string | null;
    readonly participants: RoomFocusParticipant[];
    /** 0 outside a focus phase. */
    readonly participantsVersion: number;
  }>;
  /**
   * The person went away on purpose (`left_room` or `removed`), or opted out: PostgreSQL
   * abandon first, then the ledger, then announcements. Idempotent; no participation -> no-op.
   * `removed` is also run inside the membership-deleting transaction by the rooms module
   * through `abandonInTransaction` (RF8).
   */
  readonly depart: (userId: string, roomId: string, reason: DepartureReason) => Promise<void>;
  /**
   * The person's last socket left the room (a hint, H2): re-checks room presence, then records
   * the disconnect (RF9) and ensures the 60 s grace job. No participation or still present -> no-op.
   * `detectedAtMs` is set for missed/instance-dead detection (late grace).
   */
  readonly userLeftRoom: (userId: string, roomId: string) => Promise<void>;
  /** The person is in the room again (`room:join`): reconnect within grace (RF9). */
  readonly userJoinedRoom: (userId: string, roomId: string) => Promise<void>;
  /** The grace job's / reconciler's decision for one disconnect (stale -> no-op). */
  readonly graceExpired: (
    roomId: string,
    runId: string,
    userId: string,
    disconnectedAtMs: number,
  ) => Promise<'abandoned' | 'reconnected' | 'completed' | 'stale'>;
  /** Settles a closed run: every participant per `Settlement`, then `finishRun` (idempotent). */
  readonly settleRun: (
    roomId: string,
    runId: string,
  ) => Promise<'settled' | 'pending_grace' | 'gone'>;
  /** Registers a listener called after every committed change; failures are logged, never thrown. */
  readonly onChange: (listener: (change: RoomFocusChange) => void | Promise<void>) => void;
};

// ---- Boundaries other modules implement ------------------------------------------

/**
 * Schedules the participant's grace job (BullMQ `focus-session` queue, `room-grace`,
 * id = `roomGraceJobId`, delay 60 s - elapsed since the disconnect, E20 ensure semantics).
 */
export type RoomGraceScheduler = {
  readonly ensureGrace: (
    job: {
      readonly roomId: string;
      readonly focusRunId: string;
      readonly userId: string;
      readonly disconnectedAtMs: number;
    },
    delayMs: number,
  ) => Promise<void>;
};

/** Whether the person has a live socket in the room right now (room presence, Redis). */
export type RoomPresenceCheck = (roomId: string, userId: string) => Promise<boolean>;

/** 60 seconds (D19). */
export const ROOM_GRACE_MS = 60_000;

/** An orphan room session (no ledger entry) is abandoned `timer_lost` after this long (RF10). */
export const ORPHAN_RECOVERY_MS = 120_000;

/**
 * RF17: a room session still in progress this long after `started_at` is expired by the
 * reconciler, unless its own run is still running. 12 hours, like the solo window (E2).
 */
export const ROOM_STALE_AFTER_MS = 12 * 60 * 60 * 1_000;

/** RF17: the absolute maximum: past this age even a running or closed-unsettled run expires. */
export const ROOM_STALE_HARD_MAX_MS = 16 * 60 * 60 * 1_000;

/** The shortest focus window that may be joined: `planned_seconds >= 60` (RF4). */
export const MIN_JOINABLE_PLANNED_SECONDS = 60;
