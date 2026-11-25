import type { FocusRunId, RoomFocusParticipant, RoomId, UserId } from '@focus-flow/contracts';
import { useEffect, useRef, useState } from 'react';

import { CHECK_IN_LABEL } from '../focus/session-check-in';
import { useRoomLive } from './room-live-store';

// "Who finished" (RI4): once a focus run is over, the room sees how it went for each person
// who joined it, as they check in. The list is the run's last known participants on this
// page; outcomes come from `room:focus:check-in` events (RI3). Nothing here is stored.

type Run = { readonly runId: FocusRunId; readonly participants: readonly RoomFocusParticipant[] };

export function RoomLastRun({
  roomId,
  selfId,
  runId,
  participants,
}: {
  roomId: RoomId;
  selfId: UserId;
  /** The run shown now (`null` in a break). */
  runId: FocusRunId | null;
  participants: readonly RoomFocusParticipant[];
}) {
  const checkIns = useRoomLive(roomId, (state) => state.focusCheckIns);
  const latest = useRef<Run | null>(null);
  const [lastRun, setLastRun] = useState<Run | null>(null);

  useEffect(() => {
    const previous = latest.current;
    if (previous !== null && previous.runId !== runId && previous.participants.length > 0) {
      setLastRun(previous);
    }
    latest.current = runId === null ? null : { runId, participants };
  }, [runId, participants]);

  if (lastRun === null || lastRun.runId === runId) {
    return null;
  }
  const outcomeOf = (userId: UserId) =>
    checkIns.find((entry) => entry.focusRunId === lastRun.runId && entry.userId === userId)
      ?.outcome;

  return (
    <div className="space-y-2">
      <h4 id="room-last-run-heading" className="text-sm font-medium">
        How the last run went
      </h4>
      <ul aria-labelledby="room-last-run-heading" className="space-y-1">
        {lastRun.participants.map((participant) => {
          const outcome = outcomeOf(participant.userId);
          return (
            <li
              key={participant.userId}
              className="flex flex-wrap items-baseline gap-x-3 rounded border border-line px-2 py-1 text-sm"
            >
              <span className="font-medium">
                {participant.userId === selfId ? 'You' : participant.displayName}
              </span>
              <span className={outcome === 'done' ? 'text-focus' : 'text-muted'}>
                {outcome === undefined
                  ? 'not checked in yet'
                  : `${CHECK_IN_LABEL[outcome]}${outcome === 'done' ? ' ✓' : ''}`}
              </span>
              {participant.intention !== null && (
                <span className="w-full text-muted italic">{participant.intention}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
