import type { RoomId } from '@focus-flow/contracts';

import { useServerNowMs } from '../focus/use-server-now';
import { incomingKnocksFor, useKnockStore } from './room-live-store';
import { roomErrorMessage } from './room-messages';
import { useAnswerKnock } from './room-queries';

/**
 * Host only: people asking to join a private room. Entries come from the join snapshot and
 * `room:knock:received`, and leave on `room:knock:removed`; expiry is not announced (M7), so
 * an entry whose time has passed on the synced server clock is simply no longer shown.
 */
export function KnockList({ roomId }: { roomId: RoomId }) {
  const knocks = useKnockStore(incomingKnocksFor(roomId));
  const now = useServerNowMs();
  const answer = useAnswerKnock(roomId);

  const open = knocks.filter((knock) => knock.expiresAtMs > now);

  return (
    <section aria-labelledby="knocks-heading" className="space-y-2">
      <h3 id="knocks-heading" className="font-display text-3xl">
        Join requests
      </h3>
      {open.length === 0 ? (
        <p className="text-sm text-muted">No one is waiting to join.</p>
      ) : (
        <ul aria-label="Join requests" className="space-y-2">
          {open.map((knock) => (
            <li
              key={knock.userId}
              aria-label={knock.displayName}
              className="flex flex-wrap items-center gap-2"
            >
              <span className="font-medium">{knock.displayName}</span>
              <span className="text-xs text-muted">
                {`expires in ${String(Math.max(0, Math.ceil((knock.expiresAtMs - now) / 1000)))} s`}
              </span>
              <button
                type="button"
                disabled={answer.isPending}
                onClick={() => {
                  answer.reset();
                  answer.mutate({ userId: knock.userId, answer: 'approve' });
                }}
                className="rounded-full bg-focus px-4 py-2 text-sm font-medium text-focus-ink shadow-glow transition hover:brightness-110 disabled:opacity-50"
              >
                {`Approve ${knock.displayName}`}
              </button>
              <button
                type="button"
                disabled={answer.isPending}
                onClick={() => {
                  answer.reset();
                  answer.mutate({ userId: knock.userId, answer: 'reject' });
                }}
                className="rounded-full border border-line bg-surface px-4 py-1.5 transition hover:bg-surface-strong text-sm disabled:opacity-50"
              >
                {`Reject ${knock.displayName}`}
              </button>
            </li>
          ))}
        </ul>
      )}
      {answer.error !== null && (
        <p role="alert" className="text-sm text-danger">
          {roomErrorMessage(answer.error)}
        </p>
      )}
    </section>
  );
}
