import { hasReachedPlannedEnd, plannedEndMs, type RunningSession } from './timing.js';

// The decision for a running solo session (docs/architecture/focus-timing-protocol.md,
// "The decision for a running session"; D14/15/35, H2, H3, E7–E10, E16). One procedure
// for every caller — a pause or stop at or after the planned end now, and (later
// milestones) the end job, grace jobs and the reconciler sweep. Pure: the caller reads
// the inputs (the locked row, PostgreSQL now(), the marker, checkUser, the epoch) and
// applies the outcome.

/** E9: the only tolerance between a Redis TIME instant and a PostgreSQL instant. */
export const CLOCK_SKEW_TOLERANCE_MS = 2_000;

/** D14/15/35: the reconnect grace for an actively running session. */
export const SOLO_GRACE_MS = 60_000;

/** E10: `observed` only for a socket's own disconnect; everything else is `detected`. */
export type MarkerEvidence = 'observed' | 'detected';

/** The parsed `ff:user:{userId}:disconnected` value (E10). */
export type DisconnectMarker = {
  readonly sessionId: string;
  readonly disconnectedAtMs: number;
  readonly evidence: MarkerEvidence;
};

/** A successful `checkUser` (H2). A failed check is `undefined` and decides nothing. */
export type PresenceObservation = {
  readonly online: boolean;
  readonly checkedAtMs: number;
};

export type DecisionInput = {
  readonly sessionId: string;
  readonly session: RunningSession;
  /** PostgreSQL now() (E9). */
  readonly nowMs: number;
  /** The user's marker, whichever session it belongs to, or `null` when there is none. */
  readonly marker: DisconnectMarker | null;
  /** `undefined` when checkUser failed. */
  readonly presence: PresenceObservation | undefined;
  /** The current epoch's creation time (Redis TIME), `undefined` when unknown. */
  readonly epochCreatedAtMs: number | undefined;
  /** The reconnect grace; `SOLO_GRACE_MS` unless a test configures it (FOCUS_GRACE_MS). */
  readonly graceMs?: number;
};

export type Decision =
  /** Decide nothing; retry later (H2: never decide on an unknown state). */
  | { readonly kind: 'retry'; readonly reason: 'presence_unknown' | 'epoch_unknown' }
  /** `completed` with `ended_at = T_end`. */
  | { readonly kind: 'complete' }
  /** Keep running; clear this session's marker up to `checkedAtMs` if there is one. */
  | { readonly kind: 'continue'; readonly clearMarkerUpToMs: number | null }
  /** Offline inside the grace: its grace job settles it. */
  | { readonly kind: 'wait_for_grace'; readonly disconnectedAtMs: number }
  | { readonly kind: 'grace_expired'; readonly disconnectedAtMs: number }
  /** Definite Redis loss during the stretch (E9). */
  | { readonly kind: 'expired' }
  /** H3: record a `detected` disconnect at `detectedAtMs` and schedule its grace. */
  | { readonly kind: 'late_grace'; readonly detectedAtMs: number };

export type DecisionResult = {
  readonly decision: Decision;
  /**
   * The marker belonged to this session but predates its current running stretch (E10):
   * it was treated as absent and should be cleared for this session.
   */
  readonly clearStaleMarker: boolean;
};

/**
 * Applies the protocol's decision tables. The marker counts only if it belongs to this
 * session and its timestamp is not from before the current stretch (`t + tolerance ≥ R`).
 */
export const decideRunningSession = (input: DecisionInput): DecisionResult => {
  const { session, nowMs, presence } = input;
  const runningSinceMs = session.runningSinceMs;

  const ownMarker = input.marker?.sessionId === input.sessionId ? input.marker : null;
  const staleMarker =
    ownMarker !== null && ownMarker.disconnectedAtMs + CLOCK_SKEW_TOLERANCE_MS < runningSinceMs;
  const marker = staleMarker ? null : ownMarker;
  const result = (decision: Decision): DecisionResult => ({
    decision,
    clearStaleMarker: staleMarker,
  });

  if (presence === undefined) {
    return result({ kind: 'retry', reason: 'presence_unknown' });
  }

  const endMs = plannedEndMs(session);
  const pastEnd = hasReachedPlannedEnd(session, nowMs);

  // E8: only observed evidence can prove presence through the planned end.
  if (
    pastEnd &&
    marker !== null &&
    marker.evidence === 'observed' &&
    marker.disconnectedAtMs + CLOCK_SKEW_TOLERANCE_MS >= endMs
  ) {
    return result({ kind: 'complete' });
  }

  if (presence.online) {
    // Before the end: keep running. At or after it: no disconnect recorded, or a
    // reconnect whose exact time is unknowable — E16's intentional recovery policy.
    return result(
      pastEnd
        ? { kind: 'complete' }
        : { kind: 'continue', clearMarkerUpToMs: marker === null ? null : presence.checkedAtMs },
    );
  }

  if (marker !== null) {
    // Both instants are Redis TIME: no tolerance.
    return result(
      presence.checkedAtMs >= marker.disconnectedAtMs + (input.graceMs ?? SOLO_GRACE_MS)
        ? { kind: 'grace_expired', disconnectedAtMs: marker.disconnectedAtMs }
        : { kind: 'wait_for_grace', disconnectedAtMs: marker.disconnectedAtMs },
    );
  }

  // Offline with no marker: a definite Redis loss expires; anything else gets late grace.
  if (input.epochCreatedAtMs === undefined) {
    return result({ kind: 'retry', reason: 'epoch_unknown' });
  }
  if (input.epochCreatedAtMs > runningSinceMs + CLOCK_SKEW_TOLERANCE_MS) {
    return result({ kind: 'expired' });
  }
  return result({ kind: 'late_grace', detectedAtMs: presence.checkedAtMs });
};
