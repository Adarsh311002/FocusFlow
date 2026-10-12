# Decision Log

Approved decisions for Focus Flow v2. Each entry records what was decided, why, and what follows from it. Decisions are only changed by explicitly revisiting them; when that happens, record the new decision here and keep the old entry marked as superseded.

## Foundational decisions

These were approved as part of the v2 project context (see `CLAUDE.md`).

### F1 — PostgreSQL is the durable system of record
- **Decision:** PostgreSQL stores all durable application state. MongoDB is not carried into v2.
- **Why:** The domain (users, tasks, sessions, rooms, memberships) is relational, and history must be reliable.
- **Consequences:** If losing Redis would permanently lose user data, that data belongs in PostgreSQL.

### F2 — Redis is for disposable state and infrastructure
- **Decision:** Redis holds ephemeral state (presence, live timer state, pending knocks), caching, queue infrastructure and rate limiting.
- **Consequences:** Every Redis-held fact must be either rebuildable or safe to lose. See `architecture/redis-keys.md`.

### F3 — TypeScript throughout the Node.js ecosystem
- **Decision:** React, Express, Socket.IO, Node workers and shared contracts are written in strict TypeScript. No new JavaScript files. The legacy JavaScript is migrated deliberately, not left mixed.
- **Consequences:** Zod runtime schemas, inferred types, typed Socket.IO events, branded IDs, and discriminated unions (see `architecture/contracts.md`). Domain/API contracts stay separate from persistence types.

### F4 — Python owns AI
- **Decision:** AI orchestration (LangChain/LangGraph) and LLM calls live in a dedicated Python service. Node owns the application/API boundary. AI is a later phase, not part of the MVP.

### F5 — REST for durable changes, Socket.IO for live state
- **Decision:** Stored-data mutations generally use REST. Live state, real-time notifications and room synchronization use Socket.IO. When a REST operation changes persisted state that others need to know about, the server persists first and then emits.

### F6 — The server is authoritative for shared room state
- **Decision:** Clients render shared state (such as the room timer) from server data; they never own it.

### F7 — Socket identity comes from authentication, never from payloads
- **Decision:** User identity, role and host status are derived from the authenticated socket connection. Payload fields claiming identity are never trusted.

## Domain decisions

### D3 — The current focus task belongs to the user
- **Decision:** Store it as `users.current_task_id`. Do not use an `is_active` flag on tasks.
- **Why:** "What I'm focusing on" is a property of the user, not of a task.
- **Consequences:** The task must belong to the same user (composite foreign key). A deleted task can never be current (see D38).

### D4 — A focus session may reference a task
- **Decision:** A FocusSession may optionally reference a Task, for both solo and room sessions.
- **Why:** It links "decide what to work on" to "focus" in the core loop.

### D5 — Breaks are not focus sessions
- **Decision:** Pomodoro break phases are not persisted as FocusSession records in the MVP. A FocusSession represents actual focused work.

### D6 — Solo pause accounting
- **Decision:** `focused_seconds` stores the accumulated focused time; `running_since` marks the current active stretch. Pause adds the elapsed stretch to `focused_seconds` and clears `running_since`; resume sets `running_since = now`. Individual pause intervals are not stored in the MVP.
- **Why:** Solo session state stays entirely in PostgreSQL, survives page refreshes and Redis loss, and needs no extra table.

### D7 — Room chat is temporary
- **Decision:** Room chat is not persisted in the MVP. There is no `room_messages` table unless this decision is revisited.

### D8 — Rooms are persistent spaces
- **Decision:** Rooms are persistent shared focus spaces, not one-time meetings. A room does not disappear when everyone leaves. Whether a room is "live" is derived from Redis presence, not stored. Rooms may eventually be archived.

### D9 — Public room membership
- **Decision:** Joining a public room creates a persistent `room_members` record; joining again is idempotent. Membership is an access/history relationship and enables a future "My Rooms" view. Private rooms require explicit host approval.
- **Consequences:** Every `room:join` requires a membership record, for public and private rooms alike.

### D10 — Host disconnect
- **Decision:** The room timer is server-authoritative. If the host disconnects while the timer runs, it continues; if it is paused, it stays paused. Host ownership is not transferred automatically in the MVP.
- **Consequences:** If a host never returns, the room's timer can no longer be started (presence, chat and solo sessions still work). This is an accepted MVP limitation.

