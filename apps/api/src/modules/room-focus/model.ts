import type { TimerCommand } from '@focus-flow/contracts';

import { timerMachine } from '../room-timer/machine.js';
import type { TimerState } from '../room-timer/types.js';
import {
  type LedgerParticipant,
  MIN_JOINABLE_PLANNED_SECONDS,
  ROOM_GRACE_MS,
  type RunRecord,
  type RunTransition,
  type Settlement,
} from './types.js';

// The pure model of room focus runs (Phase 8; RF2-RF9, docs/architecture/focus-timing-protocol.md
// "Focus runs"). No I/O and no clock: every instant is Redis TIME in milliseconds, supplied by
// the caller. All values are rounded DOWN to whole seconds and clamped into
// `[0, plannedSeconds]` (RF5): the model never invents time it cannot prove.

/** The longest planned focus window (mirrors the solo bound E1 and the PostgreSQL CHECK). */
const MAX_PLANNED_SECONDS = 14_400;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

// ---- Planned and focused seconds -----------------------------------------------------

/**
 * `planned_seconds` for a person who opts in when the phase has `elapsedMs` behind it:
 * the time left, rounded to whole seconds. Not joinable when it falls outside the CHECK
 * bounds of `focus_sessions.planned_seconds` (below 60 -> `RUN_ENDING`).
 */
export const plannedSecondsAtOptIn = (
  durationMs: number,
  elapsedMs: number,
): { ok: true; plannedSeconds: number } | { ok: false } => {
  const plannedSeconds = Math.round((durationMs - elapsedMs) / 1000);
  if (
    !Number.isFinite(plannedSeconds) ||
    plannedSeconds < MIN_JOINABLE_PLANNED_SECONDS ||
    plannedSeconds > MAX_PLANNED_SECONDS
  ) {
    return { ok: false };
  }
  return { ok: true, plannedSeconds };
};

/**
 * Whole focused seconds between two timer-elapsed readings: floored, never negative (a
 * disconnect "before" the opt-in elapsed counts as 0) and never above `plannedSeconds`.
 */
export const focusedSecondsBetween = (
  fromElapsedMs: number,
  toElapsedMs: number,
  plannedSeconds: number,
): number => {
  const seconds = Math.floor((toElapsedMs - fromElapsedMs) / 1000);
  if (!Number.isFinite(seconds)) return 0;
  return clamp(seconds, 0, Math.max(0, plannedSeconds));
};

// ---- Settlements -----------------------------------------------------------------------

const abandon = (
  reason: Extract<Settlement, { kind: 'abandon' }>['reason'],
  focusedSeconds: number,
  endedAtMs: number,
): Settlement => ({ kind: 'abandon', reason, focusedSeconds, endedAtMs });

/** How long the person has been gone; `Infinity`-free, `0` for a clock that went backwards. */
const disconnectedFor = (disconnectedAtMs: number, nowMs: number): number =>
  Math.max(0, nowMs - disconnectedAtMs);

/**
 * The 60 s grace ran out (D19): abandoned `grace_expired`, counted up to the disconnect
 * (`elapsedAtDisconnect - elapsedAtOptIn`), ended at the disconnect instant. The participant
 * must be disconnected: a connected one is a caller bug.
 */
export const settlementForGraceExpiry = (
  p: LedgerParticipant,
  plannedSeconds: number,
): Settlement => {
  if (p.disconnectedAtMs === null) {
    throw new RangeError('settlementForGraceExpiry needs a disconnected participant');
  }
  return abandon(
    'grace_expired',
    focusedSecondsBetween(
      p.elapsedAtOptInMs,
      p.elapsedAtDisconnectMs ?? p.elapsedAtOptInMs,
      plannedSeconds,
    ),
    p.disconnectedAtMs,
  );
};

/**
 * Whether the person was present through the true end of a run that completed (G3, D35).
 * `planRun` stores the TRUE end of the phase as `closedAtMs` for a completed run (the phase-end
 * job may run late), so a disconnect recorded at or after it, in the ledger of the still-open
 * run, happened after the phase was already over: the person was present at the end. Both
 * instants are Redis TIME, so no skew tolerance is needed. A disconnect strictly before the
 * true end keeps the grace path (D19).
 */
export const wasPresentThroughEnd = (p: LedgerParticipant, run: RunRecord): boolean =>
  run.status === 'closed' &&
  run.closeReason === 'completed' &&
  (p.disconnectedAtMs === null ||
    (run.closedAtMs !== null && p.disconnectedAtMs >= run.closedAtMs));

