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

"Client header" means the required `x-focus-flow-client` header (any non-empty value; its presence is the CSRF signal, not its content — `auth.md`). A refresh or logout request missing it never reaches the cookie/session logic at all: it is rejected with `401 UNAUTHENTICATED` before the cookie is even read.

## Me

| Method & route | Request | Response | Rules |
|---|---|---|---|
| `GET /me` | — | `{ user }` | `UserView`: `id, email, emailVerified, displayName, avatarUrl, currentTaskId, identities: ("google")[]` |
| `PUT /me/current-task` | `{ taskId: TaskId \| null }` | `{ user }` | `null` clears it. Task must be the user's, not deleted (D38) and open: another user's, a deleted or a nonexistent task → `404 TASK_NOT_FOUND`; a completed task → `409 TASK_NOT_OPEN` (D43). Repeatable. |
| `POST /me/identities/google` | `{ idToken }` | `201 { user }` | Explicit Google linking for a signed-in user (D1, D44; Phase 1b). `409 IDENTITY_ALREADY_LINKED` if that Google account belongs to another user. Repeating for an identity already linked to this user → `200`. |

## Tasks (D3, D38, D43, T1, T2, T6) — implemented in Phase 2

| Method & route | Request | Response | Rules and retry behaviour |
|---|---|---|---|
| `GET /tasks` | `?status=open\|completed&cursor&limit` | `{ tasks, nextCursor }` | Own, non-deleted tasks only. `status` defaults to `open`; `limit` defaults to 50, maximum 100. Newest-created first (UUIDv7 `id DESC`, T2). `cursor` is the opaque `nextCursor` of the previous page; `nextCursor` is `null` on the last page. |
| `POST /tasks` | `{ title }` | `201 { task }` | Title trimmed, 1–200 characters (T6). A retried create may duplicate (low harm; `Idempotency-Key` later) |
| `GET /tasks/:taskId` | — | `{ task }` | Own, non-deleted task (T1) |
| `PATCH /tasks/:taskId` | `{ title }` | `{ task }` | Owner; not deleted. Completed tasks may be renamed. |
| `POST /tasks/:taskId/complete` | — | `{ task }` | If it is the current task, clears `users.current_task_id` in the same transaction (D43). Already completed → `200` with the original `completedAt` |
| `POST /tasks/:taskId/reopen` | — | `{ task }` | Already open → `200`. Never makes the task current again. |
| `DELETE /tasks/:taskId` | — | `204` | Soft delete (D38). Clears `users.current_task_id` in the same transaction if it pointed here. In-progress and past sessions keep their link. Deleting one's own already-deleted task → `204`. |

- `TaskView`: `{ id, title, status: "open", createdAt, updatedAt }` or `{ id, title, status: "completed", completedAt, createdAt, updatedAt }`. Deleted tasks are never returned; `userId` and `deletedAt` never leave the API.
- Another user's task, a deleted task and a nonexistent task all answer the same `404 TASK_NOT_FOUND` (except `DELETE` of one's own deleted task, above). A malformed `:taskId`, an unknown body or query key, a bad `limit` or a tampered cursor → `400 VALIDATION_FAILED`.
- Every task route requires a bearer token and is scoped to the authenticated user. Task CRUD uses PostgreSQL only (no Redis).
- The web client re-reads `GET /me` after completing or deleting the current task (T3).

## Focus sessions (D4, D6, D14/15/35)

