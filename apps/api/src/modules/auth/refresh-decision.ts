import { refreshHashesMatch } from './refresh-token.js';

export type AuthSessionSnapshot = {
  readonly currentTokenHash: string;
  readonly previousTokenHash: string | null;
  readonly previousValidUntil: Date | null;
  readonly revokedAt: Date | null;
  readonly expiresAt: Date;
};

export type RefreshDecision =
  | { readonly kind: 'invalid' }
  | { readonly kind: 'rotate' }
  | { readonly kind: 'overlap' }
  | { readonly kind: 'reuse' };

/**
 * The whole refresh state machine as one pure function (docs/architecture/auth.md),
 * so every branch — including the concurrency-sensitive ones — is unit-testable
 * without a database. Called once from the initial read, and again (with the
 * freshly re-read row) whenever a guarded rotation UPDATE affects zero rows, which
 * happens exactly when a concurrent request rotated first.
 */
export const decideRefresh = (
  session: AuthSessionSnapshot | undefined,
  presentedHash: string,
  now: Date,
): RefreshDecision => {
  if (session === undefined) {
    return { kind: 'invalid' };
  }
  if (session.revokedAt !== null) {
    return { kind: 'invalid' };
  }
  if (session.expiresAt.getTime() <= now.getTime()) {
    return { kind: 'invalid' };
  }

  if (refreshHashesMatch(presentedHash, session.currentTokenHash)) {
    return { kind: 'rotate' };
  }

  const { previousTokenHash, previousValidUntil } = session;
  if (
    previousTokenHash !== null &&
    previousValidUntil !== null &&
    now.getTime() <= previousValidUntil.getTime() &&
    refreshHashesMatch(presentedHash, previousTokenHash)
  ) {
    return { kind: 'overlap' };
  }

  return { kind: 'reuse' };
};
