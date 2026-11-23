import type { FocusSessionView } from '@focus-flow/contracts';
import { useEffect, useRef, useState } from 'react';

import { buttonClass } from '../../ui/primitives';
import { ProgressRing } from '../../ui/progress-ring';
import { focusErrorMessage } from './focus-messages';
import {
  useFocusConnection,
  usePauseFocusSession,
  useRefetchCurrentFocusSession,
  useResumeFocusSession,
  useStopFocusSession,
} from './focus-queries';
import { focusedSecondsAt, formatClock, remainingSecondsAt, wholeMinutes } from './focus-time';
import { useClockSynced, useServerNowMs } from './use-server-now';

type InProgress = Extract<FocusSessionView, { status: 'in_progress' }>;

const PRIMARY = buttonClass('primary');
/** Gaps before the re-asks at 0 s, ~2 s and ~5 s after zero; then every `REASK_EVERY_MS`. */
const REASK_GAPS_MS = [0, 2_000, 3_000] as const;
const REASK_EVERY_MS = 10_000;
/** A paused session this old gets a note that unresolved sessions are cleaned up (E2). */
const OLD_PAUSED_MS = 2 * 60 * 60 * 1000;

const SECONDARY = buttonClass('ghost');

/**
 * A running or paused session. The clock is display only: at 0:00 the browser keeps
 * showing the server's `in_progress` state and waits for it to confirm the outcome.
 */
