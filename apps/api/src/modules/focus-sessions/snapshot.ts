import { redisKeys } from '../../platform/redis-keys.js';
import type { PresenceCheck, PresenceStore } from '../presence/store.js';
import type { DisconnectMarker } from './decision.js';
import { parseMarker } from './marker.js';
import type { DisconnectMarkerStore } from './marker-store.js';

// The Redis inputs of the decision for a running session (docs/architecture/
// focus-timing-protocol.md, "The decision for a running session"; E8, E17). Presence, Redis
// TIME, the epoch and the disconnect marker come from one MULTI, so a decision never pairs
// a marker read at one instant with presence and an epoch read at another. A disconnect
// whose marker is not yet written at that instant is not evidence for this decision.

/** One atomic read of everything in Redis a decision depends on. */
export type DecisionSnapshot = {
  readonly presence: PresenceCheck;
  /** The user's marker (E10), whichever session it belongs to; `undefined` if none or malformed. */
  readonly marker: DisconnectMarker | undefined;
};

export const createDecisionSnapshots =
  (store: Pick<PresenceStore, 'checkUserWith'>) =>
  async (userId: string): Promise<DecisionSnapshot> => {
    const { value, ...presence } = await store.checkUserWith(
      userId,
      redisKeys.userDisconnected(userId),
    );
    return { presence, marker: value === null ? undefined : parseMarker(value) };
  };

/** What a decision decides on: the marker, and presence with the epoch when known. */
export type DecisionInputs = {
  readonly marker: DisconnectMarker | undefined;
  /** `undefined` when the snapshot failed: presence and the epoch are unknown (H2). */
  readonly presence: PresenceCheck | undefined;
};

/**
 * The snapshot, or — when it fails — the marker alone from a separate read, so that
 * qualifying observed evidence (E8), which needs neither presence nor the epoch, can still
 * decide. Throws when that read fails too: an unreadable marker may hide E8 evidence, and
 * every caller then decides nothing (a job retries, the reconciler defers, HTTP answers 503).
 */
export const readDecisionInputs = async (
  deps: {
    readonly snapshotUser: (userId: string) => Promise<DecisionSnapshot>;
    readonly markers: Pick<DisconnectMarkerStore, 'read'>;
  },
  userId: string,
): Promise<DecisionInputs> => {
  try {
    return await deps.snapshotUser(userId);
  } catch {
    return { marker: await deps.markers.read(userId), presence: undefined };
  }
};
