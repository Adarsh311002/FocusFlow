import { DEEP_FOCUS_LEAVE_WARNING_SECONDS } from '@focus-flow/contracts';

// DF2/DF3: what happens when the user leaves a running Deep Focus session. Pure, so the
// rule can be tested without a browser: the hook feeds it "is the user here?" samples and
// performs the effect it returns.
//
// - Leaving (tab hidden, window not focused, or full screen exited) starts a countdown.
// - Back within the warning → one distraction is counted and the countdown ends.
// - Still away when it runs out → the session is broken (reset). Sent once.

export const LEAVE_WARNING_MS = DEEP_FOCUS_LEAVE_WARNING_SECONDS * 1_000;

export type LeaveGuardState = {
  /** When the current absence began (the page's own clock), or `null` while present. */
  readonly awaySinceMs: number | null;
  /** Set once the break was asked for, so it is never sent twice. */
  readonly broken: boolean;
};

export type LeaveGuardEffect = 'none' | 'distraction' | 'break';

export const initialLeaveGuard: LeaveGuardState = { awaySinceMs: null, broken: false };

export function stepLeaveGuard(
  state: LeaveGuardState,
  sample: { readonly nowMs: number; readonly present: boolean },
): { state: LeaveGuardState; effect: LeaveGuardEffect } {
  if (state.broken) {
    return { state, effect: 'none' };
  }
  if (state.awaySinceMs === null) {
    return sample.present
      ? { state, effect: 'none' }
      : { state: { awaySinceMs: sample.nowMs, broken: false }, effect: 'none' };
  }
  // The deadline is checked first: coming back after it is still a break.
  if (sample.nowMs - state.awaySinceMs >= LEAVE_WARNING_MS) {
    return { state: { awaySinceMs: state.awaySinceMs, broken: true }, effect: 'break' };
  }
  if (sample.present) {
    return { state: initialLeaveGuard, effect: 'distraction' };
  }
  return { state, effect: 'none' };
}

/** Whole seconds left before the break, for the warning (never below 0). */
export function secondsLeft(state: LeaveGuardState, nowMs: number): number {
  if (state.awaySinceMs === null) {
    return DEEP_FOCUS_LEAVE_WARNING_SECONDS;
  }
  return Math.max(0, Math.ceil((state.awaySinceMs + LEAVE_WARNING_MS - nowMs) / 1_000));
}