export function ActiveSession({ session }: { session: InProgress }) {
  const nowMs = useServerNowMs();
  const pause = usePauseFocusSession();
  const resume = useResumeFocusSession();
  const stop = useStopFocusSession();
  const connection = useFocusConnection();
  const refetchCurrent = useRefetchCurrentFocusSession();
  const clockSynced = useClockSynced();
  const [confirmingStop, setConfirmingStop] = useState(false);

  const paused = session.runningSince === null;
  const focused = focusedSecondsAt(session, nowMs);
  const remaining = remainingSecondsAt(session, nowMs);
  // Any lifecycle request in flight blocks every button, so no duplicate is submitted.
  const pending = pause.isPending || resume.isPending || stop.isPending;
  const error = pause.error ?? resume.error ?? stop.error;

  // Replacing a control unmounts the one that had keyboard focus, which drops focus to the
  // document. Put it on the natural next step: Resume after a pause (Pause after a resume),
  // Confirm when the stop question opens, Stop again when it closes. Only when focus was
  // lost or is already inside this component: a change that came from another tab must not
  // pull focus out of whatever the user is typing in.
  const rootRef = useRef<HTMLDivElement>(null);
  const resumeRef = useRef<HTMLButtonElement>(null);
  const pauseRef = useRef<HTMLButtonElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const previous = useRef({ paused, confirmingStop });
  useEffect(() => {
    const before = previous.current;
    previous.current = { paused, confirmingStop };
    const active = document.activeElement;
    const focusIsFree =
      active === null || active === document.body || rootRef.current?.contains(active) === true;
    if (!focusIsFree) {
      return;
    }
    if (before.confirmingStop !== confirmingStop) {
      (confirmingStop ? confirmRef : stopRef).current?.focus();
    } else if (before.paused !== paused) {
      (paused ? resumeRef : pauseRef).current?.focus();
    }
  }, [paused, confirmingStop]);

  // At the planned end the server may still hold the session (jobs, grace, recovery window).
  // Keep asking it, never deciding locally; the timers are cleared on unmount or when the
  // server's answer changes the session. Nothing here sends a stop.
  const atZero = remaining === 0;
  useEffect(() => {
    if (!atZero) {
      return undefined;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const schedule = (): void => {
      timer = setTimeout(() => {
        void refetchCurrent();
        attempt += 1;
        schedule();
      }, REASK_GAPS_MS[attempt] ?? REASK_EVERY_MS);
    };
    schedule();
    return () => {
      clearTimeout(timer);
    };
  }, [atZero, session.id, refetchCurrent]);

  /** A new action replaces the outcome, including the error, of the previous one. */
  function run(action: () => void): void {
    pause.reset();
    resume.reset();
    stop.reset();
    action();
  }

  return (
    <div ref={rootRef} className="space-y-5 text-center">
      <div>
        <p className="font-display text-3xl">
          {session.task === null ? 'Focus session' : session.task.title}
          {session.task?.deleted === true && (
            <span className="ml-2 text-xs font-normal text-muted">(task deleted)</span>
          )}
        </p>
        {/* Only state changes are announced; the ticking clock is deliberately silent. */}
        <p role="status" className="text-sm font-medium text-focus">
          {paused ? 'Paused' : 'Running'}
        </p>
      </div>

      <ProgressRing progress={focused / session.plannedSeconds} muted={paused}>
        <p className="font-display text-7xl tabular-nums">
          <span className="sr-only">Time remaining </span>
          {formatClock(remaining)}
        </p>
        <p className="mt-2 text-sm text-muted">
          {`Focused ${formatClock(focused)} of ${formatClock(session.plannedSeconds)}`}
        </p>
      </ProgressRing>
      {!clockSynced && (
        // Not a live region: a caveat on the numbers, not an event to announce.
        <p className="text-xs text-muted">
          Syncing with the server clock — the time shown may be a few seconds off.
        </p>
      )}
      {connection === 'not-connected' && !paused && (
        // A paused session is not abandoned by a disconnect (D35), so only a running one warns.
        <p
          role="alert"
          className="rounded-xl border border-warm/40 bg-warm/10 p-3 text-sm text-warm"
        >
          Focus Flow must stay open and connected — a running session ends if you stay disconnected
          for about a minute.
        </p>
      )}
      {atZero && (
        <p role="status" className="text-sm text-muted">
          Finishing… waiting for the server to confirm
        </p>
      )}
      {paused && nowMs - Date.parse(session.startedAt) > OLD_PAUSED_MS && (
        <p className="text-sm text-muted">
          This session has been paused for a long time. An unresolved session is cleaned up
          automatically.
        </p>
      )}

      {confirmingStop ? (
        <div className="space-y-2">
          <p className="text-sm">{`Stop and keep ${String(wholeMinutes(focused))} min recorded?`}</p>
          <div className="flex justify-center gap-2">
            <button
              ref={confirmRef}
              type="button"
              disabled={pending}
              onClick={() => {
                run(() => {
                  stop.mutate(session.id, {
                    onSuccess: () => {
                      setConfirmingStop(false);
                    },
                  });
                });
              }}
              className={PRIMARY}
            >
              {stop.isPending ? 'Stopping…' : 'Confirm stop'}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setConfirmingStop(false);
              }}
              className={SECONDARY}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex justify-center gap-3">
          {paused ? (
            <button
              ref={resumeRef}
              type="button"
              disabled={pending}
              onClick={() => {
                run(() => {
                  resume.mutate(session.id);
                });
              }}
              className={PRIMARY}
            >
              {resume.isPending ? 'Resuming…' : 'Resume'}
            </button>
          ) : (
            <button
              ref={pauseRef}
              type="button"
              disabled={pending}
              onClick={() => {
                run(() => {
                  pause.mutate(session.id);
                });
              }}
              className={SECONDARY}
            >
              {pause.isPending ? 'Pausing…' : 'Pause'}
            </button>
          )}
          <button
            ref={stopRef}
            type="button"
            disabled={pending}
            onClick={() => {
              run(() => {
                setConfirmingStop(true);
              });
            }}
            className={SECONDARY}
          >
            Stop session
          </button>
        </div>
      )}

      {error !== null && (
        // The buttons stay usable, so pressing the same one again is the retry.
        <p role="alert" className="text-sm text-danger">
          {focusErrorMessage(error)}
        </p>
      )}
    </div>
  );
}