/**
 * The true end of the phase when the participant was present at it although the run is still
 * OPEN (G3, the delayed phase-end job): the timer still runs this run, its end has passed, and
 * the disconnect (Redis TIME) was recorded at or after that end. `null` otherwise: a paused,
 * idle, replaced or missing timer has no pending end, and a disconnect strictly before the end
 * keeps the grace path (D19). The caller reads the timer BEFORE the ledger, so a run closed in
 * between shows up as closed and takes the closed-run path.
 */
export const pendingEndAtMs = (
  p: LedgerParticipant,
  runId: string,
  timer: TimerState | undefined,
): number | null => {
  if (p.disconnectedAtMs === null || timer === undefined) return null;
  if (timer.phase !== 'focus' || timer.focusRunId !== runId) return null;
  const endsAtMs = timerMachine.endsAtMs(timer);
  return endsAtMs !== null && p.disconnectedAtMs >= endsAtMs ? endsAtMs : null;
};

/**
 * Settlement of one participant of a CLOSED run (RF9, protocol table).
 * - `reset` / `phase_changed`: abandoned with that reason; counted to the disconnect if the
 *   person was gone, else to the close; ended at the close.
 * - `completed`: connected -> completed; disconnected -> waits while the grace runs, then
 *   `grace_expired` (D14/D15/D35).
 */
export const settlementForClosedRun = (
  p: LedgerParticipant,
  run: RunRecord,
  plannedSeconds: number,
  nowMs: number,
): Settlement => {
  if (run.status !== 'closed' || run.closeReason === null) {
    throw new RangeError('settlementForClosedRun needs a closed run with a reason');
  }
  const closedAtMs = run.closedAtMs ?? nowMs;
  const elapsedAtCloseMs = run.elapsedAtCloseMs ?? p.elapsedAtOptInMs;
  if (run.closeReason === 'reset' || run.closeReason === 'phase_changed') {
    const countedUntilMs =
      p.disconnectedAtMs !== null
        ? (p.elapsedAtDisconnectMs ?? elapsedAtCloseMs)
        : elapsedAtCloseMs;
    return abandon(
      run.closeReason,
      focusedSecondsBetween(p.elapsedAtOptInMs, countedUntilMs, plannedSeconds),
      closedAtMs,
    );
  }
  if (p.disconnectedAtMs === null || wasPresentThroughEnd(p, run)) {
    return { kind: 'complete', endedAtMs: closedAtMs };
  }
  if (disconnectedFor(p.disconnectedAtMs, nowMs) < ROOM_GRACE_MS) return { kind: 'wait_for_grace' };
  return settlementForGraceExpiry(p, plannedSeconds);
};

/**
 * The person went away on purpose (RF8): counted up to now, ended now. A departure is always
 * "now"; a recorded disconnect is not used.
 */
export const settlementForDeparture = (
  reason: 'opted_out' | 'left_room' | 'removed',
  p: LedgerParticipant,
  elapsedNowMs: number,
  nowMs: number,
  plannedSeconds: number,
): Settlement =>
  abandon(reason, focusedSecondsBetween(p.elapsedAtOptInMs, elapsedNowMs, plannedSeconds), nowMs);

/**
 * The person is back after their run closed normally (`completed`): completed if they were
 * gone for at most the grace, else the grace had already expired.
 */
export const settlementForReconnectAfterClose = (
  p: LedgerParticipant,
  run: RunRecord,
  reconnectedAtMs: number,
  plannedSeconds: number,
): Settlement => {
  if (p.disconnectedAtMs === null || wasPresentThroughEnd(p, run)) {
    return { kind: 'complete', endedAtMs: run.closedAtMs ?? reconnectedAtMs };
  }
  if (disconnectedFor(p.disconnectedAtMs, reconnectedAtMs) <= ROOM_GRACE_MS) {
    return { kind: 'complete', endedAtMs: run.closedAtMs ?? reconnectedAtMs };
  }
  return settlementForGraceExpiry(p, plannedSeconds);
};

/**
 * A session that outlived the stale window (RF17): abandoned `expired`, counted up to
 * `elapsedEndMs` (the timer's elapsed time now, or frozen at the run's close) but never past
 * the person's recorded disconnect. Without a ledger entry nothing can be proven: 0 seconds.
 */
export const settlementForStale = (
  p: LedgerParticipant | undefined,
  elapsedEndMs: number,
  nowMs: number,
  plannedSeconds: number,
): Settlement => {
  if (p === undefined) return abandon('expired', 0, nowMs);
  const untilMs =
    p.disconnectedAtMs !== null && p.elapsedAtDisconnectMs !== null
      ? Math.min(elapsedEndMs, p.elapsedAtDisconnectMs)
      : elapsedEndMs;
  return abandon(
    'expired',
    focusedSecondsBetween(p.elapsedAtOptInMs, untilMs, plannedSeconds),
    nowMs,
  );
};

