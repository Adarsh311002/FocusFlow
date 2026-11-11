/**
 * The reconnect grace period shown beside a participant who lost their connection (D19).
 * Display only: the server's job settles the session when the grace really ends, and it
 * re-checks that the person is still absent. A constant here is a label, not a rule.
 */
export const GRACE_DISPLAY_MS = 60_000;

/**
 * Whole seconds of the grace left at the (server-synced) instant, never negative.
 * `disconnectedAtMs` and `serverNowMs` are both server (Redis TIME) instants.
 */
export function graceSecondsLeft(disconnectedAtMs: number, serverNowMs: number): number {
  const left = disconnectedAtMs + GRACE_DISPLAY_MS - serverNowMs;
  return Math.min(GRACE_DISPLAY_MS / 1000, Math.max(0, Math.ceil(left / 1000)));
}
