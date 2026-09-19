# REST API

All routes are under `/api/v1`. Status: **Architecture**, implementing the approved decisions noted per section.

## Conventions

- **Authentication:** `Authorization: Bearer <accessToken>` unless marked *Public* or *Cookie*. The token's `sid` must not be revoked.
- **Validation:** every body, query and path parameter is validated with Zod. Invalid input → `400 VALIDATION_FAILED` with details.
- **Errors:** `{ "error": { "code": "…", "message": "…", "details"?: … } }`. Codes are a closed union defined in `packages/contracts` (see `architecture/contracts.md`).
- **Success bodies** name the resource: `{ "task": … }`, `{ "tasks": […], "nextCursor": … }`.
- **Ownership:** requests for another user's task or session return `404`, so existence is not revealed.
- **Naming:** camelCase fields; `…At` for ISO-8601 timestamps; `…Seconds` for durations; branded UUID IDs.
- **Pagination:** cursor-based (`cursor`, `limit`).
- **Persist, then emit:** endpoints that change state others must see write to PostgreSQL first, then update Redis if needed, then emit socket events.

## Auth (D1, D23)

| Method & route | Auth | Request | Response | Notes |
|---|---|---|---|---|
| `POST /auth/signup` | Public | `{ email, password, displayName }` | `201 { user, accessToken, accessTokenExpiresAt }` + refresh cookie | `409 EMAIL_TAKEN`. Rate limited. |
| `POST /auth/login` | Public | `{ email, password }` | `200` same as signup | `401 INVALID_CREDENTIALS` for every failure. Rate limited. |
| `POST /auth/google` | Public | `{ idToken }` | `200` same as signup | `409 ACCOUNT_EXISTS_LINK_REQUIRED`, `403 GOOGLE_EMAIL_UNVERIFIED`, `401 GOOGLE_TOKEN_INVALID` (see `auth.md`) |
| `POST /auth/refresh` | Cookie + client header | — | `200 { accessToken, accessTokenExpiresAt }` (+ rotated cookie) | `401 SESSION_INVALID`, `401 SESSION_REVOKED` (reuse detected). Overlap window returns an access token without rotation. |
| `POST /auth/logout` | Cookie + client header | — | `204` | Safe to repeat. Revokes the session and disconnects its sockets. |

## Me

| Method & route | Request | Response | Rules |
|---|---|---|---|
| `GET /me` | — | `{ user }` | `UserView`: `id, email, emailVerified, displayName, avatarUrl, currentTaskId, identities: ("google")[]` |
| `PUT /me/current-task` | `{ taskId: TaskId \| null }` | `{ user }` | Task must be the user's (404 otherwise), not deleted (D38) and open (`409 TASK_NOT_OPEN` if completed, D43). Repeatable. |
| `POST /me/identities/google` | `{ idToken }` | `201 { user }` | Explicit Google linking for a signed-in user (D1, D44; Phase 1b). `409 IDENTITY_ALREADY_LINKED` if that Google account belongs to another user. Repeating for an identity already linked to this user → `200`. |

## Tasks (D3, D38)

| Method & route | Request | Response | Rules and retry behaviour |
|---|---|---|---|
| `GET /tasks` | `?status=open\|completed&cursor&limit` | `{ tasks, nextCursor }` | Own, non-deleted tasks only |
| `POST /tasks` | `{ title }` | `201 { task }` | A retried create may duplicate (low harm; `Idempotency-Key` later) |
| `PATCH /tasks/:taskId` | `{ title }` | `{ task }` | Owner; not deleted |
| `POST /tasks/:taskId/complete` | — | `{ task }` | If it is the current task, clears `users.current_task_id` in the same transaction (D43). Already completed → `200` |
| `POST /tasks/:taskId/reopen` | — | `{ task }` | Already open → `200` |
| `DELETE /tasks/:taskId` | — | `204` | Soft delete (D38). Clears `users.current_task_id` in the same transaction if it pointed here. In-progress and past sessions keep their link. Already deleted → `204`. |

## Focus sessions (D4, D6, D14/15/35)

