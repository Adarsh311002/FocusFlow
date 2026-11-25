import {
  type FocusSessionId,
  listParkedThoughtsResponseSchema,
  parkedThoughtPath,
  parkedThoughtPaths,
  parkedThoughtResponseSchema,
  parkedThoughtToTaskResponseSchema,
  type ParkedThoughtView,
  TASK_TITLE_MAX_LENGTH,
} from '@focus-flow/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { buttonClass, INPUT_CLASS } from '../../ui/primitives';
import { authedApiRequest, authedApiRequestNoContent } from '../auth/auth-client';
import { useAuth } from '../auth/auth-context';
import { useCachedCurrentFocusSession, useLastEndedFocusSession } from '../focus/focus-queries';
import { taskKeys } from '../tasks/task-queries';

// Parked thoughts (PT5): note a distraction during a session without leaving it, then turn
// it into a task or let it go once the session is over. TanStack Query only; the server
// list is the truth and every change refetches it.

const thoughtKeys = { all: (userId: string) => ['parked-thoughts', userId] as const };

function useUserId(): string {
  return useAuth().user?.id ?? 'signed-out';
}

export function useParkedThoughts() {
  const userId = useUserId();
  return useQuery({
    queryKey: thoughtKeys.all(userId),
    queryFn: async () =>
      (await authedApiRequest(parkedThoughtPaths.collection, listParkedThoughtsResponseSchema))
        .thoughts,
    enabled: userId !== 'signed-out',
  });
}

function useThoughtMutation<Variables, Result>(
  mutationFn: (variables: Variables) => Promise<Result>,
  alsoTasks = false,
) {
  const userId = useUserId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: thoughtKeys.all(userId) }),
        alsoTasks ? queryClient.invalidateQueries({ queryKey: taskKeys.all(userId) }) : null,
      ]);
    },
  });
}

/** A small field inside a running session: Enter parks the thought and clears the field. */
export function ParkThought({ sessionId }: { readonly sessionId: FocusSessionId }) {
  const [text, setText] = useState('');
  const inputId = useId();
  const thoughts = useParkedThoughts();
  const park = useThoughtMutation((body: string) =>
    authedApiRequest(parkedThoughtPaths.collection, parkedThoughtResponseSchema, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body, sessionId }),
    }),
  );
  const parkedHere = (thoughts.data ?? []).filter((thought) => thought.sessionId === sessionId);

  return (
    <form
      className="mx-auto max-w-sm space-y-1.5 text-left"
      onSubmit={(event) => {
        event.preventDefault();
        const body = text.trim();
        if (body !== '' && !park.isPending) {
          park.mutate(body, {
            onSuccess: () => {
              setText('');
            },
          });
        }
      }}
    >
      <label htmlFor={inputId} className="block text-xs text-muted">
        Something pulling at you? Park it and keep going.
      </label>
      <input
        id={inputId}
        type="text"
        value={text}
        maxLength={TASK_TITLE_MAX_LENGTH}
        autoComplete="off"
        placeholder="e.g. Email Ravi about the invoice"
        onChange={(event) => {
          setText(event.target.value);
        }}
        className={INPUT_CLASS}
      />
      <p role="status" className="text-xs text-muted">
        {park.isError
          ? 'That did not save. Try again.'
          : parkedHere.length === 0
            ? 'Press Enter to park it. It waits for you after the session.'
            : `${String(parkedHere.length)} parked for after this session.`}
      </p>
    </form>
  );
}

/** One thought with its two ways out (PT3, PT4). */
function ThoughtRow({ thought }: { readonly thought: ParkedThoughtView }) {
  const toTask = useThoughtMutation(
    () =>
      authedApiRequest(
        parkedThoughtPath(parkedThoughtPaths.toTask, thought.id),
        parkedThoughtToTaskResponseSchema,
        { method: 'POST' },
      ),
    true,
  );
  const dismiss = useThoughtMutation(() =>
    authedApiRequestNoContent(parkedThoughtPath(parkedThoughtPaths.item, thought.id), {
      method: 'DELETE',
    }),
  );
  const busy = toTask.isPending || dismiss.isPending;
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm">
      <span className="min-w-0 flex-1 break-words">{thought.body}</span>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          toTask.mutate(undefined);
        }}
        className={buttonClass('ghost', 'px-3 py-1 text-xs')}
      >
        Make it a task
      </button>
      <button
        type="button"
        disabled={busy}
        aria-label={`Let “${thought.body}” go`}
        onClick={() => {
          dismiss.mutate(undefined);
        }}
        className="px-2 text-xs text-muted underline-offset-4 hover:text-ink hover:underline"
      >
        Let it go
      </button>
      {(toTask.isError || dismiss.isError) && (
        <p role="alert" className="w-full text-xs text-danger">
          That did not save. Try again.
        </p>
      )}
    </li>
  );
}

/**
 * The thoughts waiting for a decision. With `sessionId`, only those parked during that
 * session (after it ends); without, every open one (the dashboard).
 */
export function ParkedThoughts({
  sessionId,
  title = 'Parked thoughts',
}: {
  readonly sessionId?: FocusSessionId;
  readonly title?: string;
}) {
  const thoughts = useParkedThoughts();
  const running = useCachedCurrentFocusSession();
  const lastEnded = useLastEndedFocusSession();
  const headingId = useId();
  // The general list leaves out what has its own place: the running session's thoughts wait
  // for its end, and the ended session's are shown in its notice.
  const elsewhere = new Set([running?.id, lastEnded?.id].filter((id) => id !== undefined));
  const shown = (thoughts.data ?? []).filter((thought) =>
    sessionId === undefined
      ? thought.sessionId === null || !elsewhere.has(thought.sessionId)
      : thought.sessionId === sessionId,
  );
  if (shown.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <h4 id={headingId} className="text-sm font-medium">
        {`${title} (${String(shown.length)})`}
      </h4>
      <ul aria-labelledby={headingId} className="space-y-1.5">
        {shown.map((thought) => (
          <ThoughtRow key={thought.id} thought={thought} />
        ))}
      </ul>
    </section>
  );
}
