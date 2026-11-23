import type { TimerPhase, TimerStatus, TimerView } from '@focus-flow/contracts';

// Display arithmetic for the shared room timer (docs/architecture/focus-timing-protocol.md,
// "Client display"). Everything here only shows a clock: the server alone decides that a
// phase has ended, so nothing derives a phase change or an outcome from these numbers.

export const PHASE_LABEL: Readonly<Record<TimerPhase, string>> = {
  focus: 'Focus',
  short_break: 'Short break',
  long_break: 'Long break',
};

export const STATUS_LABEL: Readonly<Record<TimerStatus, string>> = {
  idle: 'Not started',
  running: 'Running',
  paused: 'Paused',
};

/** Phases in the order the host's switch shows them. */
export const PHASES: readonly TimerPhase[] = ['focus', 'short_break', 'long_break'];

/**
 * Milliseconds left at the (server-synced) instant, clamped to `[0, durationMs]`. A running
 * timer counts down to `endsAtMs`; any other status shows what was left when it stopped.
 */
export function remainingMsAt(timer: TimerView, serverNowMs: number): number {
  const left =
    timer.status === 'running'
      ? timer.endsAtMs !== null
        ? timer.endsAtMs - serverNowMs
        : timer.durationMs -
          timer.elapsedBeforeMs -
          (serverNowMs - (timer.segmentStartedAtMs ?? serverNowMs))
      : timer.durationMs - timer.elapsedBeforeMs;
  return Math.min(timer.durationMs, Math.max(0, left));
}

/** Whole seconds shown on the clock: rounded up, so 0:00 appears only when time is really up. */
export function remainingSecondsAt(timer: TimerView, serverNowMs: number): number {
  return Math.ceil(remainingMsAt(timer, serverNowMs) / 1000);
}

/**
 * A running timer whose time is up but which the server has not yet moved on (the phase-end
 * job, a missed event). The browser keeps showing "finishing" and never advances the phase.
 */
export function isFinishing(timer: TimerView, serverNowMs: number): boolean {
  return timer.status === 'running' && remainingMsAt(timer, serverNowMs) === 0;
}

/** Elapsed and total whole seconds, for a progress bar. */
export function progressAt(
  timer: TimerView,
  serverNowMs: number,
): { readonly elapsedSeconds: number; readonly totalSeconds: number } {
  const totalSeconds = Math.ceil(timer.durationMs / 1000);
  return {
    elapsedSeconds: Math.min(totalSeconds, totalSeconds - remainingSecondsAt(timer, serverNowMs)),
    totalSeconds,
  };
}

/** The word for a screen reader: "Focus, running". Announced on change only. */
export const announcement = (timer: TimerView): string =>
  `${PHASE_LABEL[timer.phase]}, ${STATUS_LABEL[timer.status].toLowerCase()}.`;