### D11 — Room focus sessions are opt-in
- **Decision:** Presence does not imply productivity. A user explicitly opts into the shared focus phase. Only opted-in users receive a FocusSession record.

### D14 / D15 / D35 — The meaning of "completed"
- **Decision:** There is one meaning of "completed" across solo and room sessions. A FocusSession is `completed` only when the planned focus period has been reached **and** the user is confirmed present at the end.
  - Present at completion → `completed`.
  - Actively running session, temporarily disconnected → 60-second reconnect grace. Reconnect within grace → the session continues and can complete. Grace expires → `abandoned(grace_expired)`.
  - Paused **solo** session: a disconnect does not start the grace; the session stays paused. If it stays unresolved too long, stale-session cleanup marks it `abandoned(expired)`.
  - Solo early stop → `abandoned(stopped)`, keeping the actual `focused_seconds`.
  - Stale solo sessions are never allowed to block the user permanently.
- **Why:** Solo and room history must mean the same thing so that review, analytics and future AI features can rely on it. Pausing is an explicit user action, so it is not treated like an unexpected disappearance.
- **Consequences:** Solo sessions need a presence signal, which is the user's authenticated socket. Solo completion is server-driven. The exact cleanup timing is a technical detail.
- **Accepted consequence:** On mobile, locking the screen usually drops the socket; an actively running session is then abandoned after 60 seconds.

### D16 — Room phase durations are persisted per room
- **Decision:** Focus, short-break and long-break durations are stored per room in PostgreSQL, with defaults. The host may change them. A change takes effect from the next phase, never retroactively. Redis holds the live copy while the timer runs.
- **Why:** Under D8 a room is a lasting space, and its rhythm is part of what the room is. Durations are configuration, not live timer state.
- **Consequences:** A phase's duration is fixed when the phase is created. To apply new durations immediately, the host resets (which abandons opted-in sessions under D17).

### D17 — Reset or phase change during focus
- **Decision:** If the host resets the timer, or changes away from a focus phase, while users are opted into the current focus run, those in-progress room FocusSessions are marked `abandoned` with reason `reset` or `phase_changed`. The participant set is cleared and a new `focusRunId` is issued.

### D19 — Disconnect grace in rooms
- **Decision:** An unexpected disconnect does not immediately abandon a room FocusSession. The participant gets a 60-second reconnect grace. Reconnect within grace preserves participation; otherwise the session is `abandoned(grace_expired)`. An intentional room leave is an immediate abandonment.
- **Scope:** Applies to room participants whether the room timer is running or paused. (The paused-session exemption in D14/15/35 applies to solo sessions only.)

### D38 — Tasks are soft-deleted
- **Decision:** Tasks have `deleted_at` and disappear from normal task lists. Historical FocusSessions keep their task relationship. A deleted task cannot remain the user's current task. Physical deletion may happen later as part of account deletion or retention policy.
- **Why:** Review history ("50 minutes on X") must survive task cleanup.
- **Consequences:** task references use plain foreign keys (P1).

### D43 — Completing the current task clears it
- **Decision:** when a task is completed, it is cleared as the user's current task if it is currently selected.
- **Consequences:** the current task is always an open, non-deleted task; `PUT /me/current-task` rejects completed tasks (`409 TASK_NOT_OPEN`); reopening a task does not make it current again.

## Authentication decisions

### D1 — Google account linking
- **Decision:** Never link Google to an existing password account automatically just because the verified emails match. If Google sign-in finds a password account with that email and no linked Google identity, refuse the merge and tell the user to sign in normally and link Google explicitly from account settings. The user model includes `email_verified_at`; Google-created accounts may be marked verified.
- **Why:** Automatic linking allows account pre-hijacking when password signups don't verify email ownership.

### D44 — Explicit Google linking is part of the MVP
- **Decision:** the explicit Google-account linking endpoint (`POST /api/v1/me/identities/google`) is part of the MVP, in Phase 1b.
- **Why:** D1 refuses automatic merges and sends users to link Google explicitly; the endpoint makes that path real.

