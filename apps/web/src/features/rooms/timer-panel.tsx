import type { RoomId, TimerPhase, TimerView } from '@focus-flow/contracts';
import { useEffect, useRef, useState } from 'react';

import { formatClock } from '../focus/focus-time';
import { useRealtimeStatus } from '../realtime/realtime-provider';
import { useRoomLive } from './room-live-store';
import {
  announcement,
  isFinishing,
  PHASE_LABEL,
  PHASES,
  progressAt,
  remainingSecondsAt,
  STATUS_LABEL,
} from './timer-display';
import { useTimerClock } from './use-timer-clock';
import type { TimerCommandsApi } from './use-timer-commands';

const PRIMARY = 'rounded bg-slate-900 px-3 py-1 text-sm text-white disabled:opacity-50';
const SECONDARY = 'rounded border border-slate-300 px-3 py-1 text-sm disabled:opacity-50';
const FOCUS_RING = 'focus-visible:outline-2 focus-visible:outline-offset-2';

/** Gaps before the re-asks once a running timer shows 0:00; then every `REASK_EVERY_MS`. */
const REASK_FIRST_MS = 3_000;
const REASK_EVERY_MS = 10_000;

/**
 * Phase treatment is never colour alone: each phase has its own word, border pattern
 * (solid / dashed / dotted) and a short marker, with a tint on top.
 */
const PHASE_STYLE: Readonly<Record<TimerPhase, { box: string; marker: string }>> = {
  focus: { box: 'border-2 border-solid border-slate-900 bg-slate-50', marker: '[F]' },
  short_break: { box: 'border-2 border-dashed border-emerald-700 bg-emerald-50', marker: '[S]' },
  long_break: { box: 'border-2 border-dotted border-sky-700 bg-sky-50', marker: '[L]' },
};

/** An in-page yes/no, like the solo "stop" confirmation. */
export function ConfirmGroup({
  label,
  message,
  confirmLabel,
  disabled,
  onConfirm,
  onCancel,
}: {
  label: string;
  message: string;
  confirmLabel: string;
  disabled: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmRef.current?.focus();
  }, []);
  return (
    <div role="group" aria-label={label} className="space-y-2">
      <p className="text-sm">{message}</p>
      <div className="flex flex-wrap gap-2">
        <button
          ref={confirmRef}
          type="button"
          disabled={disabled}
          onClick={onConfirm}
          className={`${PRIMARY} ${FOCUS_RING}`}
        >
          {confirmLabel}
        </button>
        <button type="button" disabled={disabled} onClick={onCancel} className={SECONDARY}>
          Cancel
        </button>
      </div>
    </div>
  );
}

type Pending =
  | { readonly kind: 'reset'; readonly version: number }
  | { readonly kind: 'setPhase'; readonly phase: TimerPhase; readonly version: number };

/** What would be thrown away, in words: only a timer that has run has anything to lose. */
export const discardsProgress = (timer: TimerView): boolean => timer.status !== 'idle';

