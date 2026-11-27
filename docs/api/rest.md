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
| `GET /me` | — | `{ user }` | `UserView`: `id, email, emailVerified, displayName, avatarUrl, currentTaskId, dailyGoalSeconds, identities: ("google")[]` |
| `PATCH /me` | `{ dailyGoalSeconds?, displayName?, avatarPreset?, defaultSessionSeconds? }` | `{ user }` | The user's own settings (A2, ST1–ST3). `dailyGoalSeconds` 300–43,200 (default 7,200); `displayName` trimmed, 1–50; `avatarPreset` one of `monkey, sloth, toucan, frog, owl, butterfly, jaguar` or `null`; `defaultSessionSeconds` whole minutes 60–14,400 (default 1,500). Strict body with at least one field; unknown keys or out-of-range values → `400 VALIDATION_FAILED`. |
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
| `GET /focus-sessions/insights` | `?from&to&tz` (same as `/summary`) | `{ range, dailyGoalSeconds, totals, days, goalDaysMet, streak, heatmap, tasks, otherTasks, noTask, split, comparison }` | Dashboard insights (A1–A10), contract `focusSessionInsightsResponseSchema`. `totals`: `sessionCount, completedCount, abandonedCount, completionRate (0–1 or null), completedFocusedSeconds, totalFocusedSeconds`. `days[]`: the summary's days plus `sessionCount, goalProgress, goalMet`. `streak`: `{ current, longest, today, todayCompleted }` over all history. `heatmap`: 168 cells `{ weekday (0 = Monday), hour, sessionCount, totalFocusedSeconds }`. `tasks`: up to 10 `{ taskId, title, deleted, sessionCount, completedCount, totalFocusedSeconds }`; `otherTasks` adds `taskCount`; `noTask` and `split.{solo,room}` are `{ sessionCount, completedCount, totalFocusedSeconds }`. `comparison`: `{ previousFrom, previousTo, previous (totals), delta }` against the previous equal-length period. |
| `POST /focus-sessions/:id/break` | — | `200 { session }` | DF2: the page saw the user stay away from a Deep Focus session past the 10-second warning → `abandoned(focus_broken)`, focused time kept. At or after the planned end the completion decision runs first (E7). Ended → `200` unchanged. Not a Deep Focus session → `409 NOT_DEEP_FOCUS`; a room session → `409 NOT_SOLO_SESSION`. |
| `POST /focus-sessions/:id/distraction` | — | `200 { session }` | DF3: the user left a Deep Focus session and came back within the warning; counts one in `deepFocus.distractions` (capped at 1,000). Time and status never change. Ended → `200` unchanged. Not a Deep Focus session → `409 NOT_DEEP_FOCUS`. |
| `PUT /focus-sessions/:id/check-in` | `{ outcome: "done" | "progress" | "stuck", note?, quality? (1–5, FQ1) }` | `200 { session }` | CI1–CI4: the user's account of an ENDED session (in progress → `409 SESSION_NOT_ENDED`). The note is trimmed (≤ 280; blank = none); a later check-in replaces the earlier one. `done` also completes the session's task when it is still open and clears it as the current task (D43), in the same transaction. Never changes the session's time. Published as `checked_in`: `focus:session:updated` to the user, `room:focus:check-in` to the room for a room session. Insights count it in `checkIns` (CI5). |

There is no "complete" endpoint: completion is decided by the server (see `architecture/focus-timing-protocol.md`) and announced with the `focus:session:updated` socket event.

- Every focus-session route requires a bearer token and is scoped to the authenticated user; another user's or an unknown session → `404 NOT_FOUND`. Each change runs in one transaction that locks the session row, and then emits `focus:session:updated` (E6).
- The review parameters travel in the query string, where a raw `+` means a space, so an offset must be percent-encoded: `?from=2026-10-05T05:30:00+05:30` arrives as `2026-10-05T05:30:00 05:30` and answers `400 VALIDATION_FAILED`. Send `%2B` (`?from=2026-10-05T05:30:00%2B05:30`, `?tz=Etc/GMT%2B5`) — `URLSearchParams` and `encodeURIComponent` do it — or use `Z` for UTC.
- Both review routes validate their query strictly: an unknown key, an instant the schema refuses (without an offset, finer than millisecond precision, or outside `[1970-01-01T00:00:00.000Z, 9999-12-31T23:59:59.999Z]` — year 0, or year 10000 reached through an offset), `from` not earlier than `to` (history), `from` later than `to`, a range over 366 days or a date before 1970 (summary), a `limit` that is not an integer in 1–100, a cursor that does not decode or does not name one of the user's sessions, and a `tz` that is not an accepted time zone name all answer `400 VALIDATION_FAILED`.
- **Phase 4B** implements start, current, pause, resume and stop (solo only). **Phase 5** implements history and summary (read-only, PostgreSQL only; V1–V8). `NOT_SOLO_SESSION` (Phase 8): pause, resume and stop on a room session answer `409 NOT_SOLO_SESSION`; `GET /focus-sessions/current` and the history return room sessions with `context.kind = "room"` (RF11).

