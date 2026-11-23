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
    <li
      aria-label={room.name}
      className="group relative flex min-h-52 flex-col justify-between overflow-hidden rounded-[2rem] border border-line bg-surface p-6 shadow-card backdrop-blur-xl transition hover:-translate-y-1 hover:border-focus/40"
    >
      {/* A faint canopy in the corner of every clearing. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -top-10 -right-10 h-40 w-40 rounded-full bg-[radial-gradient(circle,rgb(111_143_99_/_0.25),transparent_70%)] transition group-hover:scale-125"
      />
      <div className="relative space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <PrivacyBadge isPrivate={room.isPrivate} />
          {isHost && <HostBadge />}
        </div>
        <Link
          to="/rooms/$roomId"
          params={{ roomId: room.id }}
          className="font-display block text-4xl leading-tight after:absolute after:inset-0 after:content-['']"
        >
          {room.name}
        </Link>
      </div>
      <div className="relative z-10 flex flex-wrap items-center gap-3 text-sm text-muted">
        <CopyCodeButton code={room.code} />
        <span className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={`h-2 w-2 rounded-full ${room.presentCount > 0 ? 'animate-pulse bg-ok' : 'bg-muted/40'}`}
          />
          {`${String(room.presentCount)} present`}
        </span>
        <span className="ml-auto">
          {isHost && room.isPrivate && waiting > 0 && (
            <span className="font-medium text-focus">{`${String(waiting)} waiting to join`}</span>
          )}
        </span>
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
    body = <p className="text-muted">Loading your rooms…</p>;
  } else if (rooms.data === undefined) {
    body = (
      <div className="space-y-2">
        <p role="alert" className="text-sm text-danger">
          {roomErrorMessage(rooms.error)}
        </p>
        <button
          type="button"
          onClick={() => {
            void rooms.refetch();
          }}
          className="rounded-full border border-line bg-surface px-4 py-1.5 transition hover:bg-surface-strong text-sm"
        >
          Try again
        </button>
      </div>
    );
  } else if (rooms.data.length === 0) {
    body = (
      <p className="text-muted">You are not in any rooms yet. Create one or join with a code.</p>
    );
  } else {
    body = (
      <ul aria-label="My rooms" className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
        {rooms.data.map((room) => (
          <RoomItem key={room.id} room={room} isHost={room.hostId === user?.id} />
        ))}
      </ul>
    );
  }

  return (
    <section aria-labelledby="my-rooms-heading" className="space-y-5">
      <h3 id="my-rooms-heading" className="font-display text-4xl">
        My rooms
      </h3>
      {body}
      {rooms.data !== undefined && rooms.isError && (
        <p role="alert" className="text-sm text-danger">
          {roomErrorMessage(rooms.error)}
        </p>
      )}
    </section>
  );
}
