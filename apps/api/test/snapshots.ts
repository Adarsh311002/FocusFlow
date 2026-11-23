import type { DisconnectMarkerStore } from '../src/modules/focus-sessions/marker-store.js';
import type { DecisionSnapshot } from '../src/modules/focus-sessions/snapshot.js';
import type { PresenceCheck } from '../src/modules/presence/store.js';

/**
 * A decision snapshot for a scripted world: its scripted presence check and its marker
 * store, read one after the other. Not atomic — scripted tests change neither in between;
 * the atomicity itself is tested against the real store (marker-snapshot.int.test.ts). It
 * fails when either read fails, like the real snapshot.
 */
export const scriptedSnapshot =
  (
    checkUser: (userId: string) => Promise<PresenceCheck>,
    markers: Pick<DisconnectMarkerStore, 'read'>,
  ) =>
  async (userId: string): Promise<DecisionSnapshot> => ({
    presence: await checkUser(userId),
    marker: await markers.read(userId),
  });