| Method & route | Request | Response | Rules and retry behaviour |
|---|---|---|---|
| `POST /focus-sessions` | `{ plannedSeconds, taskId? }` | `201 { session }` | Solo start. User must be connected (`409 NOT_CONNECTED`). `409 SESSION_IN_PROGRESS` includes the existing session, so a retried start can recover. Task must be own and not deleted. |
| `GET /focus-sessions/current` | — | `{ session \| null }` | Solo or room; used to restore after refresh |
| `POST /focus-sessions/:id/pause` | — | `{ session }` | Solo only (`409 NOT_SOLO_SESSION` for room sessions). Already paused → `200`. |
| `POST /focus-sessions/:id/resume` | — | `{ session }` | Solo only; user must be connected. Already running → `200`. |
| `POST /focus-sessions/:id/stop` | — | `{ session }` | Solo only → `abandoned(stopped)` keeping actual time. Already ended → `200`. |
| `GET /focus-sessions` | `?from&to&cursor&limit` | `{ sessions, nextCursor }` | Own history. Each session includes its task reference `{ id, title, deleted }` if any. |
| `GET /focus-sessions/summary` | `?from&to&tz` | `{ completedCount, completedFocusedSeconds, totalFocusedSeconds, days: [{ date, completedFocusedSeconds, totalFocusedSeconds }] }` | `tz` is an IANA timezone (D18 default). Both totals are returned (D34 default). |

There is no "complete" endpoint: completion is decided by the server (see `architecture/focus-timing-protocol.md`) and announced with the `focus:session:updated` socket event.

## Rooms (D8, D9, D16)

| Method & route | Request | Response | Rules and retry behaviour |
|---|---|---|---|
| `POST /rooms` | `{ name, isPrivate, timerSettings? }` | `201 { room }` | Creates the room and the host's membership in one transaction. Settings default to 25/5/15 min. |
| `GET /rooms` | `?scope=mine` | `{ rooms: [{ …room, presentCount }] }` | Rooms the user is a member of. `scope=public` only if D12 approves discovery. |
| `GET /rooms/by-code/:code` | — | `{ room, access, presentCount }` | `access`: `host` \| `member` \| `can_join` (public, not yet a member) \| `must_knock` (private, not a member). Non-members of private rooms receive a preview: `{ id, code, name, isPrivate }`. |
| `GET /rooms/:roomId` | — | `{ room }` | Members only. `RoomView` includes `timerSettings`. |
| `PATCH /rooms/:roomId/timer-settings` | `{ focusSeconds?, shortBreakSeconds?, longBreakSeconds? }` | `{ room }` | Host only. Saved to PostgreSQL, then the Redis copy; emits `room:settings:updated` with `effectiveFrom: "next_phase"` (D16). |
| `GET /rooms/:roomId/members` | — | `{ members }` | Members only |
| `POST /rooms/:roomId/membership` | — | `201` or `200 { membership }` | Public rooms only (`403 KNOCK_REQUIRED` for private). Idempotent upsert (D9). |
| `DELETE /rooms/:roomId/membership` | — | `204` | Members; the host gets `409 HOST_CANNOT_LEAVE` (D10). Abandons any room participation (`left_room`) and removes presence. Repeatable. |
| `DELETE /rooms/:roomId/members/:userId` | — | `204` | Host only. Deletes the membership and abandons participation (`removed`) in one transaction, then evicts sockets and emits `room:member:removed`. |
| `POST /rooms/:roomId/knocks/:userId/approve` | — | `{ membership }` | Host only. The knock must still be pending (`410 KNOCK_EXPIRED`). Upserts membership, deletes the knock, emits `room:knock:resolved` to the requester and `room:knock:removed` to the host. Already a member → `200`. |
| `POST /rooms/:roomId/knocks/:userId/reject` | — | `204` | Host only. Deletes the knock, emits the same events. Repeatable. |
| `POST /rooms/:roomId/focus-participation` | `{ taskId? }` | `201 { session }` | Opt in (D11). Member, present in the room, phase is focus (D31 default), no in-progress session. `409 RUN_CHANGED` if the run changed meanwhile; `409 SESSION_IN_PROGRESS` returns the existing session (and repairs a half-completed opt-in). |
| `DELETE /rooms/:roomId/focus-participation` | — | `{ session }` | Opt out → `abandoned(opted_out)`. Does not require presence. Repeatable. |

## Health

Health checks are split (P2):

| Method & route | Auth | Response |
|---|---|---|
| `GET /healthz` | Public | Liveness: `200 { status: "ok" }` whenever the process is running and able to respond. Never checks dependencies. |
| `GET /readyz` | Public | Readiness: `200 { status: "ready", checks: { postgres: "ok", redis: "ok" } }` when all required dependencies are reachable; otherwise `503 { status: "not_ready", checks: { … } }` with each failing check marked `"unavailable"`. |