function HostControls({
  timer,
  commands,
  canCommand,
}: {
  timer: TimerView;
  commands: TimerCommandsApi;
  canCommand: boolean;
}) {
  const [confirming, setConfirming] = useState<Pending | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const previousStatus = useRef(timer.status);
  const { pending, send, clearError } = commands;
  const disabled = pending || !canCommand;

  // Replacing Start with Pause (and so on) unmounts the focused button; hand focus to its
  // successor, but only if it was lost or is already inside the controls.
  useEffect(() => {
    if (previousStatus.current === timer.status) {
      return;
    }
    previousStatus.current = timer.status;
    const active = document.activeElement;
    if (active === null || active === document.body || rootRef.current?.contains(active) === true) {
      primaryRef.current?.focus();
    }
  }, [timer.status]);

  function run(command: Parameters<TimerCommandsApi['send']>[0]): void {
    setConfirming(null);
    void send(command);
  }

  function ask(request: Pending): void {
    clearError();
    if (discardsProgress(timer)) {
      setConfirming(request);
    } else {
      confirm(request);
    }
  }

  function confirm(request: Pending): void {
    run(
      request.kind === 'reset'
        ? { type: 'reset', expectedVersion: request.version }
        : { type: 'setPhase', phase: request.phase, expectedVersion: request.version },
    );
  }

  if (confirming !== null) {
    const what =
      confirming.kind === 'reset'
        ? 'Reset the timer?'
        : `Switch to ${PHASE_LABEL[confirming.phase]}?`;
    return (
      <div ref={rootRef}>
        <ConfirmGroup
          label={confirming.kind === 'reset' ? 'Confirm reset' : 'Confirm phase switch'}
          message={`${what} The time already elapsed in this ${PHASE_LABEL[timer.phase].toLowerCase()} phase is discarded for everyone in the room.`}
          confirmLabel={
            pending ? 'Working…' : confirming.kind === 'reset' ? 'Yes, reset' : 'Yes, switch'
          }
          disabled={disabled}
          onConfirm={() => {
            confirm(confirming);
          }}
          onCancel={() => {
            setConfirming(null);
          }}
        />
      </div>
    );
  }

  return (
    <div ref={rootRef} aria-busy={pending} className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {timer.status === 'idle' && (
          <button
            ref={primaryRef}
            type="button"
            disabled={disabled}
            onClick={() => {
              run({ type: 'start' });
            }}
            className={`${PRIMARY} ${FOCUS_RING}`}
          >
            {pending ? 'Starting…' : 'Start timer'}
          </button>
        )}
        {timer.status === 'running' && (
          <button
            ref={primaryRef}
            type="button"
            disabled={disabled}
            onClick={() => {
              run({ type: 'pause' });
            }}
            className={`${SECONDARY} ${FOCUS_RING}`}
          >
            {pending ? 'Pausing…' : 'Pause timer'}
          </button>
        )}
        {timer.status === 'paused' && (
          <button
            ref={primaryRef}
            type="button"
            disabled={disabled}
            onClick={() => {
              run({ type: 'resume' });
            }}
            className={`${PRIMARY} ${FOCUS_RING}`}
          >
            {pending ? 'Resuming…' : 'Resume timer'}
          </button>
        )}
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            ask({ kind: 'reset', version: timer.version });
          }}
          className={`${SECONDARY} ${FOCUS_RING}`}
        >
          Reset timer
        </button>
      </div>

      <div role="group" aria-label="Switch phase" className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-slate-700">Switch to</span>
        {PHASES.map((phase) => (
          <button
            key={phase}
            type="button"
            disabled={disabled || phase === timer.phase}
            aria-current={phase === timer.phase ? 'true' : undefined}
            onClick={() => {
              ask({ kind: 'setPhase', phase, version: timer.version });
            }}
            className={`${SECONDARY} ${FOCUS_RING}`}
          >
            {PHASE_LABEL[phase]}
          </button>
        ))}
      </div>

      {pending && (
        <p role="status" className="text-sm text-slate-600">
          Sending to the server…
        </p>
      )}
    </div>
  );
}

/**
 * The shared room timer (Phase 7). The display is derived only from the server's timer state
 * and the synced server clock; at 0:00 while the server still says running it shows
 * "Finishing…" and asks the server again, never advancing the phase itself.
 */
