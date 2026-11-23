import type { RoomId, UserId } from '@focus-flow/contracts';
import { useState } from 'react';

import { HostBadge } from './room-badges';
import { useRoomLive } from './room-live-store';
import { roomErrorMessage } from './room-messages';
import { useRemoveRoomMember, useRoomMembers } from './room-queries';

/**
 * The room's members (durable, from the server) with a live "here / not here" mark per
 * person, from the presence the server reports for this room. The host can remove others,
 * after an in-page confirmation.
 */
export function MemberList({
  roomId,
  isHost,
  currentUserId,
}: {
  roomId: RoomId;
  isHost: boolean;
  currentUserId: UserId;
}) {
  const members = useRoomMembers(roomId, true);
  const presence = useRoomLive(roomId, (state) => state.presence);
  const joined = useRoomLive(roomId, (state) => state.joinStatus === 'joined');
  const remove = useRemoveRoomMember(roomId);
  const [confirming, setConfirming] = useState<UserId | null>(null);

  const present = new Set(presence.map((entry) => entry.userId));

  let body;
  if (members.isPending) {
    body = <p className="text-muted">Loading members…</p>;
  } else if (members.data === undefined) {
    body = (
      <div className="space-y-2">
        <p role="alert" className="text-sm text-danger">
          {roomErrorMessage(members.error)}
        </p>
        <button
          type="button"
          onClick={() => {
            void members.refetch();
          }}
          className="rounded-full border border-line bg-surface px-4 py-1.5 transition hover:bg-surface-strong text-sm"
        >
          Try again
        </button>
      </div>
    );
  } else {
    body = (
      <ul aria-label="Members" className="space-y-1">
        {members.data.map((member) => {
          const isHere = present.has(member.userId);
          const canRemove = isHost && !member.isHost && member.userId !== currentUserId;
          return (
            <li
              key={member.userId}
              aria-label={member.displayName}
              className="flex flex-wrap items-center gap-2"
            >
              {joined && (
                <span
                  aria-hidden="true"
                  className={`inline-block h-2.5 w-2.5 rounded-full ${isHere ? 'bg-ok shadow-[0_0_8px_var(--ff-ok)]' : 'bg-muted/40'}`}
                />
              )}
              <span>{member.displayName}</span>
              {member.isHost && <HostBadge />}
              {joined && (
                <span className="text-xs text-muted">{isHere ? 'Here now' : 'Not here'}</span>
              )}
              {canRemove && confirming !== member.userId && (
                <button
                  type="button"
                  onClick={() => {
                    remove.reset();
                    setConfirming(member.userId);
                  }}
                  className="ml-auto rounded-full border border-line bg-surface px-4 py-1.5 transition hover:bg-surface-strong text-xs"
                >
                  {`Remove ${member.displayName}`}
                </button>
              )}
              {canRemove && confirming === member.userId && (
                <span
                  role="group"
                  aria-label={`Confirm removing ${member.displayName}`}
                  className="ml-auto flex items-center gap-2 text-sm"
                >
                  <span>{`Remove ${member.displayName} from the room?`}</span>
                  <button
                    type="button"
                    disabled={remove.isPending}
                    onClick={() => {
                      remove.mutate(member.userId, {
                        onSuccess: () => {
                          setConfirming(null);
                        },
                      });
                    }}
                    className="rounded-lg bg-danger px-2 py-1 text-xs font-medium text-canvas disabled:opacity-50"
                  >
                    {remove.isPending ? 'Removing…' : 'Yes, remove'}
                  </button>
                  <button
                    type="button"
                    disabled={remove.isPending}
                    onClick={() => {
                      setConfirming(null);
                    }}
                    className="rounded-full border border-line bg-surface px-4 py-1.5 transition hover:bg-surface-strong text-xs disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <section aria-labelledby="members-heading" className="space-y-2">
      <h3 id="members-heading" className="font-display text-3xl">
        Members
      </h3>
      {joined && <p className="text-sm text-muted">{`${String(presence.length)} here now`}</p>}
      {body}
      {remove.error !== null && (
        <p role="alert" className="text-sm text-danger">
          {roomErrorMessage(remove.error)}
        </p>
      )}
    </section>
  );
}
