import type { FocusSessionChange, FocusSessionChanges } from './changes.js';
import type { FocusSessionScheduler } from './lifecycle.js';
import type { DisconnectMarkerStore } from './marker-store.js';

// What follows a committed focus-session change (persist, then act: docs/api/rest.md
// "Conventions"), for requests and jobs alike:
// - a new running stretch (start, resume) schedules its end job;
// - a session that paused or ended clears ITS OWN marker — never another session's
//   (E10): the clear is ownership-checked, so a late cleanup of one session can never
//   remove the marker of the user's next session;
// - a resumed session clears only a marker left from before its new stretch.
// The `focus:session:updated` socket event (E6) attaches here in a later milestone.
// Failures are logged by the change publisher and never undo the commit.

export type FollowUpDeps = {
  readonly scheduler: FocusSessionScheduler;
  readonly markers: DisconnectMarkerStore;
};

export const followUpChange = async (
  deps: FollowUpDeps,
  change: FocusSessionChange,
): Promise<void> => {
  const sessionId = change.session.id;
  if (change.runningStretch !== null) {
    await deps.scheduler.scheduleEnd({
      sessionId,
      userId: change.userId,
      runningSinceMs: change.runningStretch.runningSinceMs,
      plannedEndMs: change.runningStretch.plannedEndMs,
    });
  }
  if (change.transition === 'resumed' && change.runningStretch !== null) {
    // Only a marker from before the pause: a disconnect already recorded for the new
    // stretch (the user left right after resuming) must survive.
    await deps.markers.clear(change.userId, {
      kind: 'stale',
      sessionId,
      runningSinceMs: change.runningStretch.runningSinceMs,
    });
  } else if (change.transition !== 'started') {
    await deps.markers.clear(change.userId, { kind: 'session', sessionId });
  }
};

/** Subscribes the follow-ups; returns the unsubscribe function. */
export const attachFollowUps = (changes: FocusSessionChanges, deps: FollowUpDeps): (() => void) =>
  changes.subscribe((change) => followUpChange(deps, change));
