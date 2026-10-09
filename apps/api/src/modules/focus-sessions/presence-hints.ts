import type { Executor } from '../../db/client.js';
import type { OfflineReason, UserOfflineEvent } from '../presence/presence.js';
import type { PresenceCheck } from '../presence/store.js';
import { CLOCK_SKEW_TOLERANCE_MS, type MarkerEvidence } from './decision.js';
import type { FocusSessionScheduler } from './lifecycle.js';
import type { DisconnectMarkerStore } from './marker-store.js';
import { databaseNowMs, findInProgressSession } from './queries.js';
import { toSoloSession } from './rows.js';
import { hasReachedPlannedEnd, isRunning, plannedEndMs, type RunningSession } from './timing.js';

// Solo Focus's use of the presence hints (docs/architecture/focus-timing-protocol.md,
// "Disconnect while running"; H2, H4, E8, E10, E16). A hint never decides anything: the
// offline hint records the disconnect and schedules its grace; the online hint clears
// the marker only for a reconnect inside its grace before the planned end, and after the
// planned end keeps it, ensures its grace job and asks the end job to decide now. Every
// decision is made later by a job, under the row lock, from the marker and an
// authoritative presence check. Nothing here runs in a PostgreSQL transaction.

/** E10: only a socket's own disconnect is `observed`; anything else is a detection. */
export const evidenceFor = (reason: OfflineReason): MarkerEvidence =>
  reason === 'disconnect' ? 'observed' : 'detected';

export type PresenceHintDeps = {
  readonly db: Executor;
  readonly markers: DisconnectMarkerStore;
  readonly checkUser: (userId: string) => Promise<PresenceCheck>;
  readonly scheduler: FocusSessionScheduler;
  /** The reconnect grace (E10: a reconnect clears a marker only inside it). */
  readonly graceMs: number;
};

const checkPresence = async (
  deps: PresenceHintDeps,
  userId: string,
): Promise<PresenceCheck | undefined> => {
  try {
    return await deps.checkUser(userId);
  } catch {
    return undefined;
  }
};

/** The user's running solo session, if any (a paused one gets no marker and no grace). */
const runningSessionOf = async (deps: PresenceHintDeps, userId: string) => {
  const row = await findInProgressSession(deps.db, userId);
  if (row === undefined) {
    return undefined;
  }
  const session = toSoloSession(row);
  return isRunning(session) ? { id: row.id, session } : undefined;
};

/**
 * The user's last socket went away. Records the disconnect for the running session and
 * schedules its grace job. A stale hint (the user is online again) changes nothing; when
 * presence cannot be checked the disconnect is still recorded — harmless, because the
 * grace job re-checks presence and a reconnect continues the session (E16).
 */
export const handleUserOffline = async (
  deps: PresenceHintDeps,
  event: UserOfflineEvent,
): Promise<void> => {
  const running = await runningSessionOf(deps, event.userId);
  if (running === undefined) {
    return;
  }
  const presence = await checkPresence(deps, event.userId);
  if (presence?.online === true) {
    return;
  }
  const recorded = await deps.markers.record(
    event.userId,
    {
      sessionId: running.id,
      disconnectedAtMs: event.disconnectedAtMs,
      evidence: evidenceFor(event.reason),
    },
    running.session.runningSinceMs,
  );
  if (recorded.action === 'write') {
    await deps.scheduler.scheduleGrace({
      sessionId: running.id,
      userId: event.userId,
      disconnectedAtMs: event.disconnectedAtMs,
    });
  }
};

/**
 * Makes sure the grace job of the session's recorded disconnect is scheduled (job ids
 * collapse repeats). A marker of another session or from before the current stretch is
 * not this stretch's disconnect and needs none.
 */
const ensureGraceJob = async (
  deps: PresenceHintDeps,
  userId: string,
  running: { readonly id: string; readonly session: RunningSession },
): Promise<void> => {
  const marker = await deps.markers.read(userId);
  if (
    marker?.sessionId === running.id &&
    marker.disconnectedAtMs + CLOCK_SKEW_TOLERANCE_MS >= running.session.runningSinceMs
  ) {
    await deps.scheduler.scheduleGrace({
      sessionId: running.id,
      userId,
      disconnectedAtMs: marker.disconnectedAtMs,
    });
  }
};

/**
 * A socket of the user was newly recorded. Once presence confirms it:
 * - before the planned end, a reconnect inside the recorded disconnect's grace clears the
 *   marker up to that confirmation (a later disconnect stays); a marker whose grace ran
 *   out stays, and its grace job decides (E16);
 * - at or after the planned end, the marker is never cleared — being online now proves
 *   nothing about `T_end` (E8). The grace job of a recorded disconnect is ensured, and an
 *   immediate end decision is scheduled: without a disconnect recorded the session can
 *   complete now (D35); with one, the end job hands over to that grace job.
 */
export const handleUserOnline = async (deps: PresenceHintDeps, userId: string): Promise<void> => {
  const presence = await checkPresence(deps, userId);
  if (presence?.online !== true) {
    return;
  }
  const running = await runningSessionOf(deps, userId);
  if (running === undefined) {
    return;
  }
  if (!hasReachedPlannedEnd(running.session, await databaseNowMs(deps.db))) {
    const cleared = await deps.markers.clear(userId, {
      kind: 'reconnect',
      sessionId: running.id,
      reconnectAtMs: presence.checkedAtMs,
      graceMs: deps.graceMs,
    });
    if (!cleared) {
      await ensureGraceJob(deps, userId, running);
    }
    return;
  }
  await ensureGraceJob(deps, userId, running);
  await deps.scheduler.scheduleEnd({
    sessionId: running.id,
    userId,
    runningSinceMs: running.session.runningSinceMs,
    plannedEndMs: plannedEndMs(running.session),
    reconnectAtMs: presence.checkedAtMs,
  });
};
