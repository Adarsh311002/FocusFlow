import { type RoomId, roomIdSchema, type RoomView } from '@focus-flow/contracts';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useState } from 'react';

import { ApiError } from '../../lib/api-client';
import { useAuth } from '../auth/auth-context';
import { ConnectionStatus } from '../realtime/connection-status';
import { useRealtimeClient, useRealtimeStatus } from '../realtime/realtime-provider';
import { ChatPanel } from './chat-panel';
import { KnockList } from './knock-list';
import { MemberList } from './member-list';
import { CopyCodeButton, HostBadge, PrivacyBadge } from './room-badges';
import { RoomFocusPanel } from './room-focus-panel';
import { getRoomLiveStore, useRoomLive } from './room-live-store';
import { roomErrorMessage, socketErrorMessage } from './room-messages';
import { useForgetRoom, useLeaveRoomPermanently, useRoom } from './room-queries';
import { TimerPanel } from './timer-panel';
import { TimerSettingsForm } from './timer-settings-form';
import { useRoomSession } from './use-room-session';
import { useTimerCommands } from './use-timer-commands';

function BackToRooms() {
  return (
    <Link to="/rooms" className="inline-block rounded border border-slate-300 px-3 py-1 text-sm">
      Back to my rooms
    </Link>
  );
}

/** A heading and a message for the cases where the room cannot be shown at all. */
function Unavailable({ title, message }: { title: string; message: string }) {
  return (
    <section aria-labelledby="room-heading" className="max-w-xl space-y-3">
      <h2 id="room-heading" className="text-base font-semibold">
        {title}
      </h2>
      <p role="status" aria-live="polite">
        {message}
      </p>
      <BackToRooms />
    </section>
  );
}

/** Where the room stands: offline, rejoining, joined, or refused. */
function RoomConnection({ roomId, rejoin }: { roomId: RoomId; rejoin: () => void }) {
  const realtime = useRealtimeStatus();
  const joinStatus = useRoomLive(roomId, (state) => state.joinStatus);
  const joinError = useRoomLive(roomId, (state) => state.joinError);

  let text: string;
  if (realtime === 'idle') {
    text = 'You are offline. Live updates and chat are paused.';
  } else if (realtime !== 'connected') {
    text = 'Reconnecting — the room will be rejoined automatically.';
  } else if (joinStatus === 'joined') {
    text = 'You are in the room.';
  } else if (joinStatus === 'failed') {
    text = joinError ?? 'The room could not be joined.';
  } else {
    text = 'Joining the room…';
  }

  return (
    <div className="space-y-1">
      <ConnectionStatus />
      <p role="status" aria-live="polite" className="text-sm">
        {text}
      </p>
      {realtime === 'connected' && joinStatus === 'failed' && (
        <button
          type="button"
          onClick={rejoin}
          className="rounded border border-slate-300 px-3 py-1 text-sm"
        >
          Try joining again
        </button>
      )}
    </div>
  );
}

