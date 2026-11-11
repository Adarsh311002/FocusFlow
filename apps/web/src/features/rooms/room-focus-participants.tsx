import type { RoomFocusParticipant, UserId } from '@focus-flow/contracts';
import { useEffect, useRef, useState } from 'react';

import { graceSecondsLeft } from './room-focus-grace';

/** A sentence about who just joined or left, for the screen-reader live region. */
function changeAnnouncement(
  before: readonly RoomFocusParticipant[],
  after: readonly RoomFocusParticipant[],
  selfId: UserId,
): string | null {
  const had = new Set(before.map((entry) => entry.userId));
  const has = new Set(after.map((entry) => entry.userId));
  const nameOf = (entry: RoomFocusParticipant): string =>
    entry.userId === selfId ? 'You' : entry.displayName;
  const joined = after.filter((entry) => !had.has(entry.userId)).map(nameOf);
  const left = before.filter((entry) => !has.has(entry.userId)).map(nameOf);
  const parts = [
    joined.length > 0 ? `${joined.join(', ')} joined the focus run.` : '',
    left.length > 0 ? `${left.join(', ')} left the focus run.` : '',
  ].filter((part) => part !== '');
  return parts.length === 0 ? null : parts.join(' ');
}

function StateLabel({ participant, nowMs }: { participant: RoomFocusParticipant; nowMs: number }) {
  if (participant.connected || participant.disconnectedAtMs === null) {
    return <span className="text-xs font-medium text-emerald-800">Connected</span>;
  }
  const left = graceSecondsLeft(participant.disconnectedAtMs, nowMs);
  return (
    // Not colour alone: a word and a marker. The countdown is a label; the server decides.
    <span className="text-xs font-medium text-amber-800">
      <span aria-hidden="true">… </span>
      {left > 0
        ? `Reconnecting — about ${String(left)} s left before their session ends`
        : 'Reconnecting — waiting for the server'}
    </span>
  );
}

/**
 * Everyone who opted into the current run (D11). Connected, or reconnecting with the grace
 * left (D19, display only). Changes are announced politely; the ticking countdown is not.
 */
export function RoomFocusParticipants({
  participants,
  selfId,
  nowMs,
  stale,
}: {
  participants: readonly RoomFocusParticipant[];
  selfId: UserId;
  nowMs: number;
  /** The list comes from the last REST read, not from the live room. */
  stale: boolean;
}) {
  const previous = useRef(participants);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    const message = changeAnnouncement(previous.current, participants, selfId);
    previous.current = participants;
    if (message !== null) {
      setAnnouncement(message);
    }
  }, [participants, selfId]);

  const count = participants.length;
  return (
    <div className="space-y-2">
      <h4 id="room-focus-participants-heading" className="text-sm font-medium">
        {count === 1 ? '1 person focusing together' : `${String(count)} people focusing together`}
      </h4>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {count === 0 ? (
        <p className="text-sm text-slate-600">No one has joined this focus run yet.</p>
      ) : (
        <ul aria-labelledby="room-focus-participants-heading" className="space-y-1">
          {participants.map((participant) => (
            <li
              key={participant.userId}
              className="flex flex-wrap items-baseline gap-x-3 rounded border border-slate-200 px-2 py-1 text-sm"
            >
              <span className="font-medium">
                {participant.displayName}
                {participant.userId === selfId && (
                  <span className="font-normal text-slate-600"> (you)</span>
                )}
              </span>
              <StateLabel participant={participant} nowMs={nowMs} />
            </li>
          ))}
        </ul>
      )}
      {stale && count > 0 && (
        <p className="text-xs text-slate-500">
          Last known list — it will update when the room is live again.
        </p>
      )}
    </div>
  );
}
