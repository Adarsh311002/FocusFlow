import type { FocusSessionView, SoloEndJob, SoloGraceJob } from '@focus-flow/contracts';

import type { Tx } from '../../db/client.js';
import { decideRunningSession, type DisconnectMarker } from './decision.js';
import type { ClearRule } from './marker.js';
import type { DisconnectMarkerStore } from './marker-store.js';
import {
  databaseNowMs,
  type FocusSessionRow,
  limitStatementTime,
  lockOwnedSession,
  lockOwnedSessionSkipLocked,
  saveSession,
  type SessionKey,
} from './queries.js';
import { toSessionChanges, toSoloSession } from './rows.js';
import { decisionPresence, type FocusSessionsDeps, loadView, observePresence } from './service.js';
import {
  complete,
  expire,
  expireGrace,
  hasReachedPlannedEnd,
  isRunning,
  plannedEndMs,
  type RunningSession,
  type Transition,
} from './timing.js';

// The server-driven lifecycle of a running solo session (docs/architecture/
// focus-timing-protocol.md, "Reaching the planned time", "Disconnect while running",
// "The decision for a running session"; E7–E10, E16): the solo end job and the solo grace
// job. Both lock the session row, check the job still applies to the session as it is
// now, run the one decision procedure and write the outcome in that transaction. Redis
// writes, job scheduling and change publication follow the commit; a failed follow-up
// fails the job, which BullMQ retries — every step is idempotent, so a retry is harmless.
// The reconciler's per-session steps (reconcileRunningSession, expireStaleSession; E19)
// live here too, sharing that decision and settlement code.

/**
 * Both calls ENSURE the job (E20): added if absent, left alone while it will still run, and
 * re-run (attempts reset) if BullMQ retains it as completed or failed.
 */
export type FocusSessionScheduler = {
  /** `solo-end` for the running stretch; `reconnectAtMs` adds an immediate re-decision. */
  readonly scheduleEnd: (job: {
    readonly sessionId: string;
    readonly userId: string;
    readonly runningSinceMs: number;
    readonly plannedEndMs: number;
    readonly reconnectAtMs?: number;
  }) => Promise<void>;
  /** `solo-grace` for one recorded disconnect (Redis TIME), due `graceMs` after it. */
  readonly scheduleGrace: (job: {
    readonly sessionId: string;
    readonly userId: string;
    readonly disconnectedAtMs: number;
  }) => Promise<void>;
};

export type LifecycleDeps = FocusSessionsDeps & {
  readonly markers: DisconnectMarkerStore;
  readonly graceMs: number;
  readonly scheduler: FocusSessionScheduler;
};

export type SettlementTransition = 'completed' | 'grace_expired' | 'expired';

export type JobOutcome =
  | { readonly kind: 'settled'; readonly transition: SettlementTransition }
  | {
      readonly kind: 'no_op';
      readonly reason: 'session_gone' | 'not_running' | 'stretch_changed' | 'marker_changed';
    }
  /** Online before the planned end: the reconnect cleared the marker; still running. */
  | { readonly kind: 'continued' }
  /** A recorded disconnect (offline, or online again at or after T_end): its grace job decides. */
  | { readonly kind: 'waiting_for_grace' }
  /** H3: a detected disconnect was recorded and its grace scheduled. */
  | { readonly kind: 'late_grace' }
  /** Ran early (before `T_end`, or before the grace ends): run again after `delayMs`. */
  | { readonly kind: 'wake_later'; readonly delayMs: number };

/** The decision could not be made (presence or epoch unknown, H2): the job is retried. */
export class RetryLaterError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`focus session decision deferred: ${reason}`);
    this.name = 'RetryLaterError';
    this.reason = reason;
  }
}

type FollowUp =
  | { readonly kind: 'clear_marker'; readonly rule: ClearRule }
  | {
      readonly kind: 'record_late_grace';
      readonly marker: DisconnectMarker;
      readonly runningSinceMs: number;
    }
  | { readonly kind: 'schedule_grace'; readonly disconnectedAtMs: number }
  | {
      readonly kind: 'schedule_end';
      readonly runningSinceMs: number;
      readonly plannedEndMs: number;
    };

type Locked = {
  readonly outcome: JobOutcome;
  readonly published?: {
    readonly view: FocusSessionView;
    readonly transition: SettlementTransition;
  };
  readonly followUps: readonly FollowUp[];
};