## Focusing with others (BD3–BD4, SC2–SC3, RR1)

| Method & route | Request | Response | Rules |
|---|---|---|---|
| `GET /buddies` | `?tz=` | `{ code, buddies, incoming, outgoing }` | Buddies show name, avatar, `focusingNow`, `currentStreak`, `weekFocusedSeconds` only. |
| `POST /buddies` | `{ code }` | `{ status: "requested" | "buddies" }` | Unknown or own code → `404 BUDDY_CODE_UNKNOWN`; ≤ 50 links (`409 BUDDIES_FULL`). |
| `POST /buddies/:userId/accept` | — | `204` | Only a request they sent you (`404 NOT_BUDDIES`). |
| `POST /buddies/:userId/nudge` | — | `204` | Accepted buddies only; once an hour per pair (`429 RATE_LIMITED`). Sends `buddy:nudge`. |
| `DELETE /buddies/:userId` | — | `204` | Unfriend, decline or cancel; idempotent. |
| `GET /rooms/:roomId/schedules` | — | `{ schedules }` | Members; each with `nextStartsAt`. |
| `POST /rooms/:roomId/schedules` | `{ title, startsAt, durationMinutes, repeatsWeekly? }` | `201 { schedule }` | Host only; future start; ≤ 20 per room (`409 SCHEDULES_FULL`). |
| `DELETE /rooms/:roomId/schedules/:scheduleId` | — | `204` | Host only. |
| `GET /me/upcoming-sessions` | — | `{ sessions }` | The next 24 hours across the caller's rooms. |
| `GET /rooms/:roomId/recap` | `?tz=` | `{ from, to, totals, roomStreak, people }` | Members; the last 7 local days. |

## AI features (AI2–AI6)

| Method & route | Request | Response | Rules |
|---|---|---|---|
| `POST /ai/first-step` | `{ taskId }` | `202 { job }` (new) or `200 { job }` (already running) | An open task of the caller's (`404 TASK_NOT_FOUND`, `409 TASK_NOT_OPEN`); another first-step job still running → `409 AI_JOB_BUSY`; 20 new per hour (`429 RATE_LIMITED`). |
| `POST /ai/weekly-reflection` | `{ week, tz }` | `202 { job }` or `200 { job }` | `week` is a local Monday not after today in `tz` (else `400`); 6 new per day. |
| `GET /ai/weekly-reflection` | `?week=` | `{ job \| null }` | The newest reflection asked for that week. |
| `GET /ai/jobs/:jobId` | — | `{ job }` | Owner-scoped (`404 AI_JOB_NOT_FOUND`). Poll while `status` is `queued` or `running`. |

A job is `{ id, kind, status, createdAt, finishedAt, failure, source, result }` plus `taskId` (first step) or `weekStart` (reflection). `failure` is `unavailable`, `declined`, `invalid_output` or `timed_out`; `source` is `model` or `mock`. Reading a job repairs one left behind (AI3).

## Goals and steps (GL1–GL4, SP1–SP3)

| Method & route | Request | Response | Rules |
|---|---|---|---|
| `GET /goals` | `?archived=true|false` | `{ goals }` | Active first, then completed, newest first; archived only on request. Each has `progress { openTasks, completedTasks, focusedSeconds }`. |
| `POST /goals` | `{ title, why?, targetDate?, color? }` | `201 { goal }` | Title 1–80, why ≤ 280, color one of `leaf, moss, fern, amber, berry, sky`. At most 50 active and completed goals (`409 GOALS_FULL`). |
| `PATCH /goals/:goalId` | `{ title?, why?, targetDate?, color?, status? }` | `{ goal }` | `status`: `active`, `completed` or `archived`. `null` clears why or date. Another user's or unknown → `404 GOAL_NOT_FOUND`. |
| `GET /tasks/:taskId/steps` | — | `{ steps }` | Creation order. |
| `POST /tasks/:taskId/steps` | `{ title }` | `201 { step }` | At most 30 per task (`409 STEPS_FULL`). |
| `PATCH /tasks/:taskId/steps/:stepId` | `{ title?, done? }` | `{ step }` | |
| `DELETE /tasks/:taskId/steps/:stepId` | — | `204` | |

