import {
  type AbandonReason,
  FOCUS_SESSION_PLANNED_SECONDS_MAX,
  FOCUS_SESSION_PLANNED_SECONDS_MIN,
} from '@focus-flow/contracts';

// Solo focus timing and transitions (docs/architecture/focus-timing-protocol.md, "Solo
// sessions"; D6, D14/15/35, E1, E7, E11, E14, E15). Pure: no database, Redis, queue,
// HTTP or socket code, and no clock of its own. Every instant is epoch milliseconds that
// the caller read from PostgreSQL (E9). Presence, the disconnect marker and the
// cross-clock policy are decided by the caller; only their result reaches this module
// (for example the disconnect instant a grace expiry uses).
//
// P = planned seconds, F = focused seconds (accumulated before the current running
// stretch), R = start of the current running stretch (null while paused or ended).

const MS_PER_SECOND = 1_000;

type SessionBase = {
  readonly plannedSeconds: number;
  readonly focusedSeconds: number;
  readonly startedAtMs: number;
};

export type RunningSession = SessionBase & {
  readonly status: 'in_progress';
  readonly runningSinceMs: number;
};

export type PausedSession = SessionBase & {
  readonly status: 'in_progress';
  readonly runningSinceMs: null;
};

export type InProgressSession = RunningSession | PausedSession;

export type CompletedSession = SessionBase & {
  readonly status: 'completed';
  readonly runningSinceMs: null;
  readonly endedAtMs: number;
};

export type AbandonedSession = SessionBase & {
  readonly status: 'abandoned';
  readonly runningSinceMs: null;
  readonly endedAtMs: number;
  readonly abandonReason: AbandonReason;
};

export type EndedSession = CompletedSession | AbandonedSession;

export type SoloSession = InProgressSession | EndedSession;

/**
 * - `changed`: the transition applied.
 * - `unchanged`: a harmless repeat (pause while paused, resume while running, anything
 *   on an ended session). The API answers 200 with the session as it is (E11).
 * - `rejected`: not allowed in this state (a paused session cannot complete or expire a
 *   grace; nothing completes before its planned end).
 */
export type TransitionRejection = 'not_running' | 'before_planned_end';

export type Transition =
  | { readonly outcome: 'changed'; readonly session: SoloSession }
  | { readonly outcome: 'unchanged'; readonly session: SoloSession }
  | {
      readonly outcome: 'rejected';
      readonly session: SoloSession;
      readonly reason: TransitionRejection;
    };

export const isRunning = (session: SoloSession): session is RunningSession =>
  session.status === 'in_progress' && session.runningSinceMs !== null;

export const isPaused = (session: SoloSession): session is PausedSession =>
  session.status === 'in_progress' && session.runningSinceMs === null;

export const isEnded = (session: SoloSession): session is EndedSession =>
  session.status !== 'in_progress';

/** Whole seconds from `fromMs` to `toMs`, rounded down (E14). Callers ensure `toMs ≥ fromMs`. */
const wholeSecondsBetween = (fromMs: number, toMs: number): number =>
  Math.floor((toMs - fromMs) / MS_PER_SECOND);

/**
 * Raised when `now` is earlier than the session's own latest timestamp — the database
 * clock stepped backwards between two transactions. Nothing is silently adjusted: the
 * only clamp the protocol allows is the grace-expiry disconnect instant (E9). The caller's
 * transaction fails and the operation is retried, so no stored value can show negative
 * time, `ended_at` before `started_at` or `running_since` before `started_at` (E15).
 */
export class SessionClockError extends RangeError {
  constructor(name: string, valueMs: number, earliestMs: number) {
    super(
      `${name} (${String(valueMs)}) is earlier than the session's latest timestamp (${String(earliestMs)})`,
    );
    this.name = 'SessionClockError';
  }
}