const noOp = (reason: Extract<JobOutcome, { kind: 'no_op' }>['reason']): Locked => ({
  outcome: { kind: 'no_op', reason },
  followUps: [],
});

const settle = async (
  tx: Tx,
  row: FocusSessionRow,
  transition: Transition,
  name: SettlementTransition,
  followUps: readonly FollowUp[],
): Promise<Locked> => {
  if (transition.outcome !== 'changed') {
    // Only reachable for a session that is no longer running, which the callers exclude.
    throw new Error(`focus session ${row.id}: ${name} did not apply (${transition.outcome})`);
  }
  const saved = await saveSession(tx, row.id, toSessionChanges(transition.session));
  return {
    outcome: { kind: 'settled', transition: name },
    published: { view: await loadView(tx, saved), transition: name },
    followUps,
  };
};

/**
 * Who decides: only a grace job, with the disconnect it is about, may apply E16. The end job
 * and the reconciler hand a recorded disconnect over to its grace job.
 */
type DecidingJob =
  | { readonly kind: 'end' }
  | { readonly kind: 'reconciler' }
  | { readonly kind: 'grace'; readonly disconnectedAtMs: number };

/**
 * Runs the decision for a running session inside the caller's transaction, with the row
 * locked. The marker was read by the caller; presence and the epoch are read here, in one
 * atomic Redis read after the lock (E17) — the approved decision read. Writes nothing to
 * Redis.
 */
const decideLocked = async (
  tx: Tx,
  deps: LifecycleDeps,
  row: FocusSessionRow,
  session: RunningSession,
  nowMs: number,
  marker: DisconnectMarker | undefined,
  job: DecidingJob,
): Promise<Locked> => {
  const { presence, epochCreatedAtMs } = decisionPresence(await observePresence(deps, row.userId));
  const { decision, clearStaleMarker } = decideRunningSession({
    sessionId: row.id,
    session,
    nowMs,
    marker: marker ?? null,
    presence,
    epochCreatedAtMs,
    graceMs: deps.graceMs,
    presenceRecoveryMs: deps.presenceRecoveryMs,
    ...(job.kind === 'grace' ? { graceJob: { disconnectedAtMs: job.disconnectedAtMs } } : {}),
  });
  const followUps: FollowUp[] = clearStaleMarker
    ? [
        {
          kind: 'clear_marker',
          rule: { kind: 'stale', sessionId: row.id, runningSinceMs: session.runningSinceMs },
        },
      ]
    : [];

  switch (decision.kind) {
    case 'retry':
      throw new RetryLaterError(decision.reason);
    case 'complete':
      return settle(tx, row, complete(session, nowMs), 'completed', followUps);
    case 'grace_expired':
      return settle(
        tx,
        row,
        expireGrace(session, decision.disconnectedAtMs),
        'grace_expired',
        followUps,
      );
    case 'expired':
      return settle(tx, row, expire(session, nowMs), 'expired', followUps);
    case 'continue':
      if (decision.clearMarkerUpToMs !== null) {
        followUps.push({
          kind: 'clear_marker',
          rule: { kind: 'upTo', sessionId: row.id, upToMs: decision.clearMarkerUpToMs },
        });
      }
      return { outcome: { kind: 'continued' }, followUps };
    case 'wait_for_grace': {
      if (job.kind === 'grace' && presence !== undefined) {
        // Offline inside its grace (both instants Redis TIME): wake when it has run its course.
        const delayMs = decision.disconnectedAtMs + deps.graceMs - presence.checkedAtMs;
        return { outcome: { kind: 'wake_later', delayMs: Math.max(1, delayMs) }, followUps };
      }
      // The end job and the reconciler hand over to the grace job of the current disconnect
      // (ensured, E20) — also when the user is online again: only that grace job may treat
      // it as a reconnect (E16). A grace that already ran out makes it run at once.
      followUps.push({ kind: 'schedule_grace', disconnectedAtMs: decision.disconnectedAtMs });
      return { outcome: { kind: 'waiting_for_grace' }, followUps };
    }
    case 'late_grace':
      followUps.push({
        kind: 'record_late_grace',
        marker: {
          sessionId: row.id,
          disconnectedAtMs: decision.detectedAtMs,
          evidence: 'detected',
        },
        runningSinceMs: session.runningSinceMs,
      });
      return { outcome: { kind: 'late_grace' }, followUps };
  }
};

