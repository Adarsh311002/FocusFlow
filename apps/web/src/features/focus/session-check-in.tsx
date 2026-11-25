import {
  CHECK_IN_NOTE_MAX_LENGTH,
  type CheckInOutcome,
  type FocusSessionView,
  TASK_TITLE_MAX_LENGTH,
} from '@focus-flow/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { buttonClass, INPUT_CLASS } from '../../ui/primitives';
import { useAuth } from '../auth/auth-context';
import { useAdoptIntention } from '../intention/intention-queries';
import { focusSessionKeys } from '../review/review-queries';
import { taskKeys } from '../tasks/task-queries';
import { checkInFocusSession } from './focus-client';
import { useReplaceLastEnded } from './focus-queries';

// The session check-in (CI6): once a session has ended, the user says how it went. "Done"
// also finishes the task on the server (CI3); "Got stuck" offers a smaller next step, which
// becomes the current task. The browser decides nothing about the session itself.

const OUTCOMES: readonly { outcome: CheckInOutcome; label: string; hint: string }[] = [
  { outcome: 'done', label: 'Done', hint: 'Finished it' },
  { outcome: 'progress', label: 'Made progress', hint: 'Keep going next time' },
  { outcome: 'stuck', label: 'Got stuck', hint: 'Find a smaller step' },
];

export const CHECK_IN_LABEL: Readonly<Record<CheckInOutcome, string>> = {
  done: 'Done',
  progress: 'Made progress',
  stuck: 'Got stuck',
};

function useCheckIn() {
  const { user, reloadUser } = useAuth();
  const queryClient = useQueryClient();
  const replaceLastEnded = useReplaceLastEnded();
  const userId = user?.id ?? 'signed-out';
  return useMutation({
    mutationFn: (variables: { session: FocusSessionView; outcome: CheckInOutcome; note: string }) =>
      checkInFocusSession(variables.session.id, {
        outcome: variables.outcome,
        note: variables.note,
      }),
    onSuccess: async (updated, variables) => {
      replaceLastEnded(updated);
      // "Done" may have finished the task and cleared it as the current one (T3).
      if (variables.outcome === 'done' && variables.session.task !== null) {
        await reloadUser();
      }
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: focusSessionKeys.all(userId) }),
        queryClient.invalidateQueries({ queryKey: taskKeys.all(userId) }),
      ]);
    },
  });
}

/** Asks how an ended session went; shows the answer once given. */
export function SessionCheckIn({ session }: { readonly session: FocusSessionView }) {
  const checkIn = useCheckIn();
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState(false);
  const noteId = useId();
  if (session.status === 'in_progress') {
    return null;
  }
  const recorded = session.checkIn;
  const title = session.task?.title ?? null;

  if (recorded !== null && !editing) {
    return (
      <div className="space-y-3">
        <p className="text-sm">
          <span className="text-muted">You said: </span>
          <strong className="font-medium">{CHECK_IN_LABEL[recorded.outcome]}</strong>
          {recorded.note === null ? '' : ` · “${recorded.note}”`}
          <button
            type="button"
            onClick={() => {
              setEditing(true);
            }}
            className="ml-3 text-xs text-muted underline underline-offset-4 hover:text-ink"
          >
            Change
          </button>
        </p>
        {recorded.outcome === 'stuck' && <SmallerStep />}
      </div>
    );
  }

  return (
    <fieldset className="space-y-3" disabled={checkIn.isPending}>
      <legend className="font-display text-2xl">
        {title === null ? 'How did it go?' : `Did you finish “${title}”?`}
      </legend>
      <div role="group" aria-label="How it went" className="flex flex-wrap gap-2">
        {OUTCOMES.map((option) => (
          <button
            key={option.outcome}
            type="button"
            title={option.hint}
            onClick={() => {
              checkIn.mutate(
                { session, outcome: option.outcome, note },
                {
                  onSuccess: () => {
                    setEditing(false);
                  },
                },
              );
            }}
            className={buttonClass(option.outcome === 'done' ? 'primary' : 'ghost', 'px-4 py-2')}
          >
            {option.label}
          </button>
        ))}
      </div>
      <div>
        <label htmlFor={noteId} className="sr-only">
          A note for later (optional)
        </label>
        <input
          id={noteId}
          type="text"
          value={note}
          maxLength={CHECK_IN_NOTE_MAX_LENGTH}
          placeholder="A note for later (optional)"
          onChange={(event) => {
            setNote(event.target.value);
          }}
          className={INPUT_CLASS}
        />
      </div>
      {checkIn.isError && (
        <p role="alert" className="text-sm text-danger">
          That did not save. Check your connection and try again.
        </p>
      )}
    </fieldset>
  );
}

/** After "Got stuck": name a smaller next step; it becomes the current task. */
function SmallerStep() {
  const adopt = useAdoptIntention();
  const [text, setText] = useState('');
  const inputId = useId();
  if (adopt.isSuccess) {
    return (
      <p role="status" className="text-sm text-muted">
        Next step set: <strong className="font-medium text-ink">{adopt.data.title}</strong>. It is
        your current task now.
      </p>
    );
  }
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const title = text.trim();
        if (title !== '') {
          adopt.mutate(title);
        }
      }}
    >
      <div className="min-w-0 flex-1">
        <label htmlFor={inputId} className="mb-1 block text-xs text-muted">
          What is one smaller next step?
        </label>
        <input
          id={inputId}
          type="text"
          value={text}
          maxLength={TASK_TITLE_MAX_LENGTH}
          placeholder="e.g. Outline just the first section"
          onChange={(event) => {
            setText(event.target.value);
          }}
          className={INPUT_CLASS}
        />
      </div>
      <button
        type="submit"
        disabled={adopt.isPending || text.trim() === ''}
        className={buttonClass('ghost', 'px-4 py-2')}
      >
        {adopt.isPending ? 'Saving…' : 'Make it my next step'}
      </button>
      {adopt.isError && (
        <p role="alert" className="w-full text-sm text-danger">
          That did not save. Try again.
        </p>
      )}
    </form>
  );
}
