import type { RoomFocusParticipant } from '@focus-flow/contracts';
import { roomFocusParticipantSchema } from '@focus-flow/contracts';

import type { Executor } from '../../db/client.js';
import { findProfiles } from './queries.js';
import type { LedgerParticipant } from './types.js';

// The ledger stores ids and instants only (RF14); names and avatars are joined from
// PostgreSQL when a participant list is built, so a renamed user shows the new name and a
// deleted account simply drops out of the list.

/**
 * The public participants of a run, oldest opt-in first. `connected` is false while the
 * person's last socket is gone (the 60 s grace, D19).
 */
export const toParticipants = async (
  db: Executor,
  ledger: readonly LedgerParticipant[],
): Promise<RoomFocusParticipant[]> => {
  const profiles = new Map(
    (
      await findProfiles(
        db,
        ledger.map((participant) => participant.userId),
      )
    ).map((profile) => [profile.id, profile]),
  );
  return [...ledger]
    .sort((a, b) => a.optedInAtMs - b.optedInAtMs || a.userId.localeCompare(b.userId))
    .flatMap((participant) => {
      const profile = profiles.get(participant.userId);
      return profile === undefined
        ? []
        : [
            roomFocusParticipantSchema.parse({
              userId: participant.userId,
              displayName: profile.displayName,
              avatarUrl: profile.avatarUrl,
              optedInAtMs: participant.optedInAtMs,
              connected: participant.disconnectedAtMs === null,
              disconnectedAtMs: participant.disconnectedAtMs,
            }),
          ];
    });
};
