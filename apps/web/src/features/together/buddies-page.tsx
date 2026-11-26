import type { BuddyRequestView, BuddyView } from '@focus-flow/contracts';
import { useId, useState } from 'react';

import { buttonClass, Eyebrow, INPUT_CLASS } from '../../ui/primitives';
import { formatDuration } from '../review/review-format';
import { avatarGlyph } from '../settings/settings-page';
import {
  useAcceptBuddy,
  useBuddies,
  useNudgeBuddy,
  useRemoveBuddy,
  useRequestBuddy,
} from './together-data';

// `/buddies` (BD5): your code to share, a field for someone else's, and the people who focus
// alongside you: whether they are in a session now, their streak and their week. Nothing
// about their tasks or notes is ever shown.

function Avatar({ person }: { readonly person: BuddyView | BuddyRequestView }) {
  return (
    <span
      aria-hidden="true"
      className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-surface-strong text-xl"
    >
      {avatarGlyph(person)}
    </span>
  );
}

function BuddyRow({ buddy }: { readonly buddy: BuddyView }) {
  const nudge = useNudgeBuddy();
  const remove = useRemoveBuddy();
  const [confirming, setConfirming] = useState(false);
  return (
    <li
      aria-label={buddy.displayName}
      className="flex flex-wrap items-center gap-4 rounded-2xl border border-line bg-surface p-4"
    >
      <Avatar person={buddy} />
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {buddy.displayName}
          {buddy.focusingNow && (
            <span className="ml-2 inline-flex items-center gap-1.5 text-xs text-ok">
              <span aria-hidden="true" className="h-2 w-2 animate-pulse rounded-full bg-ok" />
              Focusing now
            </span>
          )}
        </p>
        <p className="text-sm text-muted">
          {`${String(buddy.currentStreak)}-day streak · ${formatDuration(buddy.weekFocusedSeconds)} this week`}
        </p>
      </div>
      {!confirming ? (
        <div className="flex gap-2">
          <button
            type="button"
            disabled={nudge.isPending || nudge.isSuccess || buddy.focusingNow}
            title={buddy.focusingNow ? 'They are focusing right now' : undefined}
            onClick={() => {
              nudge.mutate(buddy.userId);
            }}
            className={buttonClass('ghost', 'px-4 py-1.5 text-xs')}
          >
            {nudge.isSuccess ? 'Nudged 🌿' : 'Nudge'}
          </button>
          <button
            type="button"
            onClick={() => {
              setConfirming(true);
            }}
            className="px-2 text-xs text-muted underline-offset-4 hover:text-ink hover:underline"
          >
            Remove
          </button>
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            type="button"
            disabled={remove.isPending}
            onClick={() => {
              remove.mutate(buddy.userId);
            }}
            className={buttonClass('ghost', 'px-4 py-1.5 text-xs')}
          >
            {`Yes, remove ${buddy.displayName}`}
          </button>
          <button
            type="button"
            onClick={() => {
              setConfirming(false);
            }}
            className="px-2 text-xs text-muted"
          >
            Cancel
          </button>
        </div>
      )}
      {nudge.isError && (
        <p role="alert" className="w-full text-xs text-warm">
          You nudged them recently. Give it an hour.
        </p>
      )}
    </li>
  );
}

function YourCode({ code }: { readonly code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-2 rounded-[2rem] border border-focus/30 bg-focus/10 p-6">
      <p className="text-sm text-muted">Your buddy code</p>
      <div className="flex flex-wrap items-center gap-3">
        <code className="font-display text-4xl tracking-[0.2em]">{code}</code>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => {
              setCopied(true);
            });
          }}
          className={buttonClass('ghost', 'px-4 py-1.5 text-xs')}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="text-sm text-muted">Share it with someone you want to focus alongside.</p>
    </div>
  );
}