export function TimerPanel({
  roomId,
  isHost,
  commands,
  rejoin,
}: {
  roomId: RoomId;
  isHost: boolean;
  commands: TimerCommandsApi;
  /** A safe re-read: `room:join` is idempotent and answers the authoritative snapshot. */
  rejoin: () => void;
}) {
  const timer = useRoomLive(roomId, (state) => state.timer);
  const joined = useRoomLive(roomId, (state) => state.joinStatus === 'joined');
  const realtime = useRealtimeStatus();
  const { nowMs, synced } = useTimerClock();
  const canCommand = realtime === 'connected' && joined;
  const finishing = timer !== null && isFinishing(timer, nowMs);

  // Keep asking the server while the timer sits at 0:00 and still says running (jobs, a
  // missed event). The answer replaces the state; nothing is decided here.
  const finishingVersion = finishing ? timer.version : null;
  useEffect(() => {
    if (finishingVersion === null) {
      return undefined;
    }
    let handle: ReturnType<typeof setTimeout> | undefined;
    let delay = REASK_FIRST_MS;
    const schedule = (): void => {
      handle = setTimeout(() => {
        rejoin();
        delay = REASK_EVERY_MS;
        schedule();
      }, delay);
    };
    schedule();
    return () => {
      clearTimeout(handle);
    };
  }, [finishingVersion, rejoin]);

  if (timer === null) {
    return (
      <section aria-labelledby="timer-heading" className="space-y-2">
        <h3 id="timer-heading" className="text-base font-semibold">
          Room timer
        </h3>
        <p role="status" aria-live="polite" className="text-sm text-slate-600">
          {realtime === 'connected'
            ? 'Loading the timer…'
            : 'The timer will appear once you are connected.'}
        </p>
      </section>
    );
  }

  const style = PHASE_STYLE[timer.phase];
  const remaining = remainingSecondsAt(timer, nowMs);
  const progress = progressAt(timer, nowMs);
  const percent =
    progress.totalSeconds === 0
      ? 0
      : Math.round((progress.elapsedSeconds / progress.totalSeconds) * 100);

  return (
    <section aria-labelledby="timer-heading" className="space-y-3">
      <h3 id="timer-heading" className="text-base font-semibold">
        Room timer
      </h3>

      <div className={`space-y-2 rounded p-3 ${style.box}`}>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <p className="text-lg font-semibold">
            <span aria-hidden="true">{style.marker} </span>
            {PHASE_LABEL[timer.phase]}
          </p>
          <p className="text-sm font-medium text-slate-700">{STATUS_LABEL[timer.status]}</p>
        </div>

        <p className="text-4xl font-semibold tabular-nums">
          <span className="sr-only">Time remaining </span>
          {formatClock(remaining)}
        </p>

        <div
          role="progressbar"
          aria-label="Phase progress"
          aria-valuemin={0}
          aria-valuemax={progress.totalSeconds}
          aria-valuenow={progress.elapsedSeconds}
          aria-valuetext={`${formatClock(remaining)} remaining of ${formatClock(progress.totalSeconds)}`}
          className="h-2 w-full overflow-hidden rounded bg-slate-200"
        >
          <div className="h-full bg-slate-700" style={{ width: `${String(percent)}%` }} />
        </div>

        {/* Announced politely when the phase or status changes; the ticking clock is silent. */}
        <p role="status" aria-live="polite" className="sr-only">
          {announcement(timer)}
        </p>

        {timer.status === 'idle' && (
          <p className="text-sm text-slate-700">
            {isHost
              ? 'The timer has not started. Press Start timer when everyone is ready.'
              : 'The timer has not started. The host will start it.'}
          </p>
        )}
        {!synced && (
          // A caveat on the numbers, not an event to announce.
          <p className="text-xs text-slate-500">
            Syncing with the server clock — the time shown may be a few seconds off.
          </p>
        )}
        {finishing && (
          <p role="status" className="text-sm text-slate-600">
            Finishing… waiting for the server
          </p>
        )}
      </div>

      {realtime !== 'connected' && (
        <p role="status" className="text-sm text-amber-800">
          {realtime === 'idle'
            ? 'No connection: timer controls are paused and the time shown may be out of date.'
            : 'Timer controls are paused while the room reconnects.'}
        </p>
      )}

      {isHost ? (
        <HostControls timer={timer} commands={commands} canCommand={canCommand} />
      ) : (
        <p className="text-sm text-slate-600">Only the host controls the timer.</p>
      )}

      {commands.error !== null && (
        <p role="alert" className="text-sm text-red-700">
          {commands.error}
        </p>
      )}
    </section>
  );
}
