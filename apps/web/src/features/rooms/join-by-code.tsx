import { roomCodeInputSchema, type RoomLookupResponse } from '@focus-flow/contracts';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';

import { useServerNowMs } from '../focus/use-server-now';
import { useRealtimeClient } from '../realtime/realtime-provider';
import { PrivacyBadge } from './room-badges';
import { getRoomLiveStore, useKnockStore } from './room-live-store';
import {
  INVALID_ROOM_CODE,
  isApiErrorCode,
  roomErrorMessage,
  socketErrorMessage,
} from './room-messages';
import { useJoinPublicRoom, useLookupRoom } from './room-queries';

type Preview = RoomLookupResponse['room'];

/** A private room: ask the host over the socket, then wait for the answer (M7, D20). */
function KnockRequest({ room, onRecheck }: { room: Preview; onRecheck: () => void }) {
  const client = useRealtimeClient();
  const navigate = useNavigate();
  const outgoing = useKnockStore((state) => state.outgoing[room.id]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useServerNowMs();
  const expiredHandled = useRef(false);

  const waitingUntil = outgoing?.status === 'waiting' ? outgoing.expiresAtMs : null;

  // The server does not announce an expiry; the requester re-checks access instead (the
  // host may have answered just as the knock ran out).
  useEffect(() => {
    if (waitingUntil === null) {
      expiredHandled.current = false;
      return;
    }
    if (now >= waitingUntil && !expiredHandled.current) {
      expiredHandled.current = true;
      useKnockStore.getState().outgoingResolved(room.id, 'expired');
      onRecheck();
    }
  }, [now, waitingUntil, room.id, onRecheck]);

  // Approved, wherever the event found the user: the room is theirs now.
  const approved = outgoing?.status === 'approved';
  useEffect(() => {
    if (approved) {
      useKnockStore.getState().clearOutgoing(room.id);
      getRoomLiveStore(room.id).getState().reset();
      void navigate({ to: '/rooms/$roomId', params: { roomId: room.id } });
    }
  }, [approved, room.id, navigate]);

  async function ask(): Promise<void> {
    setBusy(true);
    setError(null);
    const ack = await client.knockRoom(room.id);
    setBusy(false);
    if (ack.ok) {
      useKnockStore.getState().outgoingWaiting(room.id, ack.expiresAtMs);
      return;
    }
    setError(socketErrorMessage(ack));
    if (ack.error.code === 'ALREADY_MEMBER' || ack.error.code === 'NOT_PRIVATE') {
      onRecheck();
    }
  }

  async function cancel(): Promise<void> {
    setBusy(true);
    setError(null);
    const ack = await client.cancelKnock(room.id);
    setBusy(false);
    if (ack.ok || (ack.error.code !== 'OFFLINE' && ack.error.code !== 'TIMEOUT')) {
      useKnockStore.getState().clearOutgoing(room.id);
    } else {
      setError(socketErrorMessage(ack));
    }
  }

  return (
    <div className="space-y-2">
      {outgoing?.status === 'waiting' && (
        <>
          <p role="status" aria-live="polite" className="text-sm">
            Waiting for the host to answer…
          </p>
          <p className="text-xs text-slate-600">
            {`The request expires in ${String(Math.max(0, Math.ceil((outgoing.expiresAtMs - now) / 1000)))} seconds.`}
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void cancel();
            }}
            className="rounded border border-slate-300 px-3 py-1 text-sm disabled:opacity-50"
          >
            Cancel request
          </button>
        </>
      )}
      {outgoing?.status === 'rejected' && (
        <p role="status" aria-live="polite" className="text-sm text-red-700">
          The host declined your request.
        </p>
      )}
      {outgoing?.status === 'expired' && (
        <p role="status" aria-live="polite" className="text-sm text-slate-700">
          Your request expired before the host answered.
        </p>
      )}
      {outgoing?.status !== 'waiting' && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void ask();
          }}
          className="rounded bg-slate-900 px-3 py-1 text-white disabled:opacity-50"
        >
          {busy
            ? 'Asking…'
            : outgoing?.status === 'rejected' || outgoing?.status === 'expired'
              ? 'Try again'
              : 'Ask to join'}
        </button>
      )}
      {error !== null && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

function PublicJoin({ room, onRecheck }: { room: Preview; onRecheck: () => void }) {
  const navigate = useNavigate();
  const join = useJoinPublicRoom();

  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={join.isPending}
        onClick={() => {
          join.mutate(room.id, {
            onSuccess: () => {
              void navigate({ to: '/rooms/$roomId', params: { roomId: room.id } });
            },
            onError: (cause) => {
              // The room became private meanwhile: show what is true now.
              if (isApiErrorCode(cause, 'KNOCK_REQUIRED')) {
                onRecheck();
              }
            },
          });
        }}
        className="rounded bg-slate-900 px-3 py-1 text-white disabled:opacity-50"
      >
        {join.isPending ? 'Joining…' : 'Join room'}
      </button>
      {join.error !== null && (
        <p role="alert" className="text-sm text-red-700">
          {roomErrorMessage(join.error)}
        </p>
      )}
    </div>
  );
}

