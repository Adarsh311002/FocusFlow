import type { FocusSessionView } from '@focus-flow/contracts';

import { userRoom } from '../realtime/types.js';
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
// The `focus:session:updated` socket event (E6) is a separate listener, below.
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

/** The part of the Socket.IO emitter the notification needs; tests pass a fake. */
export type SessionNotifier = {
  readonly to: (room: string) => {
    readonly emit: (event: 'focus:session:updated', payload: { session: FocusSessionView }) => void;
  };
};

/**
 * `focus:session:updated` to every tab of the user (E6), after the commit. Its own listener,
 * apart from the follow-ups above: a failed emit is logged by the publisher and must not
 * keep the end job from being scheduled, nor the other way round. The room is derived from
 * the session's owner on the server; the payload is the committed view, a hint to refetch.
 *
 * The Redis emitter publishes without awaiting, so a failure cannot be caught here. The
 * pub/sub connection never fails a command while Redis is away (`maxRetriesPerRequest:
 * null` queues it until the reconnect), so a lost event only happens when the connection
 * was closed on purpose, at shutdown. Clients heal a missed event by refetching on
 * every (re)connect (docs/api/socket-events.md).
 */
export const attachSessionNotifications = (
  changes: FocusSessionChanges,
  notifier: SessionNotifier,
): (() => void) =>
  changes.subscribe((change) => {
    notifier.to(userRoom(change.userId)).emit('focus:session:updated', { session: change.session });
  });