/** "Leave room" (presence only, membership stays) and, for non-hosts, "Leave permanently". */
function RoomActions({
  room,
  isHost,
  onLeaving,
}: {
  room: RoomView;
  isHost: boolean;
  onLeaving: () => void;
}) {
  const client = useRealtimeClient();
  const navigate = useNavigate();
  const leavePermanently = useLeaveRoomPermanently();
  const forgetRoom = useForgetRoom();
  const [leaving, setLeaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function leave(): Promise<void> {
    setLeaving(true);
    setError(null);
    const ack = await client.leaveRoom(room.id);
    // Not being in the room, or having no connection at all, already means "not present".
    if (ack.ok || ack.error.code === 'NOT_JOINED' || ack.error.code === 'OFFLINE') {
      onLeaving();
      getRoomLiveStore(room.id).getState().reset();
      await navigate({ to: '/rooms' });
      return;
    }
    setLeaving(false);
    setError(socketErrorMessage(ack));
  }

  /**
   * Awaited here rather than passed to `mutate` as a per-call `onSuccess`: the server's own
   * `room:member:removed` event can arrive before the DELETE answer and replace the room page,
   * which unmounts this button, and TanStack Query drops per-call callbacks of an unmounted
   * observer. A promise continuation does not depend on the component staying mounted. A
   * failure is shown through `leavePermanently.error`.
   */
  async function leaveForGood(): Promise<void> {
    try {
      await leavePermanently.mutateAsync(room.id);
    } catch {
      return;
    }
    onLeaving();
    await navigate({ to: '/rooms' });
    forgetRoom(room.id);
  }

  const shownError =
    error ?? (leavePermanently.error === null ? null : roomErrorMessage(leavePermanently.error));

  return (
    <section aria-label="Leaving" className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={leaving || leavePermanently.isPending}
          onClick={() => {
            void leave();
          }}
          className="rounded border border-slate-300 px-3 py-1 disabled:opacity-50"
        >
          {leaving ? 'Leaving…' : 'Leave room'}
        </button>
        {!isHost && !confirming && (
          <button
            type="button"
            onClick={() => {
              leavePermanently.reset();
              setConfirming(true);
            }}
            className="rounded border border-red-700 px-3 py-1 text-red-700"
          >
            Leave permanently
          </button>
        )}
      </div>
      {!isHost && confirming && (
        <div role="group" aria-label="Confirm leaving permanently" className="space-y-2 text-sm">
          <p>
            {`Leave ${room.name} permanently? It will disappear from your rooms. A private room needs the host's approval to join again.`}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={leavePermanently.isPending}
              onClick={() => {
                void leaveForGood();
              }}
              className="rounded bg-red-700 px-3 py-1 text-white disabled:opacity-50"
            >
              {leavePermanently.isPending ? 'Leaving…' : 'Yes, leave permanently'}
            </button>
            <button
              type="button"
              disabled={leavePermanently.isPending}
              onClick={() => {
                setConfirming(false);
              }}
              className="rounded border border-slate-300 px-3 py-1 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {shownError !== null && (
        <p role="alert" className="text-sm text-red-700">
          {shownError}
        </p>
      )}
    </section>
  );
}

function RoomContent({ room, onLeaving }: { room: RoomView; onLeaving: () => void }) {
  const { user } = useAuth();
  const realtime = useRealtimeStatus();
  const joined = useRoomLive(room.id, (state) => state.joinStatus === 'joined');
  const { rejoin, refresh } = useRoomSession(room.id, true);
  const timerCommands = useTimerCommands(room.id, refresh);

  if (user === null) {
    return null;
  }
  const isHost = room.hostId === user.id;

  return (
    <section aria-labelledby="room-heading" className="max-w-xl space-y-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="room-heading" className="text-base font-semibold">
            {room.name}
          </h2>
          <PrivacyBadge isPrivate={room.isPrivate} />
          {isHost && <HostBadge />}
        </div>
        <CopyCodeButton code={room.code} />
        <RoomConnection roomId={room.id} rejoin={rejoin} />
      </header>

      <TimerPanel roomId={room.id} isHost={isHost} commands={timerCommands} rejoin={rejoin} />

      <RoomFocusPanel roomId={room.id} currentUserId={user.id} refresh={refresh} />

      <MemberList roomId={room.id} isHost={isHost} currentUserId={user.id} />

      {isHost && room.isPrivate && <KnockList roomId={room.id} />}
      {isHost && (
        <TimerSettingsForm
          roomId={room.id}
          settings={room.timerSettings}
          commands={timerCommands}
        />
      )}

      <ChatPanel
        roomId={room.id}
        currentUserId={user.id}
        canSend={realtime === 'connected' && joined}
      />

      <RoomActions room={room} isHost={isHost} onLeaving={onLeaving} />
    </section>
  );
}

function RoomLoader({ roomId }: { roomId: RoomId }) {
  const room = useRoom(roomId);
  const removed = useRoomLive(roomId, (state) => state.removed);
  const joinStatus = useRoomLive(roomId, (state) => state.joinStatus);
  // Set once the user leaves on purpose, so the echo of their own departure is not shown to
  // them as news.
  const [leaving, setLeaving] = useState(false);

  if (removed !== null && !leaving) {
    return (
      <Unavailable
        title="You are no longer in this room"
        message={
          removed === 'removed'
            ? 'You were removed from this room by the host.'
            : 'You left this room.'
        }
      />
    );
  }
  if (room.isPending) {
    return (
      <p role="status" aria-live="polite" className="text-slate-600">
        Loading the room…
      </p>
    );
  }
  if (room.data === undefined) {
    if (room.error instanceof ApiError && room.error.code === 'ROOM_NOT_FOUND') {
      return (
        <Unavailable
          title="Room not available"
          message="This room could not be found, or you are not a member of it."
        />
      );
    }
    return (
      <section aria-labelledby="room-heading" className="max-w-xl space-y-3">
        <h2 id="room-heading" className="text-base font-semibold">
          Room
        </h2>
        <p role="alert" className="text-sm text-red-700">
          {roomErrorMessage(room.error)}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              void room.refetch();
            }}
            className="rounded border border-slate-300 px-3 py-1 text-sm"
          >
            Try again
          </button>
          <BackToRooms />
        </div>
      </section>
    );
  }
  if (joinStatus === 'not_member') {
    return (
      <Unavailable
        title="You are not a member"
        message="You are not a member of this room. Join it with its code, or ask the host to let you in."
      />
    );
  }
  return (
    <RoomContent
      room={room.data}
      onLeaving={() => {
        setLeaving(true);
      }}
    />
  );
}

/** `/rooms/$roomId`: one room, live. Guarded by the route (router.tsx). */
export function RoomPage() {
  const { roomId } = useParams({ strict: false });
  const parsed = roomIdSchema.safeParse(roomId);
  if (!parsed.success) {
    return <Unavailable title="Room not available" message="This is not a valid room address." />;
  }
  return <RoomLoader key={parsed.data} roomId={parsed.data} />;
}