### D23 — Per-device sessions and rotating refresh tokens
- **Decision:** Auth sessions are per device. The refresh token lives in an httpOnly cookie and is rotated on every refresh. Reuse of an already-rotated token revokes that session; a short previous-token overlap window prevents simultaneous refreshes from being treated as theft. Access tokens are short-lived and kept in client memory. Exact lifetimes are set during implementation.
- **Consequences:** The refresh token encodes its session ID so reuse of any older token can be detected; revocation is checked on REST and socket authentication. See `architecture/auth.md`.

## Implementation decisions

Approved with the implementation plan. Full details: `implementation/plan.md`.

### I1 — Monorepo
- **Decision:** one repository using pnpm workspaces.
- **Why:** frontend and backend share contracts; one change should update and test both sides together.

### I2 — Repository structure
- **Decision:** `apps/web`, `apps/api`, `packages/contracts`, `infra/`, `docs/`; `e2e/` when required; `services/ai` later.

### I3 — Package manager
- **Decision:** pnpm, with the version pinned in `packageManager` and workspace catalogs where useful.
- **Why:** strict dependency resolution prevents using undeclared packages (the legacy app imported six); good filtering and Docker pruning.

### I4 — Frontend stack
- **Decision:** React + TypeScript + Vite; TanStack Router; TanStack Query; Zustand for live room state; a typed `fetch` wrapper instead of Axios; typed `socket.io-client`; Tailwind CSS v4; Zod shared contracts; native forms initially; Radix primitives only where actually needed; no animation library yet (visual design deferred).

### I5 — Backend stack
- **Decision:** Node.js 24 LTS; Express + TypeScript; Socket.IO; ESM; `pino` / `pino-http`; `jose`; argon2id; Zod environment validation; a light service layer; no generic repository abstraction; no dependency-injection container.

### I6 — Database
- **Decision:** PostgreSQL 18; Drizzle ORM with `node-postgres`; SQL migrations generated, reviewed and committed; UUIDv7 IDs; `timestamptz`; snake_case naming; `CHECK` constraints instead of PostgreSQL enums; explicit constraint and index names; `READ COMMITTED` by default.
- **Why Drizzle:** expresses composite foreign keys, partial indexes and CHECK constraints directly; keeps SQL visible (PostgreSQL learning goal); schema in TypeScript with inferred types and no generation step.

### I7 — Redis and jobs
- **Decision:** Redis, BullMQ and `ioredis`. Worker code lives in the same codebase as the API and initially runs inside the API process, with its own entry point/role so it can become a separate deployment later. The reconciler is included as designed.

### I8 — Timer implementation
- **Decision:** timer state transitions are a pure TypeScript function. Redis `TIME` provides the authoritative clock. The resulting state is written with a small, version-checked atomic Redis operation; conflicts cause a bounded re-read and retry. Lua stays small and contains no business logic. Property tests must cover the pure state machine and the concurrency assumptions.
- **Why:** the logic is testable with a fake clock and written in the same language as the rest of the system, while atomicity and the single clock are preserved.
- **Supersedes:** the earlier architecture direction in which each timer command was computed inside a Lua script.

### I9 — Local development
- **Decision:** PostgreSQL and Redis run in Docker; the web app and API run natively on Windows. The new Compose file is `infra/compose.yaml`, and root scripts invoke `docker compose -f infra/compose.yaml`. The legacy root `docker-compose.yml` stays untouched. Local development is same-origin via the Vite proxy.

### I10 — Testing
- **Decision:** Vitest, Testing Library, fast-check, Testcontainers; Playwright when room functionality arrives.

### I11 — Code quality
- **Decision:** ESLint 9 with strict type-aware TypeScript rules, Prettier, lefthook, Conventional Commits. No new JavaScript, no `any`, no unsafe casts. CI runs typecheck, lint, format check, tests and builds.

### I12 — Legacy strategy
- **Decision:** `Client/` and `Server/` remain untouched. v2 is built in the new `apps/` structure, with no gradual JavaScript-to-TypeScript conversion of the legacy app. Legacy code is not deleted before the solo-core milestone. `archi/` is not modified or committed unless explicitly instructed.

### P1 — Plain foreign keys for task references
- **Decision:** `users.current_task_id` and `focus_sessions.task_id` are plain foreign keys with no `ON DELETE` action. Nothing relies on `ON DELETE SET NULL`.
- **Why:** tasks are soft-deleted (D38), so normal task deletion never removes a task row.
- **Consequences:** when full account deletion is implemented (D2), the account-deletion transaction clears `users.current_task_id` before deleting the user's data.