Tasks (GL4, ES1–ES2): `POST /tasks` also takes `goalId?` and `estimatedSessions?` (1–20); `PATCH /tasks/:taskId` takes any of `title`, `goalId` (`null` detaches) and `estimatedSessions` (`null` clears). The goal must be the caller's and active (`404 GOAL_NOT_FOUND`, `409 GOAL_NOT_ACTIVE`). `GET /tasks?goalId=` lists one goal's tasks. Every task view carries `goalId`, `estimatedSessions`, `sessionsSpent` and `steps { total, done }`.

## Forest (GF1–GF5)

| Method & route | Request | Response | Rules |
|---|---|---|---|
| `GET /forest` | `?tz=` | `{ totals, vitality, plants, milestones }` | The caller's forest, derived from their ended sessions (nothing stored). Days and streaks in `tz`; at most 240 newest plants. |

## Weekly priorities (WR1–WR3)

| Method & route | Request | Response | Rules |
|---|---|---|---|
| `GET /weekly-priorities` | `?week=YYYY-MM-DD` (a Monday) | `{ week, priorities }` | The caller's three for that week, in position order; deleted tasks drop out, completed ones stay. |
| `PUT /weekly-priorities` | `{ week, taskIds }` (0–3, distinct) | `{ week, priorities }` | Replaces the week's list in order. Own, live tasks only (`404 TASK_NOT_FOUND`); a task new to the list must be open (`409 TASK_NOT_OPEN`). |

## Parked thoughts (PT1–PT5)

| Method & route | Request | Response | Rules |
|---|---|---|---|
| `GET /parked-thoughts` | — | `{ thoughts }` | Every open thought of the caller, newest first. |
| `POST /parked-thoughts` | `{ body, sessionId? }` | `201 { thought }` | Body trimmed, 1–200 characters. `sessionId` must be the caller's own session (404). At most 200 open thoughts (`409 THOUGHTS_FULL`). |
| `POST /parked-thoughts/:thoughtId/task` | — | `201 { task }` | Creates an open task with the thought's text and deletes the thought, in one transaction; a retry is 404. |
| `DELETE /parked-thoughts/:thoughtId` | — | `204` | Lets the thought go. |

