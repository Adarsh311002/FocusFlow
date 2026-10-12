import { hasReachedPlannedEnd, plannedEndMs, type RunningSession } from './timing.js';

// The decision for a running solo session (docs/architecture/focus-timing-protocol.md,
// "The decision for a running session"; D14/15/35, H2, H3, E7–E10, E16–E18). One
// procedure for every caller: the end job, grace jobs, the reconciler sweep, and a pause
// or stop at or after the planned end. Pure: the caller reads the inputs (the locked row,
// the PostgreSQL clock, the marker, and checkUser with the epoch in one Redis read) and
// applies the outcome.

/** E9: the only tolerance between a Redis TIME instant and a PostgreSQL instant. */
export const CLOCK_SKEW_TOLERANCE_MS = 2_000;

/** D14/15/35: the reconnect grace for an actively running session. */
export const SOLO_GRACE_MS = 60_000;

/**
 * E18: for this long after an epoch is created (Redis TIME), presence is not trusted — the
 * live instances are still re-adding their sockets. The runtime passes INSTANCE_TTL_MS:
 * every live instance ticks at least twice within it, and one that does not is dead.
 */
export const PRESENCE_RECOVERY_MS = 30_000;

/**
 * Whether a presence check can be decided on (H2, E18): it succeeded, the epoch it read is
 * known, and it was taken after the epoch's presence-recovery window ended.
 */
export type PresenceTrust =
  | {
      readonly kind: 'trusted';
      readonly presence: PresenceObservation;
      readonly epochCreatedAtMs: number;
    }
  | { readonly kind: 'presence_unknown' | 'epoch_unknown' | 'presence_recovering' };

export const presenceTrust = (
  presence: PresenceObservation | undefined,
  epochCreatedAtMs: number | undefined,
  presenceRecoveryMs: number,
): PresenceTrust => {
  if (presence === undefined) {
    return { kind: 'presence_unknown' };
  }
  if (epochCreatedAtMs === undefined) {
    return { kind: 'epoch_unknown' };
  }
  return presence.checkedAtMs < epochCreatedAtMs + presenceRecoveryMs
    ? { kind: 'presence_recovering' }
    : { kind: 'trusted', presence, epochCreatedAtMs };
};

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
  /**
   * The epoch's creation time (Redis TIME), read in the same Redis transaction as
   * `presence`; `undefined` when unknown (missing, malformed, or the check failed).
   */
  readonly epochCreatedAtMs: number | undefined;
  /** The reconnect grace; `SOLO_GRACE_MS` unless a test configures it (FOCUS_GRACE_MS). */
  readonly graceMs?: number;
  /** E18: `PRESENCE_RECOVERY_MS` unless configured (the runtime passes INSTANCE_TTL_MS). */
  readonly presenceRecoveryMs?: number;
  /**
   * Set only by the grace job, with its payload's disconnect: E16 applies only while the
   * marker still holds exactly this session and this disconnect. Every other caller (the
   * end job, the reconciler, pause/stop) leaves it unset.
   */
  readonly graceJob?: { readonly disconnectedAtMs: number };
};