function LookupCard({ result, onRecheck }: { result: RoomLookupResponse; onRecheck: () => void }) {
  const { room } = result;
  return (
    <div
      role="group"
      aria-label="Room found"
      className="space-y-2 rounded border border-slate-200 p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{room.name}</span>
        <PrivacyBadge isPrivate={room.isPrivate} />
      </div>
      {(result.access === 'host' || result.access === 'member') && (
        <Link
          to="/rooms/$roomId"
          params={{ roomId: room.id }}
          className="inline-block rounded bg-slate-900 px-3 py-1 text-white"
        >
          Open room
        </Link>
      )}
      {result.access === 'can_join' && <PublicJoin room={room} onRecheck={onRecheck} />}
      {result.access === 'must_knock' && <KnockRequest room={room} onRecheck={onRecheck} />}
    </div>
  );
}

/**
 * Finds a room by its code and offers the one action the server says is possible: open
 * (host or member), join (public) or ask the host (private). Case and spaces are forgiven.
 */
export function JoinByCode() {
  const [code, setCode] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [result, setResult] = useState<RoomLookupResponse | null>(null);
  const lookup = useLookupRoom();

  function search(raw: string): void {
    const parsed = roomCodeInputSchema.safeParse(raw);
    if (!parsed.success) {
      setInvalid(true);
      setResult(null);
      return;
    }
    setInvalid(false);
    lookup.mutate(parsed.data, {
      onSuccess: setResult,
      onError: () => {
        setResult(null);
      },
    });
  }

  const error = invalid
    ? INVALID_ROOM_CODE
    : lookup.error === null
      ? null
      : roomErrorMessage(lookup.error);

  return (
    <section aria-labelledby="join-heading" className="space-y-3">
      <h3 id="join-heading" className="text-base font-semibold">
        Join with a code
      </h3>
      <form
        noValidate
        aria-label="Join a room with a code"
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          search(code);
        }}
      >
        <label htmlFor="room-code" className="block text-sm font-medium">
          Room code
        </label>
        <div className="flex gap-2">
          <input
            id="room-code"
            name="code"
            type="text"
            autoComplete="off"
            autoCapitalize="characters"
            value={code}
            onChange={(event) => {
              setCode(event.target.value);
            }}
            className="w-40 rounded border border-slate-300 px-2 py-1 font-mono uppercase"
          />
          <button
            type="submit"
            disabled={lookup.isPending}
            className="rounded border border-slate-300 px-3 py-1 disabled:opacity-50"
          >
            {lookup.isPending ? 'Looking…' : 'Find room'}
          </button>
        </div>
        {error !== null && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
      </form>
      {result !== null && (
        // The card stays while its access is re-read, so a notice about the old answer
        // (declined, expired) does not vanish while the new one is fetched.
        <LookupCard
          result={result}
          onRecheck={() => {
            search(result.room.code);
          }}
        />
      )}
    </section>
  );
}