Every route requires a bearer token and is scoped to the caller; another user's or an unknown thought is `404 NOT_FOUND`.

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
| `PUT /rooms/:roomId/blocks/:userId` | — | `200 { block }` | **Remove and block (B1–B8).** Host only. In one transaction under the room row lock: records the block, abandons the person's room focus session (`removed`) and deletes their membership; then evicts their sockets and emits `room:member:removed` with `blocked: true` (only if they were a member) and rejects a pending knock. Idempotent; also works on a non-member (pre-emptive). `409 CANNOT_REMOVE_HOST` for the host, `404 NOT_FOUND` for an unknown user. `429` at 30 per minute. `block` is `{ userId, displayName, avatarUrl, blockedAt }`. |
| `GET /rooms/:roomId/blocks` | — | `{ blocks }` | Host only. Newest block first. |
| `DELETE /rooms/:roomId/blocks/:userId` | — | `204` | Host only. Lifts the block, idempotent. Does not make the person a member (public: they may join; private: they must knock). |
| `POST /rooms/:roomId/knocks/:userId/approve` | — | `201 { membership }` or `200 { membership }` | Host only, private rooms only (`409 NOT_PRIVATE`). The knock must still be pending (`410 KNOCK_EXPIRED`); a user who is already a member → `200`. Upserts the membership, then removes the knock (if a concurrent reject or an expiry won that removal, the membership this call created is deleted again and the answer is `410 KNOCK_EXPIRED`), emits `room:knock:resolved` to the requester and `room:knock:removed` to the host, and `room:member:joined` to the room. `503` if Redis cannot say whether the knock is pending. |
| `POST /rooms/:roomId/knocks/:userId/reject` | — | `204` | Host only. Removes the knock and emits the same two events with `rejected`. Repeatable. `503` if Redis is unreachable. |
| `POST /rooms/:roomId/focus-participation` | `{ taskId?, shareIntention? }` | `201 { session }` (`200` for a repaired retry) | **Implemented in Phase 8 (RF4).** Opt in (D11). `shareIntention` (RI1, needs `taskId`) shows the task title to the room as the participant's `intention` (RI2). Members only (`404 ROOM_NOT_FOUND` otherwise, M4). In order: the timer must be in a focus phase (`409 NOT_FOCUS_PHASE`), the caller present in the room (`409 NOT_PRESENT`), no other in-progress session (`409 SESSION_IN_PROGRESS` with the existing session in `details`; the caller's own half-completed opt-in in this run is repaired instead), at least 60 s of the phase left (`409 RUN_ENDING`), an optional own, open, not-deleted `taskId` (`404 TASK_NOT_FOUND`, `409 TASK_NOT_OPEN`). `planned_seconds` = the remaining phase time. `409 RUN_CHANGED` when the run closed meanwhile (the just-created row is deleted). `429 RATE_LIMITED` (10 per 10 s). `503` when Redis cannot answer. The session's `context` is `{ kind: "room", roomId, focusRunId }`. |
| `DELETE /rooms/:roomId/focus-participation` | — | `200 { session }` | **Implemented in Phase 8.** Opt out → `abandoned(opted_out)` keeping the time focused so far. Does not require presence. Repeatable (returns the user's latest room session); `404 NOT_FOUND` if the user never took part. Same rate limit. |
| `GET /rooms/:roomId/focus-participation` | — | `{ focusRunId, participants, me, session }` | **Phase 8.** Members only. The current run, its participants (`userId, displayName, avatarUrl, optedInAtMs, connected, disconnectedAtMs`; never task titles or emails, RF14), the caller's own participation and their own in-progress session, for restoring a page. The run part is the join snapshot's `focus` shape and also carries `participantsVersion` (G2). |

- **Blocked people (B2):** `POST …/membership`, `GET /rooms/by-code/:code` and an approve of their knock answer `403 ROOM_BLOCKED` for someone the host blocked, before any `KNOCK_REQUIRED`; the socket `room:join` and `room:knock` answer the same code.
- Strict validation: unknown keys (for example a `hostId` or `userId` in a body), malformed UUIDs and codes, and out-of-range durations → `400 VALIDATION_FAILED`. Identity and the host always come from the token and PostgreSQL, never from the client.
- Persist, then emit: every announcement above happens after the PostgreSQL commit and is never able to change the response; a failed announcement is logged and the next read heals it (`failure-recovery.md`).

## Health

Health checks are split (P2):

| Method & route | Auth | Response |
|---|---|---|
| `GET /healthz` | Public | Liveness: `200 { status: "ok" }` whenever the process is running and able to respond. Never checks dependencies. |
| `GET /readyz` | Public | Readiness: `200 { status: "ready", checks: { postgres: "ok", redis: "ok" } }` when all required dependencies are reachable; otherwise `503 { status: "not_ready", checks: { … } }` with each failing check marked `"unavailable"`. |

## Rate limits (Phase 9, implemented)

Fixed-window counters in Redis (`ff:ratelimit:{action}:{subject}`); a refused request answers `429 RATE_LIMITED` with a `Retry-After` header (seconds). Behind Nginx the client address comes from `trust proxy` (production).

| Scope | Subject | Limit | If Redis cannot count |
| --- | --- | --- | --- |
| Every request except `/healthz` and `/readyz` | client address | 600 / minute | allowed (logged) |
| `POST /auth/login` | client address | 10 / minute | `503` |
| `POST /auth/signup` | client address | 10 / hour | `503` |
| `POST /auth/refresh` | client address | 60 / minute | `503` |
| `POST /rooms` (create) | user | 10 / hour | `503` |
| `GET /rooms/by-code/:code` (code lookup) | user | 30 / minute | `503` |
| `POST /rooms/:roomId/membership` (join) | user | 30 / minute | `503` |
| Room focus opt-in/out (Phase 8) | user | 10 / 10 s | `503` |
| `PUT /rooms/:roomId/blocks/:userId` (remove and block, B7) | user (host) | 30 / minute | `503` |

`HTTP_RATE_LIMIT=off` disables the Phase 9 limits for tests and the e2e stack; production configuration refuses it. Socket limits (chat, knock, join, timer) are unchanged. Socket connections (Phase 9 milestone 2, S1–S3): at most 60 connection attempts per client address per minute (`RATE_LIMITED`, counted before the token check, also switched by `HTTP_RATE_LIMIT`) and at most `SOCKET_MAX_PER_USER` (default 20) live sockets per user (`TOO_MANY_CONNECTIONS`, R4); see `api/socket-events.md`. Still to do in Phase 9: tuning from load tests.