function AddBuddy() {
  const request = useRequestBuddy();
  const [code, setCode] = useState('');
  const inputId = useId();
  return (
    <form
      className="space-y-2 rounded-[2rem] border border-line bg-surface p-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (code.trim() !== '') {
          request.mutate(code, {
            onSuccess: () => {
              setCode('');
            },
          });
        }
      }}
    >
      <label htmlFor={inputId} className="block text-sm text-muted">
        Their buddy code
      </label>
      <div className="flex gap-2">
        <input
          id={inputId}
          type="text"
          value={code}
          maxLength={12}
          autoComplete="off"
          placeholder="e.g. K7MQ2RXA"
          onChange={(event) => {
            setCode(event.target.value);
          }}
          className={`${INPUT_CLASS} uppercase`}
        />
        <button
          type="submit"
          disabled={request.isPending || code.trim() === ''}
          className={buttonClass('primary', 'shrink-0 px-5')}
        >
          Ask
        </button>
      </div>
      <p role="status" className="text-sm">
        {request.isError ? (
          <span className="text-danger">No one has that code. Check it and try again.</span>
        ) : request.data === 'buddies' ? (
          <span className="text-focus">You are buddies now.</span>
        ) : request.data === 'requested' ? (
          <span className="text-muted">Asked. You become buddies when they accept.</span>
        ) : null}
      </p>
    </form>
  );
}

export function BuddiesPage() {
  const buddies = useBuddies();
  const accept = useAcceptBuddy();
  const remove = useRemoveBuddy();
  const data = buddies.data;
  return (
    <div className="space-y-10">
      <div>
        <Eyebrow>( Focus buddies )</Eyebrow>
        <h2 className="font-display mt-3 text-6xl md:text-7xl">
          Not alone <em className="text-focus">in the forest.</em>
        </h2>
        <p className="mt-4 max-w-2xl text-muted">
          Buddies see your streak, your week and when you are focusing; never your tasks or notes. A
          nudge is a gentle hello, at most once an hour.
        </p>
      </div>
      {buddies.isPending && <p className="text-muted">Looking for your people…</p>}
      {data !== undefined && (
        <div className="grid items-start gap-10 lg:grid-cols-12">
          <div className="space-y-6 lg:col-span-7">
            {data.incoming.length > 0 && (
              <section aria-labelledby="buddy-requests" className="space-y-3">
                <h3 id="buddy-requests" className="font-display text-3xl">
                  Asking to join you
                </h3>
                <ul className="space-y-2">
                  {data.incoming.map((person) => (
                    <li
                      key={person.userId}
                      aria-label={person.displayName}
                      className="flex flex-wrap items-center gap-4 rounded-2xl border border-focus/40 bg-focus/10 p-4"
                    >
                      <Avatar person={person} />
                      <p className="min-w-0 flex-1 font-medium">{person.displayName}</p>
                      <button
                        type="button"
                        disabled={accept.isPending}
                        onClick={() => {
                          accept.mutate(person.userId);
                        }}
                        className={buttonClass('primary', 'px-4 py-1.5 text-xs')}
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        disabled={remove.isPending}
                        onClick={() => {
                          remove.mutate(person.userId);
                        }}
                        className="px-2 text-xs text-muted hover:text-ink"
                      >
                        Decline
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section aria-labelledby="buddy-list" className="space-y-3">
              <h3 id="buddy-list" className="font-display text-3xl">
                Your buddies
              </h3>
              {data.buddies.length === 0 ? (
                <p className="text-muted">
                  No buddies yet. Share your code, or ask with someone else’s.
                </p>
              ) : (
                <ul className="space-y-2">
                  {data.buddies.map((buddy) => (
                    <BuddyRow key={buddy.userId} buddy={buddy} />
                  ))}
                </ul>
              )}
            </section>
            {data.outgoing.length > 0 && (
              <section aria-labelledby="buddy-waiting" className="space-y-2">
                <h3 id="buddy-waiting" className="text-sm font-medium">
                  Waiting for an answer
                </h3>
                <ul className="space-y-1 text-sm">
                  {data.outgoing.map((person) => (
                    <li key={person.userId} className="flex items-center gap-3">
                      <span className="flex-1">{person.displayName}</span>
                      <button
                        type="button"
                        onClick={() => {
                          remove.mutate(person.userId);
                        }}
                        className="text-xs text-muted hover:text-ink"
                      >
                        Cancel
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
          <div className="space-y-6 lg:col-span-5">
            <YourCode code={data.code} />
            <AddBuddy />
          </div>
        </div>
      )}
    </div>
  );
}