const assertFiniteInstant = (name: string, value: number): void => {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be a finite epoch-millisecond instant`);
  }
};

/** The session's latest stored instant: the current stretch's start, or `started_at`. */
const latestInstant = (session: InProgressSession): number =>
  session.runningSinceMs ?? session.startedAtMs;

/** `nowMs`, after checking it is a finite instant not earlier than the session's latest. */
const checkedNow = (session: InProgressSession, nowMs: number): number => {
  assertFiniteInstant('nowMs', nowMs);
  const earliestMs = latestInstant(session);
  if (nowMs < earliestMs) {
    throw new SessionClockError('nowMs', nowMs, earliestMs);
  }
  return nowMs;
};

const unchanged = (session: SoloSession): Transition => ({ outcome: 'unchanged', session });
const changed = (session: SoloSession): Transition => ({ outcome: 'changed', session });
const rejected = (session: SoloSession, reason: TransitionRejection): Transition => ({
  outcome: 'rejected',
  session,
  reason,
});

/** A new running session: `R = started_at = now`, `F = 0` (E1 bounds `plannedSeconds`). */
export const startSession = (plannedSeconds: number, nowMs: number): RunningSession => {
  if (
    !Number.isInteger(plannedSeconds) ||
    plannedSeconds < FOCUS_SESSION_PLANNED_SECONDS_MIN ||
    plannedSeconds > FOCUS_SESSION_PLANNED_SECONDS_MAX
  ) {
    throw new RangeError(
      `plannedSeconds must be an integer from ${String(FOCUS_SESSION_PLANNED_SECONDS_MIN)} to ${String(FOCUS_SESSION_PLANNED_SECONDS_MAX)}`,
    );
  }
  assertFiniteInstant('nowMs', nowMs);
  return {
    status: 'in_progress',
    plannedSeconds,
    focusedSeconds: 0,
    startedAtMs: nowMs,
    runningSinceMs: nowMs,
  };
};

/** `T_end = R + (P − F)`: when a running session reaches its planned time. */
export const plannedEndMs = (session: RunningSession): number =>
  session.runningSinceMs + (session.plannedSeconds - session.focusedSeconds) * MS_PER_SECOND;

/** Whether a running session has reached its planned end (E7: completion is decided first). */
export const hasReachedPlannedEnd = (session: RunningSession, nowMs: number): boolean =>
  nowMs >= plannedEndMs(session);

/**
 * `acc(now) = min(P, F + (R ? now − R : 0))`, in (fractional) seconds, for display and
 * decisions. Persisted values are always rounded down instead (E14).
 */
export const accumulatedSeconds = (session: SoloSession, nowMs: number): number => {
  if (!isRunning(session)) {
    return session.focusedSeconds;
  }
  const stretchSeconds = (checkedNow(session, nowMs) - session.runningSinceMs) / MS_PER_SECOND;
  return Math.min(session.plannedSeconds, session.focusedSeconds + stretchSeconds);
};

export const remainingSeconds = (session: SoloSession, nowMs: number): number =>
  session.plannedSeconds - accumulatedSeconds(session, nowMs);

/**
 * Running → paused: `F := min(P, F + ⌊now − R⌋)`, `R := null`. At or after `T_end` the
 * caller runs the completion decision first (E7); if that does not complete the session,
 * this pause applies with F capped at P.
 */
export const pause = (session: SoloSession, nowMs: number): Transition => {
  if (!isRunning(session)) {
    return unchanged(session);
  }
  const now = checkedNow(session, nowMs);
  return changed({
    status: 'in_progress',
    plannedSeconds: session.plannedSeconds,
    startedAtMs: session.startedAtMs,
    focusedSeconds: Math.min(
      session.plannedSeconds,
      session.focusedSeconds + wholeSecondsBetween(session.runningSinceMs, now),
    ),
    runningSinceMs: null,
  });
};

/** Paused → running: `R := now`. (The caller checks the user is connected.) */
export const resume = (session: SoloSession, nowMs: number): Transition => {
  if (!isPaused(session)) {
    return unchanged(session);
  }
  return changed({
    status: 'in_progress',
    plannedSeconds: session.plannedSeconds,
    startedAtMs: session.startedAtMs,
    focusedSeconds: session.focusedSeconds,
    runningSinceMs: checkedNow(session, nowMs),
  });
};

/**
 * Early stop → `abandoned(stopped)`: `F := min(P, F + ⌊now − R⌋)` (only while running),
 * `ended_at := now`. At or after `T_end` the caller runs the completion decision first
 * (E7).
 */
export const stop = (session: SoloSession, nowMs: number): Transition => {
  if (isEnded(session)) {
    return unchanged(session);
  }
  const now = checkedNow(session, nowMs);
  const stretch =
    session.runningSinceMs === null ? 0 : wholeSecondsBetween(session.runningSinceMs, now);
  return changed({
    status: 'abandoned',
    abandonReason: 'stopped',
    plannedSeconds: session.plannedSeconds,
    startedAtMs: session.startedAtMs,
    focusedSeconds: Math.min(session.plannedSeconds, session.focusedSeconds + stretch),
    runningSinceMs: null,
    endedAtMs: now,
  });
};

/**
 * Running and at or past `T_end` → `completed`: `F := P`, `ended_at := T_end`. Only the
 * server's decision procedure calls this, after it established presence (D14/15/35, E8);
 * a paused session cannot complete.
 */
export const complete = (session: SoloSession, nowMs: number): Transition => {
  if (isEnded(session)) {
    return unchanged(session);
  }
  if (!isRunning(session)) {
    return rejected(session, 'not_running');
  }
  if (!hasReachedPlannedEnd(session, nowMs)) {
    return rejected(session, 'before_planned_end');
  }
  return changed({
    status: 'completed',
    plannedSeconds: session.plannedSeconds,
    startedAtMs: session.startedAtMs,
    focusedSeconds: session.plannedSeconds,
    runningSinceMs: null,
    endedAtMs: plannedEndMs(session),
  });
};

/**
 * Running → `abandoned(grace_expired)`: `d := clamp(disconnectedAt, R, T_end)`,
 * `F := F + ⌊d − R⌋`, `ended_at := d`. `disconnectedAtMs` is the instant the caller
 * settled on (the marker's time); the clamp keeps every stored value within the stretch.
 */
export const expireGrace = (session: SoloSession, disconnectedAtMs: number): Transition => {
  if (isEnded(session)) {
    return unchanged(session);
  }
  if (!isRunning(session)) {
    return rejected(session, 'not_running');
  }
  assertFiniteInstant('disconnectedAtMs', disconnectedAtMs);
  const endMs = plannedEndMs(session);
  const disconnectedMs = Math.min(Math.max(disconnectedAtMs, session.runningSinceMs), endMs);
  return changed({
    status: 'abandoned',
    abandonReason: 'grace_expired',
    plannedSeconds: session.plannedSeconds,
    startedAtMs: session.startedAtMs,
    // d ≤ T_end, so this never exceeds P (the formula needs no extra cap).
    focusedSeconds:
      session.focusedSeconds + wholeSecondsBetween(session.runningSinceMs, disconnectedMs),
    runningSinceMs: null,
    endedAtMs: disconnectedMs,
  });
};

/**
 * In progress → `abandoned(expired)` (stale cleanup, E2, or a definite Redis loss during
 * the stretch, E9): F unchanged — the current running stretch is discarded —
 * `ended_at := now`.
 */
export const expire = (session: SoloSession, nowMs: number): Transition => {
  if (isEnded(session)) {
    return unchanged(session);
  }
  const now = checkedNow(session, nowMs);
  return changed({
    status: 'abandoned',
    abandonReason: 'expired',
    plannedSeconds: session.plannedSeconds,
    startedAtMs: session.startedAtMs,
    focusedSeconds: session.focusedSeconds,
    runningSinceMs: null,
    endedAtMs: now,
  });
};