### P2 — Split health checks
- **Decision:** `GET /healthz` reports that the process is alive; `GET /readyz` reports that required infrastructure (PostgreSQL, Redis) is reachable.
- **Why:** orchestrators restart on failed liveness but only stop routing traffic on failed readiness; a database outage should not cause restart loops.

### P3 — Configurable Redis key prefix
- **Decision:** all application Redis keys use a configurable prefix (`REDIS_KEY_PREFIX`, default `ff:`), and BullMQ keys use the corresponding configured prefix (default `ff:bull`).
- **Why:** one namespace per deployment, and an isolated key space per test file in a shared Redis.

## Tasks implementation decisions (Phase 2)

Approved at the start of Phase 2 from the Phase 2 reconnaissance.

### T1 — Read a single task
- **Decision:** `GET /tasks/:taskId` returns one of the user's live tasks.
- **Why:** the current task must be shown even when it is not on a loaded list page; later focus-session features need the same read.
- **Consequences:** same ownership rule as every task route: another user's, a deleted or a nonexistent task is `404 TASK_NOT_FOUND`.

### T2 — Task ordering and pagination
- **Decision:** task lists are newest-created first, ordered by UUIDv7 `id DESC`, with keyset pagination on `id` behind an opaque cursor. One full index `ix_tasks_user_id_id (user_id, id DESC)`. No `completed_at`-based ordering and no second cursor.
- **Why:** UUIDv7 ids sort by creation time, so one key serves ordering and the cursor. A full (not partial) index also serves the `ON DELETE CASCADE` from `users`, which must reach soft-deleted rows.
- **Consequences:** supersedes the earlier sketch `INDEX (user_id, created_at) WHERE deleted_at IS NULL` in `domain/model.md`.

### T3 — Current-task synchronization on the client
- **Decision:** after completing or deleting the currently selected task, the client re-reads `GET /me` and updates its user state. Task responses do not carry a `currentTaskCleared` flag.
- **Why:** the server alone decides (D43, D38); the client does not guess, and task responses stay about tasks.

### T4 — No optimistic updates in Phase 2
- **Decision:** deferred. Phase 2 uses server responses plus pending states only.
- **Consequences:** I4 still allows optimistic updates for tasks later.

### T5 — Task management on the dashboard
- **Decision:** task management lives on `/dashboard`, with the current task shown prominently.

### T6 — Task limits
- **Decision:** title 1–200 characters after trimming; list limit default 50, maximum 100; no per-user task count cap for now.

## Real-time foundation decisions (Phase 3)

Approved at the start of Phase 3 from the Phase 3 reconnaissance.

### R1 — Presence keys
- **Decision:** one presence entry per socket in `ff:user:{userId}:sockets` (`{instanceId}:{socketId}`) and in the reverse index `ff:instance:{instanceId}:sockets` (`{userId}:{socketId}`); `ff:instances` is a sorted set scored by each instance's last heartbeat (Redis TIME).
- **Why:** dead-instance cleanup reads exactly one instance's entries without scanning user sets, and the last heartbeat time survives the instance's death ("disconnected at the last heartbeat").
- **Consequences:** supersedes the earlier sketch of a TTL string per instance plus a plain set.

### R2 — Redis TIME is the protocol clock
- **Decision:** Redis TIME is authoritative for `time:sync`, instance heartbeats and the future room timer. API `Date.now()` is not used for these calculations.