/** Redis lost the timer or run (RF10, D37 default): nothing can be proven, so 0 focused seconds. */
export const settlementForTimerLost = (nowMs: number): Settlement =>
  abandon('timer_lost', 0, nowMs);

/** Grace left for a person: the full grace while connected, `0` once over; always in `[0, 60 s]`. */
export const graceRemainingMs = (p: LedgerParticipant, nowMs: number): number => {
  if (p.disconnectedAtMs === null) return ROOM_GRACE_MS;
  return clamp(ROOM_GRACE_MS - disconnectedFor(p.disconnectedAtMs, nowMs), 0, ROOM_GRACE_MS);
};

// ---- Planning runs ---------------------------------------------------------------------

/**
 * What a timer change does to runs (RF2, RF3), computed from the machine's result:
 * - closes `prev.focusRunId` when `prev` is a focus phase and the change is a `reset`
 *   (`reset`), a `setPhase` away from focus (`phase_changed`) or a phase end (`completed`,
 *   `elapsedAtCloseMs = durationMs`); for reset/setPhase the elapsed time at the close is the
 *   timer's elapsed time at `nowMs`;
 * - opens `newRunId` whenever `next` is a focus phase that the change created (created,
 *   reset in focus, setPhase to focus, a break ending), or when a focus timer has no run
 *   (a timer written before Phase 8);
 * - start/pause/resume keep the run;
 * - `state.focusRunId` is the run of `next`, `null` in a break.
 * At most one run is closed and at most one opened.
 */
export const planRun = (
  prev: TimerState | undefined,
  next: TimerState,
  cause: 'created' | 'command' | 'phase_end',
  command: TimerCommand | undefined,
  nowMs: number,
  newRunId: string,
): { state: TimerState; runs: RunTransition | undefined } => {
  const none = (state: TimerState) => ({ state, runs: undefined });
  const openNew = (close: RunTransition['close']) => ({
    state: { ...next, focusRunId: newRunId },
    runs: { ...(close ? { close } : {}), open: { runId: newRunId, openedAtMs: nowMs } },
  });

  if (prev === undefined || cause === 'created') {
    return next.phase === 'focus' ? openNew(undefined) : none({ ...next, focusRunId: null });
  }

  const changesRun =
    cause === 'phase_end' || command?.type === 'reset' || command?.type === 'setPhase';

  if (!changesRun) {
    // start / pause / resume (or a command-less pass-through): the run is unchanged.
    if (next.phase === 'focus' && prev.focusRunId === null) return openNew(undefined);
    return none({ ...next, focusRunId: next.phase === 'focus' ? prev.focusRunId : null });
  }

  let close: RunTransition['close'];
  if (prev.phase === 'focus' && prev.focusRunId !== null) {
    const endsAtMs = timerMachine.endsAtMs(prev);
    if (cause === 'phase_end' || (endsAtMs !== null && nowMs >= endsAtMs)) {
      // The phase is over: a phase end, or a reset / phase change that reached a timer whose
      // phase-end job has not run yet. The run was completed, so the people present at the end
      // completed it (D35); the host's command must not turn it into a reset (Rev J3).
      // `closedAtMs` is the TRUE end of the phase, never the (possibly late) job or command
      // time: a disconnect between the true end and this write happened after the end and must
      // not be judged as an interruption (G3, `wasPresentThroughEnd`).
      close = {
        runId: prev.focusRunId,
        reason: 'completed',
        closedAtMs: endsAtMs === null ? nowMs : Math.min(nowMs, endsAtMs),
        elapsedAtCloseMs: prev.durationMs,
      };
    } else if (command?.type === 'reset') {
      close = {
        runId: prev.focusRunId,
        reason: 'reset',
        closedAtMs: nowMs,
        elapsedAtCloseMs: timerMachine.elapsedMs(prev, nowMs),
      };
    } else {
      // setPhase (the machine rejects focus -> focus; if one slipped through, the old run
      // still closes so it can never leak).
      close = {
        runId: prev.focusRunId,
        reason: 'phase_changed',
        closedAtMs: nowMs,
        elapsedAtCloseMs: timerMachine.elapsedMs(prev, nowMs),
      };
    }
  }

  if (next.phase === 'focus') return openNew(close);
  return {
    state: { ...next, focusRunId: null },
    runs: close ? { close } : undefined,
  };
};