export type Decision =
  /** Decide nothing; retry later (H2: never decide on an unknown state). */
  | {
      readonly kind: 'retry';
      readonly reason: 'presence_unknown' | 'epoch_unknown' | 'presence_recovering';
    }
  /** `completed` with `ended_at = T_end`. */
  | { readonly kind: 'complete' }
  /** Keep running; clear this session's marker up to `checkedAtMs` if there is one. */
  | { readonly kind: 'continue'; readonly clearMarkerUpToMs: number | null }
  /**
   * The marker's grace job settles it: offline inside the grace, or online while the marker
   * still records a disconnect that only that grace job may treat as a reconnect (E16).
   */
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
  const { session, nowMs } = input;
  const runningSinceMs = session.runningSinceMs;

  const ownMarker = input.marker?.sessionId === input.sessionId ? input.marker : null;
  const staleMarker =
    ownMarker !== null && ownMarker.disconnectedAtMs + CLOCK_SKEW_TOLERANCE_MS < runningSinceMs;
  const marker = staleMarker ? null : ownMarker;
  const result = (decision: Decision): DecisionResult => ({
    decision,
    clearStaleMarker: staleMarker,
  });

  const endMs = plannedEndMs(session);
  const pastEnd = hasReachedPlannedEnd(session, nowMs);
  const graceMs = input.graceMs ?? SOLO_GRACE_MS;

  // E8: only observed evidence can prove presence through the planned end. It decides on
  // its own: neither presence nor the epoch is needed.
  if (
    pastEnd &&
    marker !== null &&
    marker.evidence === 'observed' &&
    marker.disconnectedAtMs + CLOCK_SKEW_TOLERANCE_MS >= endMs
  ) {
    return result({ kind: 'complete' });
  }

  // Everything below depends on presence, so it needs a presence check that can be
  // trusted: known, with a known epoch, and outside the epoch's recovery window (H2, E18).
  // After the window the rules are unchanged; it only delays a decision.
  const trust = presenceTrust(
    input.presence,
    input.epochCreatedAtMs,
    input.presenceRecoveryMs ?? PRESENCE_RECOVERY_MS,
  );
  if (trust.kind !== 'trusted') {
    return result({ kind: 'retry', reason: trust.kind });
  }
  const { presence, epochCreatedAtMs } = trust;

  // E16: only the grace job of exactly this disconnect, finding the user online.
  const lateGraceReconnect =
    marker !== null && input.graceJob?.disconnectedAtMs === marker.disconnectedAtMs;

  if (presence.online) {
    if (!pastEnd) {
      if (marker === null) {
        return result({ kind: 'continue', clearMarkerUpToMs: null });
      }
      // A reconnect inside the grace (both instants Redis TIME, no tolerance), or E16.
      const withinGrace = presence.checkedAtMs < marker.disconnectedAtMs + graceMs;
      return result(
        withinGrace || lateGraceReconnect
          ? { kind: 'continue', clearMarkerUpToMs: presence.checkedAtMs }
          : { kind: 'wait_for_grace', disconnectedAtMs: marker.disconnectedAtMs },
      );
    }
    // At or after the end, being online now proves nothing while a disconnect of the
    // stretch is recorded: only that disconnect's grace job decides (E8, E16).
    if (marker !== null && !lateGraceReconnect) {
      return result({ kind: 'wait_for_grace', disconnectedAtMs: marker.disconnectedAtMs });
    }
    // No disconnect recorded (D35), or E16: complete — unless Redis definitely lost its
    // data during the stretch, when a missing marker proves nothing (E9).
    return result(lossDuringStretch(epochCreatedAtMs, runningSinceMs) ?? { kind: 'complete' });
  }

  if (marker !== null) {
    // Both instants are Redis TIME: no tolerance.
    return result(
      presence.checkedAtMs >= marker.disconnectedAtMs + graceMs
        ? { kind: 'grace_expired', disconnectedAtMs: marker.disconnectedAtMs }
        : { kind: 'wait_for_grace', disconnectedAtMs: marker.disconnectedAtMs },
    );
  }

  // Offline with no marker: a definite Redis loss expires; anything else gets late grace.
  return result(
    lossDuringStretch(epochCreatedAtMs, runningSinceMs) ?? {
      kind: 'late_grace',
      detectedAtMs: presence.checkedAtMs,
    },
  );
};

/**
 * `expired` on a definite Redis loss during the running stretch (E9:
 * `epochCreatedAtMs > runningSinceMs + tolerance`), otherwise `undefined`.
 */
const lossDuringStretch = (
  epochCreatedAtMs: number,
  runningSinceMs: number,
): Decision | undefined =>
  epochCreatedAtMs > runningSinceMs + CLOCK_SKEW_TOLERANCE_MS ? { kind: 'expired' } : undefined;