### R3 — Revocation decision (required security fix; revised after the Phase 3 review)
- **Current decision (review fix R-2, Option A):** the Redis marker is a positive shortcut only. Marker present → revoked, no PostgreSQL query. No marker, or Redis unreachable → PostgreSQL (`auth_sessions.revoked_at`, one primary-key lookup) decides. PostgreSQL needed but unavailable → fail closed with a temporary 503 / `INTERNAL`. REST and the Socket.IO handshake share the check.
- **Why it was revised:** the absence of a key in a non-durable cache cannot prove a write never happened. A marker can be missing while the epoch survives — its write failed while Redis was briefly unreachable, or Redis lost the last second of writes (AOF `everysec`) or failed over to a lagging replica — and the original rule then trusted "no marker" behind an old epoch. Only PostgreSQL can answer "not revoked". Option B (keep the Redis fast path and repair markers from PostgreSQL with a `LISTEN/NOTIFY` watermark) was rejected: far more machinery, and it only narrows the window.
- **Consequences:** every authenticated REST request and socket handshake makes one primary-key lookup on `auth_sessions` (both already query PostgreSQL, so availability is unchanged in practice; connected sockets are not re-checked per event). The epoch remains for Redis data-loss detection and recovery; its creation time no longer affects revocation.
- **Review fix R-1 (part of the current decision):** when Redis itself is unreachable PostgreSQL decides, and if PostgreSQL is also unavailable the check returns the temporary 503 / `INTERNAL` instead of "not revoked" (the Phase 1 fallback had let the request through).
- **History (superseded, not in effect):** the first Phase 3 version trusted "no marker" once `ff:epoch` was at least one access-token lifetime old (a "trust-loss window" covering only the loss of all Redis data), and consulted PostgreSQL only while the epoch was missing or younger. Review finding R-2 showed a single missing marker behind an old epoch was still trusted, which led to the current decision.

### R4 — Per-user socket cap
- **Decision:** deferred to the abuse/rate-limiting hardening work.

### R5 — Socket.IO transports
- **Decision:** keep the default polling → WebSocket upgrade; do not force WebSocket-only.
- **Consequences:** more than one API instance behind a load balancer needs sticky sessions (Phase 9).

### R6 — Real-time timing defaults
- **Decision:** `pingInterval` 10 s, `pingTimeout` 10 s, heartbeat 10 s, instance TTL 30 s, reconciler every 30 s plus at startup; all configurable.

### R7 — Worker-only role
- **Decision:** `ROLE=all` is the normal mode; `ROLE=worker` runs workers without an HTTP listener. Worker health endpoints are revisited when there is a real separate worker deployment.

### R8 — No user-facing events in Phase 3
- **Decision:** Phase 3 is infrastructure only: no `tasks:changed` or other product events.

## Presence hardening decisions (Phase 4A)

Approved at the start of Phase 4 to close the Phase 3 presence findings P-1 (a missed disconnect leaves a stale entry), P-2 (re-assertion races a disconnect and is not retried) and P-3 (the offline signal is lossy).

### H1 — Two-way presence sync on every heartbeat
- **Decision:** each instance reconciles its live Socket.IO sockets against its reverse index after every heartbeat, and at once after a reconnect, an epoch change or a rejoin. It adds missing entries and removes stale ones from both sets in one transaction, queued in the same synchronous step that reads the live sockets. Single-flight; a failed sync or rejoin is retried by the next heartbeat.
- **Consequences:** any missed presence write is repaired within one heartbeat interval. No Lua, no per-entry TTLs, no new keys.

### H2 — Offline events are hints carrying `disconnectedAtMs`
- **Decision:** the offline event is `{ userId, reason, disconnectedAtMs }` with reason `disconnect`, `missed_disconnect` or `instance_dead`; `disconnectedAtMs` is the Redis TIME of the removal, of the detecting sync, or the dead instance's last heartbeat. Events may be missed, repeated (with the same key) or stale, so no Solo Focus outcome is decided from one: every decision re-checks presence (`checkUser`, one atomic read with Redis TIME) and is retried rather than taken when that check fails.
- **Consequences:** consumers collapse repeats by `(userId, disconnectedAtMs)`; the reconciler's sweep of running solo sessions is the durable backstop. No presence tables, log, outbox or streams.
- **Amended by E10 (Phase 4B):** a fourth reason, `instance_shutdown`, reports entries removed by an instance's own clean shutdown (Phase 4A reported them as `disconnect`). `disconnect` then means only a socket's own disconnect handler.

### H3 — Late grace for a missed disconnect
- **Decision:** when the reconciler finds a running solo session whose user is offline with no disconnect marker, and Redis has **not** lost its data during the running stretch (the current epoch was not created after `running_since`), it starts a normal 60-second grace from the detection time instead of marking the session `expired`. `expired` remains for the case where the epoch changed during the stretch.
- **Consequences:** an infrastructure fault no longer discards a user's focused stretch; recorded time can be over-counted by at most the detection delay. Implemented with Solo Focus (Phase 4B); Phase 4A supplies `checkUser` and the event timestamps it needs.
- **Refined by E9:** "the epoch changed during the stretch" means *definitely* changed, `epochCreatedAtMs > runningSinceMs + 2000`; an ambiguous comparison gives late grace, never `expired`.