| Method & route | Request | Response | Rules and retry behaviour |
|---|---|---|---|
| `POST /focus-sessions` | `{ plannedSeconds, taskId? }` | `201 { session }` | Solo start. `plannedSeconds` is an integer 60–14,400 (E1). User must be connected (`409 NOT_CONNECTED`); while presence cannot be trusted — the check failed, the Redis epoch is unknown, or within `INSTANCE_TTL_MS` after a Redis data loss — `503` and nothing changes (E21). `409 SESSION_IN_PROGRESS` includes the existing session in `details.session`, so a retried start can recover. `taskId` is optional; when given it must be the user's own and not deleted (`404 TASK_NOT_FOUND`) and open (`409 TASK_NOT_OPEN`) (E3). The server never fills in the current task. |
| `GET /focus-sessions/current` | — | `{ session \| null }` | The in-progress session, if any; used to restore after a reload |
| `POST /focus-sessions/:id/pause` | — | `{ session }` | Already paused or ended → `200` unchanged (E11). At or after the planned end the decision for a running session runs first (E7): it may complete the session, abandon it as `grace_expired` (offline, the recorded disconnect's grace over), or expire it after a definite Redis loss; `503` when it cannot decide, including within `INSTANCE_TTL_MS` after a Redis data loss (E18). Room sessions (Phase 8) → `409 NOT_SOLO_SESSION`. |
| `POST /focus-sessions/:id/resume` | — | `{ session }` | User must be connected (`409 NOT_CONNECTED`; `503` while presence cannot be trusted, E21). Already running or ended → `200` unchanged (E11). |
| `POST /focus-sessions/:id/stop` | — | `{ session }` | → `abandoned(stopped)` keeping the actual time, rounded down (E14). At or after the planned end the decision for a running session runs first (E7): it may complete the session, abandon it as `grace_expired` (offline, the recorded disconnect's grace over), or expire it after a definite Redis loss; `503` when it cannot decide, including within `INSTANCE_TTL_MS` after a Redis data loss (E18). Already ended → `200` unchanged. |
| `GET /focus-sessions` | `?from&to&cursor&limit` | `{ sessions, nextCursor }` | Own history, every status (the in-progress session included), newest-started first (`started_at DESC, id DESC`). `from`/`to` are optional ISO-8601 instants with an offset (at most millisecond precision) selecting `startedAt` in `[from, to)`; `from < to`, and each instant must fall in `[1970-01-01T00:00:00.000Z, 9999-12-31T23:59:59.999Z]` (V1). `limit` defaults to 50, maximum 100. `cursor` is the opaque `nextCursor` of the previous page; a cursor that does not name one of the user's sessions → `400 VALIDATION_FAILED` (V2). Each session includes its task reference `{ id, title, deleted }` if any, soft-deleted tasks included (D38). |
| `GET /focus-sessions/summary` | `?from&to&tz` | `{ completedCount, completedFocusedSeconds, totalFocusedSeconds, days: [{ date, completedFocusedSeconds, totalFocusedSeconds }] }` | All three parameters required. `from`/`to` are calendar dates `YYYY-MM-DD`, both included, `from ≤ to`, at most 366 days, not before 1970 (V3, V4). `tz` is `UTC` or an IANA `Area/Location` name (D18 default; offsets, abbreviations and POSIX rules → `400`, V5). Only ended sessions count, each on the date in `tz` on which it started; `completed…` covers completed sessions, `total…` adds abandoned sessions' recorded time (D34 default, V6). `days` lists every date of the range oldest first, zeros included; each total is the sum of its days (V7). |

There is no "complete" endpoint: completion is decided by the server (see `architecture/focus-timing-protocol.md`) and announced with the `focus:session:updated` socket event.

- Every focus-session route requires a bearer token and is scoped to the authenticated user; another user's or an unknown session → `404 NOT_FOUND`. Each change runs in one transaction that locks the session row, and then emits `focus:session:updated` (E6).
- The review parameters travel in the query string, where a raw `+` means a space, so an offset must be percent-encoded: `?from=2026-10-05T05:30:00+05:30` arrives as `2026-10-05T05:30:00 05:30` and answers `400 VALIDATION_FAILED`. Send `%2B` (`?from=2026-10-05T05:30:00%2B05:30`, `?tz=Etc/GMT%2B5`) — `URLSearchParams` and `encodeURIComponent` do it — or use `Z` for UTC.
- Both review routes validate their query strictly: an unknown key, an instant the schema refuses (without an offset, finer than millisecond precision, or outside `[1970-01-01T00:00:00.000Z, 9999-12-31T23:59:59.999Z]` — year 0, or year 10000 reached through an offset), `from` not earlier than `to` (history), `from` later than `to`, a range over 366 days or a date before 1970 (summary), a `limit` that is not an integer in 1–100, a cursor that does not decode or does not name one of the user's sessions, and a `tz` that is not an accepted time zone name all answer `400 VALIDATION_FAILED`.
- **Phase 4B** implements start, current, pause, resume and stop (solo only). **Phase 5** implements history and summary (read-only, PostgreSQL only; V1–V8). `NOT_SOLO_SESSION` (Phase 8): pause, resume and stop on a room session answer `409 NOT_SOLO_SESSION`; `GET /focus-sessions/current` and the history return room sessions with `context.kind = "room"` (RF11).

## Rooms (D8, D9, D16) — implemented in Phase 6

Decisions D8, D9, D10, D16, D20, D36 and M1–M13. Rooms, memberships and room settings are PostgreSQL; presence, knocks and chat are Redis and Socket.IO (`api/socket-events.md`). Every route requires a bearer token and is scoped to the authenticated user. A room that does not exist and a room the caller may not see answer the same (`404 ROOM_NOT_FOUND`, M4); the one deliberate exception is the preview that `by-code` gives anyone holding a code. `403 NOT_HOST` is only ever answered to a member.

| Method & route | Request | Response | Rules and retry behaviour |
|---|---|---|---|
| `POST /rooms` | `{ name, isPrivate, timerSettings? }` | `201 { room }` | Name trimmed, 1–60 characters. Creates the room and the host's membership in one transaction, with a generated join code (M2). `timerSettings` may give any of the three durations; the rest default to 25/5/15 min (M3). A retried create makes a second room (low harm; `Idempotency-Key` later). |
| `GET /rooms` | `?scope=mine` | `{ rooms: [{ …room, presentCount }] }` | Rooms the user is a member of, most recently joined first. `presentCount` is the number of people with a live socket in the room; if Redis cannot answer it is `0` and the list still succeeds. `scope=public` only if D12 approves discovery. |
| `GET /rooms/by-code/:code` | — | `{ access, room, presentCount }` | `access`: `host` | `member` (full `RoomView`) | `can_join` (public, not a member) | `must_knock` (private, not a member). The last two receive only the preview `{ id, code, name, isPrivate }`, and `presentCount` is `null` for a private room's non-member. Case and spaces in the code are forgiven; an unknown code → `404 ROOM_NOT_FOUND`, a malformed one → `400 VALIDATION_FAILED`. |
| `GET /rooms/:roomId` | — | `{ room }` | Members only (`404` for everyone else). `RoomView` includes `hostId` and `timerSettings`. |
| `PATCH /rooms/:roomId/timer-settings` | `{ focusSeconds?, shortBreakSeconds?, longBreakSeconds? }` | `{ room }` | Host only (`403 NOT_HOST` for another member). At least one duration, within the bounds of M3. Saved to PostgreSQL, then `room:settings:updated` with `effectiveFrom: "next_phase"` (D16). |
| `GET /rooms/:roomId/members` | — | `{ members }` | Members only; oldest membership first; `{ userId, displayName, avatarUrl, joinedAt, isHost }` (never an email). |
| `POST /rooms/:roomId/membership` | — | `201 { membership }` or `200 { membership }` | Public rooms: idempotent upsert (D9), `201` only for the call that created it; announces `room:member:joined`. A private room → `403 KNOCK_REQUIRED` unless the caller is already a member (`200`). |
| `DELETE /rooms/:roomId/membership` | — | `204` | Members; the host gets `409 HOST_CANNOT_LEAVE` (D10). Removes the caller's presence and sockets from the room and sends `room:member:removed` (reason `left`). A non-member, or a room that does not exist, also answers `204` and reveals nothing. Repeatable. The caller's room focus session is abandoned (`left_room`) in the same transaction as the membership delete (Phase 8, RF8). |
| `DELETE /rooms/:roomId/members/:userId` | — | `204` | Host only. Deletes the membership, then evicts the user's sockets and emits `room:member:removed` (reason `removed`). `409 CANNOT_REMOVE_HOST` for the host themselves. Removing someone who is not a member answers `204`. A removed user of a public room may rejoin at once (D36). |
| `POST /rooms/:roomId/knocks/:userId/approve` | — | `201 { membership }` or `200 { membership }` | Host only, private rooms only (`409 NOT_PRIVATE`). The knock must still be pending (`410 KNOCK_EXPIRED`); a user who is already a member → `200`. Upserts the membership, then removes the knock (if a concurrent reject or an expiry won that removal, the membership this call created is deleted again and the answer is `410 KNOCK_EXPIRED`), emits `room:knock:resolved` to the requester and `room:knock:removed` to the host, and `room:member:joined` to the room. `503` if Redis cannot say whether the knock is pending. |
| `POST /rooms/:roomId/knocks/:userId/reject` | — | `204` | Host only. Removes the knock and emits the same two events with `rejected`. Repeatable. `503` if Redis is unreachable. |
| `POST /rooms/:roomId/focus-participation` | `{ taskId? }` | `201 { session }` (`200` for a repaired retry) | **Implemented in Phase 8 (RF4).** Opt in (D11). Members only (`404 ROOM_NOT_FOUND` otherwise, M4). In order: the timer must be in a focus phase (`409 NOT_FOCUS_PHASE`), the caller present in the room (`409 NOT_PRESENT`), no other in-progress session (`409 SESSION_IN_PROGRESS` with the existing session in `details`; the caller's own half-completed opt-in in this run is repaired instead), at least 60 s of the phase left (`409 RUN_ENDING`), an optional own, open, not-deleted `taskId` (`404 TASK_NOT_FOUND`, `409 TASK_NOT_OPEN`). `planned_seconds` = the remaining phase time. `409 RUN_CHANGED` when the run closed meanwhile (the just-created row is deleted). `429 RATE_LIMITED` (10 per 10 s). `503` when Redis cannot answer. The session's `context` is `{ kind: "room", roomId, focusRunId }`. |
| `DELETE /rooms/:roomId/focus-participation` | — | `200 { session }` | **Implemented in Phase 8.** Opt out → `abandoned(opted_out)` keeping the time focused so far. Does not require presence. Repeatable (returns the user's latest room session); `404 NOT_FOUND` if the user never took part. Same rate limit. |
| `GET /rooms/:roomId/focus-participation` | — | `{ focusRunId, participants, me, session }` | **Phase 8.** Members only. The current run, its participants (`userId, displayName, avatarUrl, optedInAtMs, connected, disconnectedAtMs`; never task titles or emails, RF14), the caller's own participation and their own in-progress session, for restoring a page. The run part is the join snapshot's `focus` shape and also carries `participantsVersion` (G2). |

- Strict validation: unknown keys (for example a `hostId` or `userId` in a body), malformed UUIDs and codes, and out-of-range durations → `400 VALIDATION_FAILED`. Identity and the host always come from the token and PostgreSQL, never from the client.
- Persist, then emit: every announcement above happens after the PostgreSQL commit and is never able to change the response; a failed announcement is logged and the next read heals it (`failure-recovery.md`).

## Health

Health checks are split (P2):

| Method & route | Auth | Response |
|---|---|---|
| `GET /healthz` | Public | Liveness: `200 { status: "ok" }` whenever the process is running and able to respond. Never checks dependencies. |
| `GET /readyz` | Public | Readiness: `200 { status: "ready", checks: { postgres: "ok", redis: "ok" } }` when all required dependencies are reachable; otherwise `503 { status: "not_ready", checks: { … } }` with each failing check marked `"unavailable"`. |
