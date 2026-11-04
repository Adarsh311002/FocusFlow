import type { RoomListItem } from '@focus-flow/contracts';
import { Link } from '@tanstack/react-router';

import { useAuth } from '../auth/auth-context';
import { CopyCodeButton, HostBadge, PrivacyBadge } from './room-badges';
import { incomingKnocksFor, useKnockStore } from './room-live-store';
import { roomErrorMessage } from './room-messages';
import { useRoomList } from './room-queries';

function RoomItem({ room, isHost }: { room: RoomListItem; isHost: boolean }) {
  const waiting = useKnockStore(incomingKnocksFor(room.id)).length;
  return (
    <li aria-label={room.name} className="space-y-1 rounded border border-slate-200 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          to="/rooms/$roomId"
          params={{ roomId: room.id }}
          className="font-medium underline underline-offset-2"
        >
          {room.name}
        </Link>
        <PrivacyBadge isPrivate={room.isPrivate} />
        {isHost && <HostBadge />}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm text-slate-700">
        <CopyCodeButton code={room.code} />
        <span>{`${String(room.presentCount)} present`}</span>
        {isHost && room.isPrivate && waiting > 0 && (
          <span className="font-medium">{`${String(waiting)} waiting to join`}</span>
        )}
      </div>
    </li>
  );
}

/** The rooms the user is a member of, with the live presence count the server reports. */
export function RoomList() {
  const { user } = useAuth();
  const rooms = useRoomList();

  let body;
  if (rooms.isPending) {
    body = <p className="text-slate-600">Loading your rooms…</p>;
  } else if (rooms.data === undefined) {
    body = (
      <div className="space-y-2">
        <p role="alert" className="text-sm text-red-700">
          {roomErrorMessage(rooms.error)}
        </p>
        <button
          type="button"
          onClick={() => {
            void rooms.refetch();
          }}
          className="rounded border border-slate-300 px-3 py-1 text-sm"
        >
          Try again
        </button>
      </div>
    );
  } else if (rooms.data.length === 0) {
    body = (
      <p className="text-slate-600">
        You are not in any rooms yet. Create one or join with a code.
      </p>
    );
  } else {
    body = (
      <ul aria-label="My rooms" className="space-y-2">
        {rooms.data.map((room) => (
          <RoomItem key={room.id} room={room} isHost={room.hostId === user?.id} />
        ))}
      </ul>
    );
  }

  return (
    <section aria-labelledby="my-rooms-heading" className="space-y-3">
      <h3 id="my-rooms-heading" className="text-base font-semibold">
        My rooms
      </h3>
      {body}
      {rooms.data !== undefined && rooms.isError && (
        <p role="alert" className="text-sm text-red-700">
          {roomErrorMessage(rooms.error)}
        </p>
      )}
    </section>
  );
}
