# Authentication

Covers accounts, Google sign-in (D1), per-device sessions and tokens (D23), cookies, and socket authentication (F7).

## Accounts

- A user has an email (unique, case-insensitive; normalized to lowercase at input), a display name, an optional password hash (argon2id, I5), and `email_verified_at` (D1).
- JWT signing and verification, including verification of Google ID tokens against Google's published keys, use `jose` (I5).
- **Password signup** creates a user with `email_verified_at = NULL`. Email verification and password reset flows are open (D39); password reset must exist before public launch.
- **Password login** returns one generic `INVALID_CREDENTIALS` error for both unknown emails and wrong passwords. Accounts without a password (Google-only) also get `INVALID_CREDENTIALS`.
- Signup with an email that already exists returns `EMAIL_TAKEN`, including when the existing account is Google-only.

## Google sign-in (D1)

The client obtains a Google ID token and sends it to `POST /api/v1/auth/google`. The server verifies the token (signature, audience, expiry) and then:

| Situation | Result |
|---|---|
| A Google identity with this `sub` exists | Sign in that user |
| No identity; an account with this email exists | Refuse: `409 ACCOUNT_EXISTS_LINK_REQUIRED`. The user signs in with their password and links Google from account settings. Never merged automatically. |
| No identity; no account with this email; Google reports the email verified | Create the user with `email_verified_at = now()` and a Google identity; sign in |
| No identity; no account; Google reports the email **not** verified | Refuse: `403 GOOGLE_EMAIL_UNVERIFIED` |

**Explicit linking** (D44, part of the MVP in Phase 1b): a signed-in user calls `POST /api/v1/me/identities/google` with a Google ID token. The server links it if that Google `sub` is not linked to another user. Linking does not change the account email.

## Per-device sessions and tokens (D23)

### Tokens

| Token | Form | Lifetime | Where the client keeps it |
|---|---|---|---|
| Access token | JWT: `sub` (user ID), `sid` (auth session ID), `iat`, `exp`, `iss`, `aud` | Short (e.g. 15 min) | Memory only |
| Refresh token | Opaque: `{sid}.{secret}`. Only a hash of it is stored. | Long (e.g. 30 days) | httpOnly cookie |

The refresh token contains its session ID so the server can find the session and detect reuse of **any** older token, not only the most recent one.

### Refresh flow

`POST /api/v1/auth/refresh` reads the cookie, splits out `sid`, loads the `auth_sessions` row, and compares hashes in constant time:

| Presented token matches | Result |
|---|---|
| `current_token_hash`, session valid | **Rotate:** new secret; `previous_token_hash ← current`, `previous_valid_until ← now + overlap` (e.g. 20 s); new cookie; new access token |
| `previous_token_hash` and `now ≤ previous_valid_until` | **Overlap:** issue an access token only. No rotation and no new cookie; the browser's cookie jar already holds the current token (it is shared by all tabs). |
| Neither, or the overlap has passed | **Reuse detected:** revoke the session, clear the cookie, `401 SESSION_REVOKED`, log a security event |
| Session revoked or expired | `401 SESSION_INVALID`, clear the cookie |

The client performs at most one refresh at a time (single-flight), and calls refresh once on page load to obtain an access token.

### Logout and revocation

- `POST /api/v1/auth/logout` revokes the current session (safe to repeat) and clears the cookie.
- On any revocation (logout or reuse detection), the session ID is written to Redis (`ff:auth:revoked:{sid}`) for one access-token lifetime, and that session's sockets are disconnected (`session:{sid}` channel).
- REST authentication and socket handshakes both reject tokens whose `sid` is on the revoked list, so a revoked session stops working immediately rather than when its access token expires.

## Cookie and deployment rules

- Cookie: `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth`. It is sent only to refresh and logout.
- Refresh and logout also require a custom request header (e.g. `X-Focus-Flow-Client`), which a cross-site form cannot send.
- **One origin in every environment.** Production: Nginx serves the web app and proxies `/api` and `/socket.io`. Local: the Vite dev server proxies both. `SameSite=Strict` cookies require this, and it removes the need for CORS.
- Browsers accept `Secure` cookies on `http://localhost`, so local development needs no TLS.

## Socket authentication (F7)

- The client connects with the access token in the handshake (`auth: { token }`), never in the URL.
- Handshake middleware verifies the JWT, rejects revoked `sid`s, loads the user, and stores `socket.data = { userId, sid, displayName, avatarUrl, tokenExpiresAtMs, joinedRooms }`.
- Each socket joins `user:{userId}` (per-user notifications) and `session:{sid}` (revocation).
- Payloads never carry identity. Every handler uses `socket.data`.
- The handshake runs exactly the REST checks (the same JWT verification and revocation check, including the trust-loss window, R3) plus "the user still exists". A refusal carries `err.data.code`: `UNAUTHENTICATED` (refresh once, reconnect), `SESSION_REVOKED` (session over) or `INTERNAL` (temporary; retry later).
- Revocation (logout, refresh-token reuse) disconnects `session:{sid}` on every instance through the Socket.IO Redis emitter, after the PostgreSQL and Redis writes.
- When the access token expires, the server disconnects the socket. The Socket.IO client's `auth` option is a function that fetches a fresh token (via single-flight refresh), so reconnection re-authenticates automatically. After reconnecting, the client sends `room:join` again for any room it was in.

## Authorization summary

| Action | Rule |
|---|---|
| Task and focus session endpoints | Owner only; non-owners get 404 so existence is not revealed |
| Room details | Members; non-members of private rooms see a preview only |
| `room:join` | Membership record required (D9) |
| Timer commands, settings, knock approve/reject, member removal | Host only (`rooms.host_id`), checked against PostgreSQL |
| In-room socket actions | The room must be in `socket.data.joinedRooms` |
