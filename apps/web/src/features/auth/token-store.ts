/**
 * The access token lives here and nowhere else: a module-level variable, never
 * `localStorage`, `sessionStorage`, IndexedDB or a cookie this code can read
 * (docs/architecture/auth.md). A page reload therefore starts with no token, which is
 * intentional — `POST /auth/refresh` is what re-establishes one from the httpOnly
 * refresh cookie the browser sends on its own.
 *
 * It is deliberately not React state: `auth-client.ts` is not a component and must be
 * able to read the current token synchronously while building a request. React state
 * holds only what is rendered (the user and the auth status).
 */

let accessToken: string | null = null;

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

/**
 * Named separately from `setAccessToken(null)` so call sites read as an intent
 * ("this session is over") rather than as an assignment.
 */
export function clearAccessToken(): void {
  accessToken = null;
}

/**
 * `accessTokenExpiresAt` from the auth responses is intentionally not tracked. Expiry
 * is discovered reactively: the API answers 401 `UNAUTHENTICATED` and
 * `authedApiRequest` refreshes once and retries. Keeping a second source of truth for
 * "is this token still good" would only add clock-skew bugs.
 */
