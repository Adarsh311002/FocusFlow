import type { Executor } from '../../db/client.js';
import type { OfflineReason, UserOfflineEvent } from '../presence/presence.js';
import type { PresenceCheck } from '../presence/store.js';
import type { MarkerEvidence } from './decision.js';
import type { FocusSessionScheduler } from './lifecycle.js';
import type { DisconnectMarkerStore } from './marker-store.js';
import { databaseNowMs, findInProgressSession } from './queries.js';
import { toSoloSession } from './rows.js';
import { hasReachedPlannedEnd, isRunning, plannedEndMs } from './timing.js';

// Solo Focus's use of the presence hints (docs/architecture/focus-timing-protocol.md,
// "Disconnect while running"; H2, H4, E10, E16). A hint never decides anything: the
// offline hint records the disconnect and schedules its grace; the online hint clears
// the marker up to the moment presence was confirmed and, after the planned end, asks
// the end job to decide now. Every decision is made later by a job, under the row lock,
// from the marker and an authoritative presence check. Nothing here runs in a
// PostgreSQL transaction.

/** E10: only a socket's own disconnect is `observed`; anything else is a detection. */
export const evidenceFor = (reason: OfflineReason): MarkerEvidence =>
  reason === 'disconnect' ? 'observed' : 'detected';

export type PresenceHintDeps = {
  readonly db: Executor;
  readonly markers: DisconnectMarkerStore;
  readonly checkUser: (userId: string) => Promise<PresenceCheck>;
  readonly scheduler: FocusSessionScheduler;
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
 * A socket of the user was newly recorded. Once presence confirms it, clears the
 * session's marker up to that confirmation (a later disconnect stays) and, if the planned
 * end has passed, schedules an immediate end decision: the session can complete now
 * rather than when its grace job runs.
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
  await deps.markers.clear(userId, {
    kind: 'upTo',
    sessionId: running.id,
    upToMs: presence.checkedAtMs,
  });
  if (hasReachedPlannedEnd(running.session, await databaseNowMs(deps.db))) {
    await deps.scheduler.scheduleEnd({
      sessionId: running.id,
      userId,
      runningSinceMs: running.session.runningSinceMs,
      plannedEndMs: plannedEndMs(running.session),
      reconnectAtMs: presence.checkedAtMs,
    });
  }
};
