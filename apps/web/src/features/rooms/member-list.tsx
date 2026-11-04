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
    body = <p className="text-slate-600">Loading members…</p>;
  } else if (members.data === undefined) {
    body = (
      <div className="space-y-2">
        <p role="alert" className="text-sm text-red-700">
          {roomErrorMessage(members.error)}
        </p>
        <button
          type="button"
          onClick={() => {
            void members.refetch();
          }}
          className="rounded border border-slate-300 px-3 py-1 text-sm"
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
                  className={`inline-block h-2.5 w-2.5 rounded-full ${isHere ? 'bg-green-600' : 'bg-slate-300'}`}
                />
              )}
              <span>{member.displayName}</span>
              {member.isHost && <HostBadge />}
              {joined && (
                <span className="text-xs text-slate-600">{isHere ? 'Here now' : 'Not here'}</span>
              )}
              {canRemove && confirming !== member.userId && (
                <button
                  type="button"
                  onClick={() => {
                    remove.reset();
                    setConfirming(member.userId);
                  }}
                  className="ml-auto rounded border border-slate-300 px-2 py-0.5 text-xs"
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
                    className="rounded bg-red-700 px-2 py-0.5 text-xs text-white disabled:opacity-50"
                  >
                    {remove.isPending ? 'Removing…' : 'Yes, remove'}
                  </button>
                  <button
                    type="button"
                    disabled={remove.isPending}
                    onClick={() => {
                      setConfirming(null);
                    }}
                    className="rounded border border-slate-300 px-2 py-0.5 text-xs disabled:opacity-50"
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
      <h3 id="members-heading" className="text-base font-semibold">
        Members
      </h3>
      {joined && <p className="text-sm text-slate-600">{`${String(presence.length)} here now`}</p>}
      {body}
      {remove.error !== null && (
        <p role="alert" className="text-sm text-red-700">
          {roomErrorMessage(remove.error)}
        </p>
      )}
    </section>
  );
}
