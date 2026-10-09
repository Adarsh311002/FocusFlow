import { CLOCK_SKEW_TOLERANCE_MS, type DisconnectMarker, type MarkerEvidence } from './decision.js';

// The disconnect marker (docs/architecture/focus-timing-protocol.md, "Disconnect marker";
// E10): `ff:user:{userId}:disconnected` = `{sessionId}:{latestDisconnectedAtMs}:{evidence}`.
// This module is pure: the value format and the rules for recording and clearing. The
// Redis store applies a plan under WATCH/MULTI, so every rule is decided on the value it
// read and written only if nothing changed in between.

/** Longer than the 12-hour stale window (E2), so a marker never outlives its purpose by design. */
export const MARKER_TTL_MS = 13 * 60 * 60 * 1_000;

const EVIDENCE: readonly MarkerEvidence[] = ['observed', 'detected'];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const formatMarker = (marker: DisconnectMarker): string =>
  `${marker.sessionId}:${String(marker.disconnectedAtMs)}:${marker.evidence}`;

/**
 * `undefined` for a malformed value. A malformed marker never matches a session: recording
 * replaces it, and no clear (which must prove ownership) deletes it; its TTL removes it.
 */
export const parseMarker = (raw: string): DisconnectMarker | undefined => {
  const parts = raw.split(':');
  if (parts.length !== 3) {
    return undefined;
  }
  const [sessionId, time, evidence] = parts;
  if (sessionId === undefined || !UUID_PATTERN.test(sessionId)) {
    return undefined;
  }
  if (time === undefined || !/^\d{1,16}$/.test(time)) {
    return undefined;
  }
  const match = EVIDENCE.find((value) => value === evidence);
  if (match === undefined) {
    return undefined;
  }
  return { sessionId, disconnectedAtMs: Number(time), evidence: match };
};

/** What a record request does to the stored value. */
export type RecordPlan =
  | { readonly action: 'write'; readonly marker: DisconnectMarker; readonly kind: RecordKind }
  | { readonly action: 'keep'; readonly reason: KeepReason };

export type RecordKind = 'created' | 'replaced_other_session' | 'replaced_older' | 'upgraded';
export type KeepReason = 'predates_stretch' | 'not_newer';

/**
 * E10 record rules for a disconnect `incoming` of the user's running session, whose
 * current stretch began at `runningSinceMs` (PostgreSQL; compared with the 2 s tolerance):
 *
 * - an event from before the current running stretch is ignored;
 * - no marker (or a malformed one) → set;
 * - another session's marker → replace (one in-progress session per user, so it is stale);
 * - same session, older timestamp → replace, with the incoming evidence (a newer
 *   `detected` may replace an older `observed`: that can only send the session to grace);
 * - same session, equal timestamp → only `detected` → `observed` (never the reverse);
 * - same session, newer timestamp → keep.
 */
export const planMarkerRecord = (
  existing: DisconnectMarker | undefined,
  incoming: DisconnectMarker,
  runningSinceMs: number,
): RecordPlan => {
  if (incoming.disconnectedAtMs + CLOCK_SKEW_TOLERANCE_MS < runningSinceMs) {
    return { action: 'keep', reason: 'predates_stretch' };
  }
  if (existing === undefined) {
    return { action: 'write', marker: incoming, kind: 'created' };
  }
  if (existing.sessionId !== incoming.sessionId) {
    return { action: 'write', marker: incoming, kind: 'replaced_other_session' };
  }
  if (incoming.disconnectedAtMs > existing.disconnectedAtMs) {
    return { action: 'write', marker: incoming, kind: 'replaced_older' };
  }
  if (
    incoming.disconnectedAtMs === existing.disconnectedAtMs &&
    existing.evidence === 'detected' &&
    incoming.evidence === 'observed'
  ) {
    return { action: 'write', marker: incoming, kind: 'upgraded' };
  }
  return { action: 'keep', reason: 'not_newer' };
};

/**
 * Which markers a clear may delete. Every rule first requires ownership by `sessionId`;
 * nothing ever deletes a marker unconditionally (E10).
 *
 * - `upTo`: the decision found the user online at `upToMs` (Redis TIME) — delete only a
 *   disconnect at or before that instant; a later disconnect stays.
 * - `reconnect`: an online hint confirmed at `reconnectAtMs` (Redis TIME), before the
 *   planned end — like `upTo`, but only while that is inside the disconnect's grace; a
 *   marker whose grace ran out stays for its grace job (E16).
 * - `session`: the session paused, resumed, stopped or settled — delete its marker.
 * - `stale`: delete it only if it predates the session's current stretch.
 */
export type ClearRule =
  | { readonly kind: 'upTo'; readonly sessionId: string; readonly upToMs: number }
  | {
      readonly kind: 'reconnect';
      readonly sessionId: string;
      readonly reconnectAtMs: number;
      readonly graceMs: number;
    }
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'stale'; readonly sessionId: string; readonly runningSinceMs: number };

export const planMarkerClear = (
  existing: DisconnectMarker | undefined,
  rule: ClearRule,
): boolean => {
  if (existing === undefined || existing.sessionId !== rule.sessionId) {
    return false;
  }
  switch (rule.kind) {
    case 'upTo':
      return existing.disconnectedAtMs <= rule.upToMs;
    case 'reconnect':
      return (
        existing.disconnectedAtMs <= rule.reconnectAtMs &&
        rule.reconnectAtMs < existing.disconnectedAtMs + rule.graceMs
      );
    case 'session':
      return true;
    case 'stale':
      return existing.disconnectedAtMs + CLOCK_SKEW_TOLERANCE_MS < rule.runningSinceMs;
  }
};
