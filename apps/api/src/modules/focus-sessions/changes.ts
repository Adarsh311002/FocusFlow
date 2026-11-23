import type { FocusSessionView } from '@focus-flow/contracts';
import type { Logger } from 'pino';

// After-commit fan-out for focus-session transitions (persist, then emit: docs/api/rest.md
// "Conventions"). The service publishes a change only after its PostgreSQL transaction
// committed, and only when the session actually changed. Later milestones attach the
// listeners: `focus:session:updated` to the user's room (E6), end-job scheduling for a new
// running stretch, and conditional marker clearing when a session stops running (E10).
// A listener failure is logged, never surfaced to the request: the state is already
// committed, and the reconciler repairs any missed follow-up.

export type FocusSessionTransition =
  | 'started'
  | 'paused'
  | 'resumed'
  | 'stopped'
  | 'completed'
  // Settled by the server (lifecycle jobs): abandoned with that reason.
  | 'grace_expired'
  | 'expired';

export type FocusSessionChange = {
  readonly userId: string;
  readonly transition: FocusSessionTransition;
  readonly session: FocusSessionView;
  /** Set when the change began a running stretch (start, resume): when it is planned to end. */
  readonly runningStretch: {
    readonly runningSinceMs: number;
    readonly plannedEndMs: number;
  } | null;
};

export type FocusSessionChangeListener = (change: FocusSessionChange) => Promise<void> | void;

export type FocusSessionChanges = {
  readonly publish: (change: FocusSessionChange) => Promise<void>;
  /** Returns an unsubscribe function. */
  readonly subscribe: (listener: FocusSessionChangeListener) => () => void;
};

export const createFocusSessionChanges = (logger: Logger): FocusSessionChanges => {
  const listeners = new Set<FocusSessionChangeListener>();
  return {
    publish: async (change) => {
      logger.debug(
        { userId: change.userId, sessionId: change.session.id, transition: change.transition },
        'Focus session changed',
      );
      for (const listener of listeners) {
        try {
          await listener(change);
        } catch (error) {
          logger.error(
            { err: error, sessionId: change.session.id, transition: change.transition },
            'Focus session change listener failed',
          );
        }
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