### H4 — Online hint
- **Decision:** presence emits an online event when a socket of a user is newly recorded (connect, or a sync re-adding it), so the future disconnect marker can be cleared early. Like the offline event it is a hint; grace expiry re-checks presence regardless.

## Solo Focus decisions (Phase 4B)

Approved after the Phase 4B reconnaissance (E1–E14) and its follow-up review (E15, E16, and the evidence and conditional-clearing rules in E8/E10). They refine D6, D14/15/35, H2 and H3 for the solo implementation; the full protocol is in `architecture/focus-timing-protocol.md`, "Solo sessions".

### E1 — Planned duration
- **Decision:** `planned_seconds` is an integer from 60 to 14,400 (1 minute to 4 hours), enforced by the Zod request schema and a PostgreSQL `CHECK`.

### E2 — Stale session window
- **Decision:** a solo session still in progress 12 hours after `started_at` is `abandoned(expired)` by the reconciler, keeping only the time accumulated before any current running stretch.

### E3 — Task at start
- **Decision:** `taskId` is optional. When supplied it must be the user's own task, not deleted (`404 TASK_NOT_FOUND`) and open (`409 TASK_NOT_OPEN`), locked `FOR SHARE` while the session is inserted. The server never infers `users.current_task_id`; the client sends the task it wants.

### E4 — No room columns yet
- **Decision:** Phase 4B's `focus_sessions` has no `room_id` or `focus_run_id`. Phase 6 adds them, with their `CHECK`s and index.