/** After the commit: publish the settlement, then apply the Redis follow-ups in order. */
const finish = async (deps: LifecycleDeps, userId: string, sessionId: string, locked: Locked) => {
  if (locked.published !== undefined) {
    await deps.changes.publish({
      userId,
      transition: locked.published.transition,
      session: locked.published.view,
      runningStretch: null,
    });
  }
  for (const followUp of locked.followUps) {
    switch (followUp.kind) {
      case 'clear_marker':
        await deps.markers.clear(userId, followUp.rule);
        break;
      case 'schedule_grace':
        await deps.scheduler.scheduleGrace({
          sessionId,
          userId,
          disconnectedAtMs: followUp.disconnectedAtMs,
        });
        break;
      case 'schedule_end':
        await deps.scheduler.scheduleEnd({
          sessionId,
          userId,
          runningSinceMs: followUp.runningSinceMs,
          plannedEndMs: followUp.plannedEndMs,
        });
        break;
      case 'record_late_grace': {
        const recorded = await deps.markers.record(
          userId,
          followUp.marker,
          followUp.runningSinceMs,
        );
        if (recorded.action === 'write') {
          await deps.scheduler.scheduleGrace({
            sessionId,
            userId,
            disconnectedAtMs: followUp.marker.disconnectedAtMs,
          });
        }
        break;
      }
    }
  }
  return locked.outcome;
};

/**
 * `solo-end`: the running stretch `runningSinceMs` reached (or should have reached) its
 * planned end. Outdated if the session ended, paused or started another stretch.
 */
export const runSoloEndJob = async (deps: LifecycleDeps, job: SoloEndJob): Promise<JobOutcome> => {
  const locked = await deps.db.transaction(async (tx): Promise<Locked> => {
    const row = await lockOwnedSession(tx, job.userId, job.sessionId);
    if (row === undefined) {
      return noOp('session_gone');
    }
    const session = toSoloSession(row);
    if (!isRunning(session)) {
      return noOp('not_running');
    }
    if (session.runningSinceMs !== job.runningSinceMs) {
      return noOp('stretch_changed');
    }
    const nowMs = await databaseNowMs(tx);
    if (!hasReachedPlannedEnd(session, nowMs)) {
      return {
        outcome: { kind: 'wake_later', delayMs: plannedEndMs(session) - nowMs },
        followUps: [],
      };
    }
    const marker = await deps.markers.read(row.userId);
    return decideLocked(tx, deps, row, session, nowMs, marker, { kind: 'end' });
  });
  return finish(deps, job.userId, job.sessionId, locked);
};

/**
 * `solo-grace`: settles only while the session is running and the marker still holds
 * exactly this job's session and disconnect (E10); otherwise a reconnect cleared it, or a
 * newer disconnect owns the grace, and the job does nothing.
 */
export const runSoloGraceJob = async (
  deps: LifecycleDeps,
  job: SoloGraceJob,
): Promise<JobOutcome> => {
  const locked = await deps.db.transaction(async (tx): Promise<Locked> => {
    const row = await lockOwnedSession(tx, job.userId, job.sessionId);
    if (row === undefined) {
      return noOp('session_gone');
    }
    const session = toSoloSession(row);
    if (!isRunning(session)) {
      return noOp('not_running');
    }
    const marker = await deps.markers.read(row.userId);
    if (
      marker === undefined ||
      marker.sessionId !== row.id ||
      marker.disconnectedAtMs !== job.disconnectedAtMs
    ) {
      return noOp('marker_changed');
    }
    const nowMs = await databaseNowMs(tx);
    return decideLocked(tx, deps, row, session, nowMs, marker, {
      kind: 'grace',
      disconnectedAtMs: job.disconnectedAtMs,
    });
  });
  return finish(deps, job.userId, job.sessionId, locked);
};

/** The reconciler's view of one session: a job outcome, or why it was left for later. */
export type ReconcileOutcome =
  | JobOutcome
  /** Another transaction holds the row (`SKIP LOCKED`): it is deciding the session now. */
  | { readonly kind: 'skipped_locked' }
  /** The decision could not be made (presence, the epoch or the marker unknown, E18). */
  | { readonly kind: 'deferred'; readonly reason: string };

/**
 * The transition committed, but a follow-up after the commit (a marker write, a job
 * ensure) failed. The state is durable; the next reconciler run repairs the follow-up.
 */
export class FollowUpError extends Error {
  readonly outcome: ReconcileOutcome;

  constructor(outcome: ReconcileOutcome, cause: unknown) {
    super('a focus-session follow-up after the commit failed', { cause });
    this.name = 'FollowUpError';
    this.outcome = outcome;
  }
}

