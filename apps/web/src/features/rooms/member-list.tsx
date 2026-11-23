import type { RoomId, UserId } from '@focus-flow/contracts';
import { useState } from 'react';

import { HostBadge } from './room-badges';
import { useRoomLive } from './room-live-store';
import { roomErrorMessage } from './room-messages';
import {
  useBlockRoomMember,
  useRemoveRoomMember,
  useRoomBlocks,
  useRoomMembers,
  useUnblockRoomMember,
} from './room-queries';

/**
 * The room's members (durable, from the server) with a live "here / not here" mark per
 * person, from the presence the server reports for this room. The host can remove others,
 * after an in-page confirmation, either letting them rejoin or blocking them (B1), and can
 * lift a block from the blocked list.
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
  const block = useBlockRoomMember(roomId);
  const busy = remove.isPending || block.isPending;
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
                    block.reset();
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
                  className="mt-2 flex w-full flex-wrap items-center gap-2 rounded-2xl border border-line bg-canvas/40 p-3 text-sm"
                >
                  <span className="w-full">{`Remove ${member.displayName} from the room?`}</span>
                  <span className="w-full text-xs text-muted">
                    They can come back (in a private room, by knocking again) unless you block them.
                  </span>
                  <button
                    type="button"
                    disabled={busy}
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
                    disabled={busy}
                    onClick={() => {
                      block.mutate(member.userId, {
                        onSuccess: () => {
                          setConfirming(null);
                        },
                      });
                    }}
                    className="rounded-lg border border-danger/50 px-2 py-1 text-xs font-medium text-danger disabled:opacity-50"
                  >
                    {block.isPending ? 'Blocking…' : 'Remove and block'}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setConfirming(null);
                    }}
                    className="rounded-full border border-line bg-surface px-4 py-1.5 text-xs transition hover:bg-surface-strong disabled:opacity-50"
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
      {(remove.error ?? block.error) !== null && (
        <p role="alert" className="text-sm text-danger">
          {roomErrorMessage(remove.error ?? block.error)}
        </p>
      )}
      {isHost && <BlockedList roomId={roomId} />}
    </section>
  );
}

/** The host's list of blocked people, each with Unblock (B5, B6). Hidden while empty. */
function BlockedList({ roomId }: { roomId: RoomId }) {
  const blocks = useRoomBlocks(roomId, true);
  const unblock = useUnblockRoomMember(roomId);
  if (blocks.data === undefined || blocks.data.length === 0) {
    return null;
  }
  return (
    <div className="space-y-2 border-t border-line pt-4">
      <h4 className="text-[10px] tracking-[0.3em] text-muted uppercase">Blocked</h4>
      <ul aria-label="Blocked people" className="space-y-2">
        {blocks.data.map((entry) => (
          <li key={entry.userId} className="flex items-center justify-between gap-2 text-sm">
            <span className="text-muted">{entry.displayName}</span>
            <button
              type="button"
              disabled={unblock.isPending}
              onClick={() => {
                unblock.mutate(entry.userId);
              }}
              className="rounded-full border border-line px-3 py-1 text-xs transition hover:bg-surface-strong disabled:opacity-50"
            >
              {`Unblock ${entry.displayName}`}
            </button>
          </li>
        ))}
      </ul>
      {unblock.error !== null && (
        <p role="alert" className="text-sm text-danger">
          {roomErrorMessage(unblock.error)}
        </p>
      )}
    </div>
  );
}