### E5 — Solo abandon reasons only
- **Decision:** the Phase 4B `abandon_reason` `CHECK` allows only `stopped`, `grace_expired` and `expired` (and the contract's `AbandonReason` matches). The room-only reasons are added in Phase 6.

### E6 — Event on every transition
- **Decision:** `focus:session:updated` is emitted to `user:{userId}` after every committed transition: start, pause, resume, stop, completion and abandonment, whatever caused it.
- **Consequences:** every tab stays in step; clients apply the payload and refetch the current session, so duplicate, late or missed events heal themselves.

### E7 — The planned end wins
- **Decision:** a pause or stop at or after `T_end` runs the decision for a running session first, and its terminal outcomes win: if the session completes (E8, D35), that is the result; if the user is offline and the current session's disconnect marker has outlived its grace, the result is `abandoned(grace_expired)` at the disconnect; if Redis definitely lost its data during the stretch and no observed disconnect proves presence through the end (E9), the result is `abandoned(expired)` — the outcomes the end job and the grace job reach, so it never depends on which of them takes the row lock first. Otherwise the pause or stop applies with `focused_seconds` capped at `planned_seconds`. When the decision cannot be made (presence or epoch unknown, or inside the presence-recovery window of E18, with no observed proof through the end) the request answers `503` and changes nothing (H2). Before `T_end` a pause or stop is unaffected.
- **Revised** after the review of the E8/E16 fix (2026-10-09): a pause or stop after a definite Redis loss previously applied as a pause or stop, while the end job expired the same session.

### E8 — Presence through the end
- **Decision:** a disconnect recorded with **observed** evidence at or after the planned end (`disconnectedAtMs + tolerance ≥ T_end`, E9) means the user was present through it: the session completes with `ended_at = T_end`. `detected` evidence (E10) never proves this. An online-now hint alone never proves presence at `T_end`; every completion decision uses the session's timing and its disconnect marker (the decision table in the protocol). Being online at the decision proves presence at `T_end` only when no disconnect of the current stretch is recorded **and** Redis has not definitely lost its data during the stretch (E9) — the normal D35 completion — or through E16 in the grace job of exactly the recorded disconnect. While a disconnect is recorded, the end job, the reconciler and a pause or stop never complete because the user is online now. After a definite Redis loss during the stretch, without observed proof, the session is `abandoned(expired)` even if the user is online, whichever caller decides — a pause or stop included (E7); an unknown presence or epoch is retried (jobs) or answered `503` (pause/stop). Observed proof through the end decides on its own and needs neither presence nor the epoch.
- **Revised** after the Milestone 3 audit (2026-10-09): the earlier protocol table let any decision complete an online user at or after `T_end` whatever the marker held.

### E9 — Two clocks, one tolerance
- **Decision:** PostgreSQL is the clock for durable session timestamps and focused-time arithmetic; Redis `TIME` for presence and epoch instants. Comparisons between the two use `CLOCK_SKEW_TOLERANCE_MS = 2000` and are biased toward grace rather than expiry:
  - `disconnectedAtMs + tolerance ≥ T_end`, with `observed` evidence (E10) ⇒ present through the end;
  - `epochCreatedAtMs > runningSinceMs + tolerance` ⇒ definite Redis loss during the stretch;
  - otherwise: not definite — prefer grace (or "unknown, retry") over `expired`.
- **Consequences:** a Redis instant stored as `ended_at` is first clamped into `[running_since, T_end]`. The PostgreSQL clock is read as `date_trunc('milliseconds', clock_timestamp())` after the session row lock is held — not `now()`, which is fixed at transaction start and could predate a `running_since` committed while the request waited for the lock.

### E10 — Monotonic disconnect marker
- **Decision:** one key per user, `ff:user:{userId}:disconnected`, value `{sessionId}:{latestDisconnectedAtMs}:{evidence}`. `evidence` is `observed` for a direct socket disconnect, and `detected` for `missed_disconnect`, `instance_dead` (the last heartbeat does not prove when the socket went away), `instance_shutdown` (a new offline reason for a clean shutdown's cleanup, which reports the cleanup time) and late grace. Only observed evidence can prove presence through `T_end` (E8); detected evidence can start or extend a grace. Updated only with `WATCH`/`MULTI` and bounded retry (no Lua, not `SET NX` alone): an older disconnect for the same session changes nothing; an equal one can only upgrade `detected` to `observed`, never the reverse; a newer one replaces it (with its own evidence); a marker of another session is replaced, because only one session per user can be in progress. An event or marker whose Redis timestamp predates the session's current running stretch (`t + 2000 < runningSinceMs`, E9) is ignored. A grace job settles only if the marker still holds exactly its payload's session and `disconnectedAtMs`.
- **Clearing is always conditional:** on a confirmed reconnect the marker is deleted only if it still belongs to that session and is not newer than the confirmation time — and an online hint clears it only before `T_end` and only while the reconnect is inside that disconnect's grace; after `T_end`, or once the grace ran out, it keeps the marker and makes sure its grace job is scheduled (E8, E16); on pause, resume, stop or settlement only if it still belongs to that session. A marker is never deleted unconditionally, so a delayed cleanup of an ended session (`S1`) can never remove the marker of the user's next session (`S2`). Same `WATCH`/`MULTI` with bounded retry.
- **Consequences:** a lost online hint followed by a second disconnect no longer leaves the first disconnect in charge; each disconnect owns its own grace job; a late-detected absence can never complete a session.
- **Accepted limitation:** a newer `detected` disconnect may replace an older `observed` one for the same session. This can lose a completion proof and send the session through grace instead; it can never create a false completion.

### E11 — Repeats on ended sessions
- **Decision:** pause or resume on an ended session answers `200` with the session unchanged (as stop already did). No `INVALID_TRANSITION` error for solo sessions.

### E12 — Web state
- **Decision:** the web client keeps the session in TanStack Query only: no optimistic updates, no Zustand.

### E13 — Test tooling
- **Decision:** add `fast-check` now for the solo timing and transition properties. Playwright stays deferred to the rooms phase (I10).

### E14 — Round down
- **Decision:** partial seconds are rounded down at every pause, stop and settlement; completion sets `focused_seconds = planned_seconds` exactly.
- **Consequences:** a session paused and resumed many times may be under-counted by up to one second per pause; it is never over-counted.

### E15 — Additional session invariants
- **Decision:** besides E1 and E5, the database enforces `0 ≤ focused_seconds ≤ planned_seconds`, `ended_at ≥ started_at`, `running_since ≥ started_at`, and `status <> 'completed' OR focused_seconds = planned_seconds`.

### E16 — Reconnect-within-grace recovery
- **Decision:** only a **grace job** whose marker still holds exactly its session and `disconnectedAtMs`, finding the user online (typically a grace job that ran late after the online hint was lost), treats it as a reconnect within grace: it clears the marker and the session continues, or completes at `T_end` if the planned end has passed — unless Redis definitely lost its data during the stretch, which makes it `abandoned(expired)` (E9). The end job, the reconciler and HTTP pause/stop never apply it merely because the user is online now: with a disconnect still recorded, the end job and the reconciler hand over to that disconnect's grace job, and a pause or stop is not a completion (E7).
- **Why:** the exact reconnect time is unknowable; this is an intentional D35/H2 recovery policy that favours the user rather than penalising them for a server-side delay. Scoping it to the grace job keeps E8: being online now is never, by itself, proof of presence at `T_end`.
- **Revised** after the Milestone 3 audit (2026-10-09): originally worded as "when a decision finds the user online", which applied it to every caller.

## Solo Focus recovery decisions (Phase 4B, Milestone 4)

Approved in the Milestone 4 (reconciler and recovery) plan review, 2026-10-12, as A–G. They change no outcome of E1–E16; they make the decisions read trustworthy inputs and make recovery reliable.

### E17 (A) — Fresh epoch for every decision
- **Decision:** every decision for a running session (end job, grace job, reconciler, pause/stop at or after `T_end`) reads the epoch in the **same atomic Redis read** as presence (`checkUser`: Redis TIME, the user's entries, the heartbeats and `ff:epoch` in one `MULTI`), after the session row lock is held. A cached epoch (the instance's last observed value) is never used for a decision. A missing or malformed epoch is unknown.
- **Consequences:** a FLUSHALL is visible to the very next decision on every instance, not only after that instance's next heartbeat. PostgreSQL and Redis are still not one transaction: a decision reflects the Redis instant it read and is committed under the row lock; Redis can change after that read (a reconnect, a new disconnect, a data loss), and the follow-ups after the commit are separate steps made safe by monotonic markers and idempotent jobs, not by atomicity. The marker is read separately just before (so E8 still decides when the presence read fails).

### E18 (B) — Presence-recovery window
- **Decision:** for `INSTANCE_TTL_MS` (30 s) after an epoch is created — Redis TIME, `[epochCreatedAtMs, epochCreatedAtMs + INSTANCE_TTL_MS)` — presence is not trusted: the live instances are still re-adding their sockets (each ticks at least twice within the TTL; one that does not is dead). A presence check taken inside the window, or with an unknown epoch, defers **every presence-dependent decision**: jobs retry, the reconciler defers, pause/stop at or after `T_end` answer `503`. Qualifying E8 evidence (an observed disconnect through the end) keeps its precedence and decides inside the window too.
- **Consequences:** the window only delays decisions. After it the rules are unchanged: a definite Redis loss during the stretch without E8 proof is still `abandoned(expired)`, online or offline (E9); the window never turns that into a completion, and an empty presence map right after a loss never causes an expiry before the instances have had their chance to rebuild presence and record observed disconnects. Residual risk: an instance whose heartbeats keep failing throughout the window may still be missing sockets afterwards (the existing H1/H2 limitation).

### E21 (E) — Start and resume while presence is untrusted
- **Decision:** start and resume answer `503` (presence unavailable) and change nothing when the presence check failed, the epoch is unknown or the check is inside the presence-recovery window (E18). `409 NOT_CONNECTED` is answered only from a trusted check.

## Accepted architecture direction

The following are accepted as the design direction but were not approved as individual product decisions. They may be refined during implementation if they stay consistent with the decisions above:

- Focus runs and a Redis run ledger for settling room sessions.
- BullMQ delayed jobs for phase ends, solo session ends and grace expiry, plus a periodic reconciler.
- Workers send socket events through the Socket.IO Redis emitter, so moving them to a separate process needs no code change.
- UUIDv7 IDs are generated in the application; the database default `uuidv7()` is a fallback.
- Redis-loss detection through an epoch marker key, with `timer_lost` recovery.
- Knock approval over REST; knocks themselves over Socket.IO with a TTL.
- Same-origin deployment (frontend, `/api` and `/socket.io` behind one origin).
- Clock sources: Redis server time for room timer arithmetic (read with `TIME`, see I8); the PostgreSQL clock for stored timestamps and solo session arithmetic (`date_trunc('milliseconds', clock_timestamp())`, sampled after the session row lock is held, E9).