/**
 * The reconciler sweep's decision for one running session (reconciler step 5). Like the
 * jobs, but: the row is locked `FOR UPDATE SKIP LOCKED` (a held row is skipped, never
 * waited for), every statement is bounded by `statementTimeoutMs`, an unknown state is
 * reported as `deferred` instead of thrown, it never applies E16, and a session that keeps
 * running before its planned end gets its end job ensured (it may have been lost).
 * Terminal outcomes are settled directly in the transaction and published after the commit.
 */
export const reconcileRunningSession = async (
  deps: LifecycleDeps,
  key: SessionKey,
  statementTimeoutMs: number,
): Promise<ReconcileOutcome> => {
  let locked: Locked | undefined;
  try {
    locked = await deps.db.transaction(async (tx): Promise<Locked | undefined> => {
      await limitStatementTime(tx, statementTimeoutMs);
      const row = await lockOwnedSessionSkipLocked(tx, key.userId, key.id);
      if (row === undefined) {
        return undefined;
      }
      const session = toSoloSession(row);
      if (!isRunning(session)) {
        return noOp('not_running');
      }
      const nowMs = await databaseNowMs(tx);
      let marker: DisconnectMarker | undefined;
      try {
        marker = await deps.markers.read(row.userId);
      } catch {
        // An unreadable marker may hide E8 evidence: decide nothing (H2).
        throw new RetryLaterError('marker_unknown');
      }
      const decided = await decideLocked(tx, deps, row, session, nowMs, marker, {
        kind: 'reconciler',
      });
      if (decided.outcome.kind === 'settled' || hasReachedPlannedEnd(session, nowMs)) {
        return decided;
      }
      return {
        ...decided,
        followUps: [
          ...decided.followUps,
          {
            kind: 'schedule_end',
            runningSinceMs: session.runningSinceMs,
            plannedEndMs: plannedEndMs(session),
          },
        ],
      };
    });
  } catch (error) {
    if (error instanceof RetryLaterError) {
      return { kind: 'deferred', reason: error.reason };
    }
    throw error;
  }
  if (locked === undefined) {
    return { kind: 'skipped_locked' };
  }
  try {
    return await finish(deps, key.userId, key.id, locked);
  } catch (error) {
    throw new FollowUpError(locked.outcome, error);
  }
};

export type StaleOutcome =
  | { readonly kind: 'expired' }
  | { readonly kind: 'no_op'; readonly reason: 'ended' | 'not_stale' }
  | { readonly kind: 'skipped_locked' };

/**
 * Stale cleanup for one session (reconciler step 6, E2, E19): still in progress
 * `staleAfterMs` after `started_at` — running or paused, whatever step 5 decided or deferred
 * — becomes `abandoned(expired)`, keeping the time accumulated before any current stretch.
 * A session that already ended keeps its outcome. PostgreSQL only: it runs while Redis is
 * unavailable too, and then the change listeners' Redis follow-ups fail and are logged by
 * the change publisher (E22).
 */
export const expireStaleSession = async (
  deps: Pick<FocusSessionsDeps, 'db' | 'changes'>,
  key: SessionKey,
  options: { readonly staleAfterMs: number; readonly statementTimeoutMs: number },
): Promise<StaleOutcome> => {
  const result = await deps.db.transaction(
    async (tx): Promise<StaleOutcome | { readonly view: FocusSessionView }> => {
      await limitStatementTime(tx, options.statementTimeoutMs);
      const row = await lockOwnedSessionSkipLocked(tx, key.userId, key.id);
      if (row === undefined) {
        return { kind: 'skipped_locked' };
      }
      const session = toSoloSession(row);
      if (session.status !== 'in_progress') {
        return { kind: 'no_op', reason: 'ended' };
      }
      const nowMs = await databaseNowMs(tx);
      if (nowMs < session.startedAtMs + options.staleAfterMs) {
        return { kind: 'no_op', reason: 'not_stale' };
      }
      const transition = expire(session, nowMs);
      if (transition.outcome !== 'changed') {
        throw new Error(`focus session ${row.id}: stale expiry did not apply`);
      }
      const saved = await saveSession(tx, row.id, toSessionChanges(transition.session));
      return { view: await loadView(tx, saved) };
    },
  );
  if (!('view' in result)) {
    return result;
  }
  await deps.changes.publish({
    userId: key.userId,
    transition: 'expired',
    session: result.view,
    runningStretch: null,
  });
  return { kind: 'expired' };
};
