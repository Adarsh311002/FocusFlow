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
- **Decision:** Focus, short-break and long-break durations are stored per room in PostgreSQL, with defaults. The host may change them. A change takes effect from the next phase, never retroactively. PostgreSQL owns the saved settings; Redis stores the active timer state including the active phase's duration, fixed when the phase is created. There is no separate Redis copy of the settings (RT8, accepted by the owner 2026-11-11).
- **Why:** Under D8 a room is a lasting space, and its rhythm is part of what the room is. Durations are configuration, not live timer state.
- **Consequences:** A phase's duration is fixed when the phase is created. To apply new durations immediately, the host resets (which abandons opted-in sessions under D17).

### D17 — Reset or phase change during focus
- **Decision:** If the host resets the timer, or changes away from a focus phase, while users are opted into the current focus run, those in-progress room FocusSessions are marked `abandoned` with reason `reset` or `phase_changed`. The participant set is cleared and a new `focusRunId` is issued.

### D17a — A phase that already reached its end is completed, even by a late command
- **Decision (owner-approved 2026-11-11; called "Rev J3" in code comments):** If a `reset` or `setPhase` command reaches a focus phase that has already reached its true end (its phase-end job has not run yet), the run closes `completed` with `closedAtMs = min(now, endsAt)`, not `reset`/`phase_changed`. People present at the end complete (D35); a disconnect recorded at or after the true end counts as present at the end, also when the delayed grace job runs before the delayed phase-end job (completed at the true end). A reset or phase change at least 1 ms before the end abandons as in D17.
- **Why:** the host's late command must not turn a finished focus period into an interruption, and a late job must not punish people who were present.

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
- **Consequences:** when full account deletion is implemented (D2, a deferred item), the account-deletion transaction clears `users.current_task_id` before deleting the user's data.

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

Approved in the Milestone 4 (reconciler and recovery) plan review, 2026-10-12, as A–G (E17–E23). They change no outcome of E1–E16; they make the decisions read trustworthy inputs and make recovery reliable.

### E17 (A) — Fresh epoch for every decision
- **Decision:** every decision for a running session (end job, grace job, reconciler, pause/stop at or after `T_end`) reads the epoch and the disconnect marker in the **same atomic Redis read** as presence (the decision snapshot: Redis TIME, the user's entries, the heartbeats, `ff:epoch` and `ff:user:{userId}:disconnected` in one `MULTI`), after the session row lock is held. Only if that snapshot fails is the marker read on its own, so qualifying observed evidence can still decide (E8); if that read fails too, nothing is decided. A cached epoch (the instance's last observed value) is never used for a decision. A missing or malformed epoch is unknown.
- **Consequences:** a FLUSHALL is visible to the very next decision on every instance, not only after that instance's next heartbeat. PostgreSQL and Redis are still not one transaction: a decision reflects the Redis instant it read and is committed under the row lock; Redis can change after that read (a reconnect, a new disconnect, a data loss), and the follow-ups after the commit are separate steps made safe by monotonic markers and idempotent jobs, not by atomicity. A successful snapshot observes the marker, presence and the epoch at one Redis instant, so a decision never combines a marker from an earlier read with later presence or a later epoch (a marker written between two separate reads could otherwise be missed while the later read sees the user offline and a definite loss — fixed in a follow-up commit after the Milestone 4 audit). A disconnect whose marker is not yet written at that instant is not evidence for that decision. **Remaining interval:** the socket entry is removed (Redis TIME = the disconnect instant) several Redis and PostgreSQL round trips before the offline handler records the marker (it finds the running session, re-checks presence, then records with WATCH/MULTI). A snapshot inside that interval sees the user offline with no marker: the decision is the one for "offline, no marker" — `abandoned(expired)` after a definite loss, otherwise late grace, whose newer `detected` marker then keeps out the older `observed` one (the accepted E10 limitation: the session goes through grace). It never invents a completion, and nothing re-decides an ended session. Closing this interval would need the removal and the marker write in one atomic step, which the presence module cannot do without knowing the session; not done.

### E18 (B) — Presence-recovery window
- **Decision:** for `INSTANCE_TTL_MS` (30 s) after an epoch is created — Redis TIME, `[epochCreatedAtMs, epochCreatedAtMs + INSTANCE_TTL_MS)` — presence is not trusted: the live instances are still re-adding their sockets (each ticks at least twice within the TTL; one that does not is dead). A presence check taken inside the window, or with an unknown epoch, defers **every presence-dependent decision**: jobs retry, the reconciler defers, pause/stop at or after `T_end` answer `503`. Qualifying E8 evidence (an observed disconnect through the end) keeps its precedence and decides inside the window too.
- **Consequences:** the window only delays decisions. After it the rules are unchanged: a definite Redis loss during the stretch without E8 proof is still `abandoned(expired)`, online or offline (E9); the window never turns that into a completion, and an empty presence map right after a loss never causes an expiry before the instances have had their chance to rebuild presence and record observed disconnects. Residual risk: an instance whose heartbeats keep failing throughout the window may still be missing sockets afterwards (the existing H1/H2 limitation).

### E19 (C) — Stale cleanup after the normal decision
- **Decision:** the reconciler runs the normal decision (step 5) first and the 12-hour stale cleanup (E2, step 6) after it. A session that step 5 settled keeps its terminal result; qualifying E8 evidence still completes a session first; but a session that is still in progress at the 12-hour threshold is `abandoned(expired)` even if step 5 had to defer it (presence unknown or recovering, the epoch unknown, Redis unavailable). The threshold is never extended because Redis is unavailable. Paused sessions are untouched before it.
- **Why:** stale sessions must never permanently block the user (D35), and a session 12 hours old (the longest plan is 4 hours) is long past any decision the recovery window was protecting.

### E20 (D) — Scheduling ensures the job
- **Decision:** scheduling an end or grace job, by any caller, **ensures** it: absent → added; waiting, delayed or active → left alone; retained by BullMQ as completed or failed → re-run with `Job.retry(state, { resetAttemptsMade: true, resetAttemptsStarted: true })` (BullMQ 6.3, the atomic `reprocessJob` script), so a job that exhausted its attempts gets them all back. `retry` throws when another caller moved or removed the job first; the actual state is then read again (bounded rounds).
- **Why:** `queue.add` with the id of a retained job is a silent no-op. A grace job that exhausted its attempts during a Redis or presence outage could otherwise never run again, and an online user whose disconnect is still recorded could only be resolved by that job (E16).
- **Consequences:** re-running a finished job is safe because every job is idempotent and re-reads everything under the row lock; only a committed transition publishes.

### E21 (E) — Start and resume while presence is untrusted
- **Decision:** start and resume answer `503` (presence unavailable) and change nothing when the presence check failed, the epoch is unknown or the check is inside the presence-recovery window (E18). `409 NOT_CONNECTED` is answered only from a trusted check.

### E22 (F) — Stale cleanup without Redis
- **Decision:** the 12-hour stale cleanup needs only PostgreSQL and also runs while Redis is unavailable (from each worker process's trigger, E23). It commits the expiry without waiting for Redis; the change's notification and marker clear then fail and are logged as failed — never reported as delivered.

### E23 (G) — Process-owned reconcile trigger and liveness threshold
- **Decision:** the repeating BullMQ schedule lives in Redis, so a FLUSHALL deletes it and nothing in Redis can restore it. Every worker-running process keeps its own timer (every `RECONCILER_INTERVAL_MS`, never overlapping itself): with Redis reachable it re-registers a missing schedule, and when the liveness record `ff:reconcile:last-finished` (Redis TIME, written by every finished run) is missing or at least **3 × `RECONCILER_INTERVAL_MS`** old (90 s by default; `reconcileOverdueAfterMs`) it runs the reconciler directly; with Redis unreachable it runs only the stale cleanup (E22). Within a process runs are single-flight; across processes they may overlap, which the session steps make safe by locking rows `FOR UPDATE SKIP LOCKED`.
- **Consequences:** at most one direct run per worker process per interval, and only while scheduled runs are not happening. The epoch's recovery hooks (re-register the schedule, enqueue a recovery run) stay as the fast path.

## Review decisions (Phase 5)

Technical defaults chosen while implementing Phase 5 (history and summary), 2026-10-16, where the docs left the details open (`api/rest.md` named only the parameters and the response shapes). They implement the D18 and D34 (deferred item) defaults and **await the owner's review**, like D18 and D34 themselves (`open-decisions.md`).

### V1 — History range parameters
- **Decision:** `GET /focus-sessions` takes optional `from` and `to` as **instants** (ISO-8601 with an explicit offset, at most millisecond precision) and returns sessions whose `started_at` lies in `[from, to)`; `from < to` when both are given. With neither, the whole history is paged. Each instant must also fall in `[1970-01-01T00:00:00.000Z, 9999-12-31T23:59:59.999Z]`; outside it the request is `400 VALIDATION_FAILED`.
- **Why:** history has no `tz`, so a calendar date could not be interpreted; a half-open range never counts a session twice across adjacent ranges. The instant bounds mirror V4's floor (no session can predate it) and stop at the last instant a four-digit ISO year expresses: a syntactically valid bound such as `0000-01-01T00:00:00+14:00` (BC era) or `9999-12-31T23:59:59.999-12:00` (year 10000) would otherwise reach node-postgres, which renders it in the server's local zone as a value no session can match, and answered `500` rather than `400`.

### V2 — History order, contents and pagination
- **Decision:** every status is listed, the in-progress session included, newest-started first: `ORDER BY started_at DESC, id DESC`, served by `ix_focus_sessions_user_id_started_at` (no migration). The cursor is the opaque id of the previous page's last session; the query resolves its `(started_at, id)` position inside PostgreSQL, scoped to the requesting user, so no timestamp passes through the client and a cursor naming another user's (or no) session is `400 VALIDATION_FAILED`. `limit` defaults to 50, maximum 100 (as T6). Each session's task comes from one `LEFT JOIN` on the task id **and** the owner, soft-deleted tasks included and marked `deleted` (D38).
- **Why:** `id` is generated by the API clock and `started_at` by the PostgreSQL clock, so ordering by `id` (as tasks do, T2) could disagree with the displayed and filtered start times; the id tie-break keeps pages stable when two sessions share a start time.

### V3 — Summary range parameters
- **Decision:** `GET /focus-sessions/summary` takes required `from` and `to` as **calendar dates** (`YYYY-MM-DD`, both included) in the required IANA zone `tz`. There is no default range: the server does not know the user's "today" without the client.
- **Why:** `days[].date` is a local date; instants would create partial first and last days with no clear meaning.

### V4 — Summary range limits
- **Decision:** `from ≤ to`, at most 366 days, no date before 1970-01-01. Otherwise `400 VALIDATION_FAILED`.

### V5 — Time zone validation and computation
- **Decision:** `tz` must be the exact name `UTC` or an `Area/Location` name that the runtime's IANA database (`Intl`) recognises (matched case-insensitively, legacy aliases such as `Asia/Calcutta` and fixed-offset names such as `Etc/GMT+5` accepted). Offsets (`+05:30`, `UTC+3`), abbreviations (`PST`) and POSIX rules (`EST5EDT`) are refused. All calendar arithmetic for the summary is done in Node with `Intl`; PostgreSQL never receives the zone.
- **Why:** checked during implementation: Node accepts `+05:30` while PostgreSQL reads it with the opposite sign; PostgreSQL treats `PST`/`EST` as fixed abbreviations and the postgres:18 image rejects aliases that browsers report (`Asia/Calcutta`). One engine for validation and computation removes every such mismatch, and the server's own time zone (or the database session's) is never used.

### V6 — What the summary counts
- **Decision:** only **ended** sessions. `completedCount` and `completedFocusedSeconds` count completed sessions; `totalFocusedSeconds` adds the recorded time of abandoned sessions of every reason (D34, a deferred item). In-progress sessions, running or paused, are excluded.
- **Why:** an in-progress session's `focused_seconds` excludes the current running stretch and is not final; counting it would make totals move and then be corrected.

### V7 — Daily buckets
- **Decision:** a session counts entirely on the calendar date, in `tz`, on which it **started** — also when it continued past midnight. `days` lists every date of the range, oldest first, zeros included, and each total equals the sum of its daily values. PostgreSQL sums the ended sessions per UTC minute of `started_at` over the range widened by two days on each side; the API maps each minute to its date with `Intl` and keeps the dates in the range.
- **Why:** pause intervals are not stored (D6), so the time actually focused on each side of midnight cannot be reconstructed; the start date is deterministic, matches the history filter and the index, and never changes after a session ends. Every UTC offset in use is a whole number of minutes, so a minute never straddles a local midnight; minute sums keep the rows bounded however many sessions a range holds.

### V8 — Review web page
- **Decision:** `/review` (authenticated) shows the last 7 days ending today in the browser's zone (falling back to `UTC` when the browser reports no valid IANA name), with both totals labelled, a per-day table and the paged history (the history list is the whole history, not restricted to the summary range: it sends no `from`/`to`). TanStack Query only, no optimistic updates (E12); review queries refetch whenever the page is shown and, since Milestone 5, whenever `focus:session:updated` (E6) arrives (W2).

### Solo Focus web decisions (Phase 4B Milestone 5)

Technical defaults chosen during implementation, awaiting the owner's review. Nothing here changes E1–E23: the server stays authoritative and the browser never decides an outcome.

### W1 — Placement
- **Decision:** the solo timer is a panel on `/dashboard`, above the tasks; there is no new route.
- **Why:** the loop is "decide what to work on, then focus", and the dashboard already shows the current task (T5). A separate page would only add navigation between two halves of one step.

### W2 — Source of truth and cache writes
- **Decision:** `GET /focus-sessions/current` is the truth. A lifecycle answer is written to the cache only after `cancelQueries`, and only about the session the cache already holds; a start alone may fill an empty cache. A late pause, resume or stop for another session therefore cannot replace or hide a newer one, and a session a read saw ending cannot be revived. `focus:session:updated` never writes the current session: it validates the payload, remembers a terminal session for the "what just happened" notice, and invalidates every `['focus-sessions', userId]` query (current, Review history, Review summary), restarting a read already in flight (and asking again once a still-loading first read settles) so that a read answered before the change cannot stand in for it. Every socket (re)connect, the first included, invalidates as well.
- **Why:** views carry no version, so responses and events can arrive in any order and cannot be ranked; the next read can. Events sent between the handshake and the room join are lost, so a connect must refetch. This also replaces V8's "refetch whenever the page is shown" as the only freshness mechanism. Residual: while the answer to a lifecycle request about the session on screen is late, the screen can show that answer's state for one round trip; the refetch that follows every answer corrects it. With no panel mounted nothing refetches until the next mount, which reads fresh.

### W3 — Countdown is display only
- **Decision:** remaining time = planned − focused − (server now − `runningSince`) when running, frozen when paused, clamped to `[0, planned]`; a note says the time may be off until the first clock sample. At 0:00 the panel shows "Finishing… waiting for the server to confirm" and re-asks the server (about 0, 2 and 5 s, then every 10 s). It never completes, abandons or stops a session.
- **Why:** completion can lag the planned end (jobs, grace, the presence-recovery window, E7, E8, E18) and a client clock can be wrong or throttled; D35 puts the decision on the server.

### W4 — Controls
- **Decision:** all lifecycle controls are disabled while any request is pending; a repeated request with the same variables joins the one in flight; `409 SESSION_IN_PROGRESS` on start adopts the existing session; every mutation error refetches because the request may have committed; stopping asks for an in-page confirmation; keyboard focus follows a replaced control only when focus is free or already inside the panel.
- **Why:** start is not idempotent but pause, resume and stop are (E11), and the session row lock serialises the rest (E7).

### W5 — Start form
- **Decision:** 15, 25 or 50 minutes, or custom whole minutes 1–240 (E1); an optional task from the open tasks, preselecting the user's open current task as a visible convenience; starting is not gated on the local socket state, so `409 NOT_CONNECTED` and `503` (E21) are shown as the server's answer.
- **Why:** E3 forbids the server inferring a task, not the form suggesting one; the local socket state can disagree with the server's presence record, which alone decides.

### W6 — Server emission of `focus:session:updated`
- **Decision:** the API publishes the event from a listener of its own on the after-commit change bus, separate from the job follow-ups, to `user:{userId}` derived from the session owner. It is typed in `packages/contracts` (`ServerToClientEvents`) and covers requests, jobs and the reconciler alike, since all publish through the same bus.
- **Why:** persist, then emit; a failing emit must not block scheduling, nor the reverse. The Redis emitter publishes without awaiting, so a failure cannot be caught, but its connection queues commands while Redis is away and clients heal on reconnect.

## Rooms decisions (Phase 6: M1–M13, accepted by the owner 2026-11-11 as the MVP baseline)

Chosen during implementation inside the approved design (D8, D9, D10, D16, D19, D20, D36, F5–F7); none changes an approved decision. Accepted by the owner on 2026-11-11 (tested implementation), subject to the changes recorded in the later sections. D20 and D36 (and D12, D24 below) are deferred, non-blocking items cited as defaults. Open owner questions stay in `open-decisions.md`.

### M1 — Scope and what waits for later phases
- **Decision:** Phase 6 adds rooms, memberships, knocks, room presence and temporary chat. (Time-bound: superseded by migration `0004` and RF1 in Phase 8.) It changed nothing in `focus_sessions`: the room columns (`room_id`, `focus_run_id`), the room-only abandon reasons (E4, E5), `NOT_SOLO_SESSION` and the abandonment of a participant on leave or removal arrive with Phase 8 (focus runs), which edits the same leave/remove transactions. There is no room timer, no timer events and no `timer`/`participants` in the join snapshot until Phases 7 and 8; both additions are additive.
- **Why:** a leave or removal can abandon nothing while no room participation exists; adding the columns without their writers would be a speculative schema.

### M2 — Room codes
- **Decision:** six characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no I, L, O, 0, 1), uppercase, generated with `crypto.randomInt`, unique (`uq_rooms_code`, `ck_rooms_code`). A collision is retried (at most 5 times) on the unique violation. Lookups forgive case and spaces. Codes do not expire and are not secret: a private room is protected by the knock, not by its code.

### M3 — Phase durations
- **Decision:** whole seconds: focus 60–14,400 (default 1,500), short break 60–3,600 (default 300), long break 60–7,200 (default 900), as `CHECK`s on `rooms`. `PATCH /rooms/:roomId/timer-settings` (host only) saves to PostgreSQL and emits `room:settings:updated` with `effectiveFrom: "next_phase"`. There is no Redis copy of the settings (RT8): phase creation reads them from PostgreSQL.

### M4 — Who may see what
- **Decision:** a room that does not exist, and a room the caller may not see, answer the same on member-only routes (`404 ROOM_NOT_FOUND`); a non-member never learns more than the preview `{ id, code, name, isPrivate }` that `GET /rooms/by-code/:code` gives anyone holding the code (`presentCount` is `null` for a private room's non-member). A member who is not the host gets `403 NOT_HOST` on host actions; a non-member gets `404`. Leaving a room one is not in answers `204` whether or not the room exists. On sockets a non-member's `room:join` answers `NOT_A_MEMBER`, also for a room that does not exist.
- **Why:** ownership routes elsewhere answer 404 so existence is not revealed (docs/api/rest.md); the preview is the one deliberate exception (D9 needs a way to find a room).

### M5 — Room presence
- **Decision:** the keys in `redis-keys.md`: `room:{roomId}:presence` (hash, `userId → { displayName, avatarUrl, firstJoinedAtMs }`) and `room:{roomId}:presence:{userId}` (set of `{instanceId}:{socketId}`), plus a per-instance reverse index `instance:{instanceId}:rooms` (`{roomId}:{userId}:{socketId}`). A socket counts only while its instance's heartbeat is fresh, like user-level presence. `room:presence:joined` is sent when a user's first socket joins, `room:presence:left` when the last one leaves, disconnects, is evicted or its instance dies. The existing H1 synchronisation is extended to rooms: after every heartbeat each instance makes its room entries match its sockets' Socket.IO rooms (both directions), and dead-instance cleanup removes an instance's room entries and announces who left. A socket's Socket.IO room membership (`socket.rooms`), not a client claim and not `socket.data.joinedRooms`, decides whether it may act in a room.
- **Why:** these are the approved keys; reusing the heartbeat and reverse-index pattern avoids a second liveness mechanism.

### M6 — `room:join`
- **Decision:** requires a membership row (D9) and is idempotent per socket. It answers a snapshot: the room, who is present, `pendingKnocks` for the host only, and `serverNowMs` (Redis TIME). Clients send `room:join` again after every socket (re)connect and after `room:resync`, for each room they are in. Navigating inside the app does not leave a room; only an explicit `room:leave`, a closed socket, removal or leaving the membership does. A new person is refused with `ROOM_FULL` when `ROOM_MAX_PRESENT` (default 50, the D12 safety limit; D12 is a deferred item) people are present.

### M7 — Knocks
- **Decision:** `room:knock` (private room, caller not a member, the host online — user-level presence, D20, a deferred item) stores the userId in the sorted set `room:{roomId}:knocks` scored by `expiresAtMs` (TTL `KNOCK_TTL_MS`, default 120 s) and sends `room:knock:received` to `user:{hostId}`; a repeated knock refreshes the entry. Knocks are limited to 5 per user per minute (`RATE_LIMITED`). `room:knock:cancel` removes the entry (`room:knock:removed` reason `cancelled`). Approve and reject are REST and host only: approve checks the knock is pending (`410 KNOCK_EXPIRED`; a user who is already a member → `200`), upserts the membership, then removes the knock and sends `room:knock:resolved` to the requester and `room:knock:removed` to the host; reject removes the knock and sends the same two events (`204`, repeatable). The host's pending list is delivered in the join snapshot and by live events; expiry is not announced.
- **Why:** PostgreSQL first, then Redis, then events (F5); if the last steps fail the requester re-checks access and finds the membership (failure-recovery.md).

### M8 — Chat
- **Decision:** `room:chat:send` needs a socket that is in the room. The body is trimmed, 1–1,000 characters. A `SET NX` key `ff:chat:dedupe:{userId}:{roomId}:{clientMessageId}` (60 s) holds the first `messageId:sentAtMs`; a repeat is answered with the same ids and not delivered again. Chat is limited to 10 messages per user per 10 s (`RATE_LIMITED`). `sentAtMs` is Redis TIME; `messageId` is a UUIDv7. Nothing is stored (D7); a late joiner sees no backlog (D24, a deferred item).

### M13 — Review hardening (found by the Phase 6 reviews)
- **Decision:** (1) `room:chat:send` re-checks the membership row (a primary-key lookup) and the heartbeat room sync batch-checks the memberships of its local sockets, taking any non-member's socket out of the room, so a lost eviction message cannot leave a removed member with access; a PostgreSQL failure evicts nobody and answers `INTERNAL` to chat. (2) The `ROOM_MAX_PRESENT` check runs inside the atomic join script. (3) The join snapshot reads presence last, after the slow host-only queries; the web client buffers presence events between sending `room:join` and its answer and replays them over the snapshot. (4) Chat de-duplication is per user and room, and the web client matches its own echo on `clientMessageId` and sender. (5) `room:join` (30 per 10 s) and `room:knock:cancel` (10 per minute) are rate limited. (6) Approve decides against reject through the Redis removal: `RoomLive.resolveKnock` reports whether this call removed the knock, and an approve that lost the race deletes the membership it created and answers `410 KNOCK_EXPIRED`.
- **Why:** each was a verified or plausible gap between the documented guarantees and the implementation.
- **Accepted, not fixed:** REST routes (create room, membership, code lookup) are not rate limited yet (production hardening); `room:knock` answers `ROOM_NOT_FOUND`/`NOT_PRIVATE`/`ALREADY_MEMBER` for anyone holding a room UUID, which reveals only what the by-code preview already shows.

### M9 — Leaving and removal
- **Decision:** `room:leave` ends presence only; membership stays ("My Rooms"). `DELETE .../membership` (a member, never the host) and `DELETE .../members/:userId` (the host removing someone else, never themselves: `409 CANNOT_REMOVE_HOST`) delete the row, then remove that user's room presence, take their sockets out of the room through the emitter (`socketsLeave`) and send `room:member:removed` (reasons `left` / `removed`) to the room and to `user:{userId}`. Both are repeatable. A removed user of a public room may rejoin at once (D36, a deferred item; revisited in Phase 9); of a private room, only through a new knock.

### M10 — Membership notifications
- **Decision:** a new member (public join, approved knock) is announced to the room with `room:member:joined`; it is a hint, the member list is re-readable with `GET /rooms/:roomId/members`.

### M11 — Web
- **Decision:** `/rooms` (my rooms, create, join by code) and `/rooms/$roomId`. Server data (rooms, members) is TanStack Query; live state (presence, chat, knocks of the open room) is one Zustand store per room fed only by the join snapshot and socket events, as approved in I-stack. The client sends `room:join` for its rooms on every connect. Nothing shown is derived from a client claim.

### M12 — End-to-end tests
- **Decision:** Playwright (`e2e/`, `pnpm test:e2e`) against the real API, PostgreSQL and Redis with the Vite dev server, using the machine's installed Chrome (no browser download), several browser contexts for several people.

## Room timer decisions (Phase 7: RT1–RT13, accepted by the owner 2026-11-11 as the MVP baseline)
Chosen during implementation on top of D10, D16, D32 (a deferred item) and I8; accepted by the owner on 2026-11-11 (tested implementation), with RT1 and RT8 confirmed as written below.

### RT1 — Materialised at first access
- **Decision:** The timer hash `ff:room:{roomId}:timer` is created at the first access (join snapshot or first command) as an idle `focus` phase whose `durationMs` comes from the room's saved settings (PostgreSQL), by a version-checked write that requires the key to be absent. A phase's duration is therefore always fixed when the phase is created (D16). `reset` is allowed from any status, including `idle`, so the host can "apply now" a settings change to a phase that has not started. A reset in a focus phase closes the current run with reason `reset` and opens a new run in the same atomic write (D17); a reset from idle creates no session and abandons (reason `reset`, 0 focused s) only the sessions of people who opted in during idle.

### RT2 — Version base
- **Decision:** A new timer's `version` starts at the Redis TIME in milliseconds instead of 0; every accepted change adds 1. After a Redis loss or rollback the recreated timer's version is above any version a client or a leftover job holds, so an old phase-end job id (`phase-end_{roomId}_{version}`) cannot collide and clients do not ignore the new state. A join snapshot is authoritative: the client replaces its timer with it whatever its version; `room:timer:state` events apply only when their version is greater.

### RT3 — State without runs (superseded by RF2)
- **Decision:** The Phase 7 timer state had `phase, status, durationMs, elapsedBeforeMs, segmentStartedAtMs, version` only. **Superseded by RF2:** the state now also carries `focusRunId`, and the run ledger and participants arrived with Phase 8 (additive hash fields).

### RT4 — Phase-end jobs
- **Decision:** Queue `room-timer`, job `phase-end`, id `phase-end_{roomId}_{version}`, delayed to `endsAtMs − Redis now`, payload `{ schemaVersion, roomId, version }`. Scheduling uses the E20 "ensure" semantics (retained completed or failed jobs are re-run). A job never trusts its payload: it calls the service, which re-reads the timer; an outdated version or a non-running timer is a no-op, an early job asks to run again after the remaining time, and a duplicate delivery advances nothing twice (the write is version-checked).

### RT5 — Commands
- **Decision:** `room:timer:command` needs the socket to be in the room (`NOT_JOINED`), the caller to be the room's host (`NOT_HOST`, checked against `rooms.host_id` in PostgreSQL on every command), at most 20 commands per 10 s per user (`RATE_LIMITED`) and a strictly valid payload. A command naming a room the socket has not joined changes nothing and reveals nothing.

### RT6 — Rejection details
- **Decision:** `VERSION_CONFLICT` and `INVALID_TRANSITION` acknowledgements carry `error.details = { timer, serverNowMs }` so a stale client catches up without another round trip. The shared ack error shape gained an optional `details`.

### RT7 — Conflicts
- **Decision:** Writes retry up to 3 times, re-reading and re-evaluating the pure function each time. `start`, `pause` and `resume` are judged against the fresh state; `reset` and `setPhase` carry `expectedVersion`, and a mismatch against the fresh state is `VERSION_CONFLICT`. A repeated `pause` while paused or `resume` while running is a successful no-op: no write, no version change. `start` while running or paused and `resume` while idle are `INVALID_TRANSITION`.

### RT8 — Settings source
- **Decision (accepted by the owner 2026-11-11):** PostgreSQL owns the saved settings; Redis stores the active timer state including the active phase's duration, fixed when the phase is created. Phase durations are read from PostgreSQL whenever a phase is created. There is no separate Redis copy of the settings (the `ff:room:{roomId}:settings` key in the first Redis design is not implemented): phase creation is rare and a primary-key read is cheap, and it removes a second copy that could disagree. `PATCH timer-settings` still only saves and announces (`room:settings:updated`); it never touches the running timer.

### RT9 — Next phase
- **Decision:** The next phase is never started automatically (D32, a deferred item): `focus → short_break`, any break `→ focus`, always `idle`. `long_break` is reachable only through `setPhase`.

### RT10 — Host and presence
- **Decision:** A phase end happens whoever is present; a host disconnect changes nothing (D10). Commands cannot arrive without the host's socket.

### RT11 — Redis loss
- **Decision:** After a Redis loss the timer is recreated idle with the saved durations (RT1, RT2); Phase 6 already sends `room:resync`, and the rejoin snapshot carries the recreated timer.

### RT12 — Reconciler
- **Decision:** Step 2: (a) running timers past `endsAtMs` get their phase end run (`ff:rooms:timers:running` scored by `endsAtMs`), (b) every running timer gets its phase-end job ensured. Batches of at most 100, single-flight, one room's failure is logged and never fatal.

### RT13 — Order of effects
- **Decision:** After every committed change: ensure the phase-end job when the new state is running, then emit `room:timer:state { roomId, timer, serverNowMs }` to the room. A failed schedule is repaired by the reconciler; a failed emit by the clients' resync on reconnect.

### Accepted limits of the room timer (Phase 7 reviews)
- **Lost state events:** a viewer whose `room:timer:state` event was lost (a Redis pub/sub drop with the socket alive) shows a stale status until the next event, the "Finishing…" re-read at 0:00, a reconnect or a `room:resync`; there is no periodic re-read. Acceptable for the MVP.
- **PostgreSQL outage:** a phase end reads the room settings from PostgreSQL (RT8), so during a PostgreSQL outage a timer past its end cannot advance; the job retries (5 attempts, backoff), the reconciler retries every interval, and clients show "Finishing…" until PostgreSQL returns.
- **`start` has no `expectedVersion`:** a stale host tab can start a phase another tab just switched to (RT7, by design); two simultaneous `start` commands answer the second `INVALID_TRANSITION`.
- **Lost job latency:** if a phase-end job is lost, the phase ends at the next reconciler run: up to one `RECONCILER_INTERVAL_MS` (30 s), or about 90 s if the repeating reconciler job itself stalls (E23).

## Room focus run decisions (Phase 8: RF1–RF17, accepted by the owner 2026-11-11 as the MVP baseline)

Chosen during implementation inside the approved design (D11, D14/15/35, D17, D19, D37 default (a deferred item), I8); accepted by the owner on 2026-11-11 (tested implementation); migration `0004` (RF1) is approved, with the coordinated deployment requirement below. None changes an approved decision. Details: `architecture/focus-timing-protocol.md` "Focus runs".

### RF1 — Schema
- **Decision:** `focus_sessions` gains `room_id` (FK `rooms`, no `ON DELETE` action as in P1: rooms are never deleted in the MVP) and `focus_run_id` (uuid, no FK: the run lives in Redis); `CHECK (room_id IS NULL) = (focus_run_id IS NULL)`; `running_since` stays solo-only (`CHECK room_id IS NULL OR running_since IS NULL`); `abandon_reason` also allows `opted_out, left_room, removed, reset, phase_changed, timer_lost`. Indexes: `(room_id, focus_run_id)` partial on `status = 'in_progress'`. Existing rows keep NULL in both columns.
- **Deployment (owner-approved 2026-11-11):** migrate first, then deploy all roles together; stop old workers before the new migration goes live. Old code running on the new schema would not exclude room rows from solo sweeps, so old workers or API instances must not process new room-focus sessions.
- **Why:** the design asks for exactly these columns (M1); the one-in-progress-per-user index is untouched, so a solo and a room session can never run together.

### RF2 — A run for every focus phase
- **Decision:** `TimerState.focusRunId` is set while `phase = focus` (idle, running or paused) and `null` in a break. A fresh UUID run is created whenever a focus phase is created (materialisation, `reset` in focus, `setPhase` to focus, a break ending) and the old run is closed by the same change. The id is chosen by the service through the pure `planRun`, never by the machine.
- **Why:** opting in is allowed while the phase is idle or paused (protocol), so the run must exist before `start`.

### RF3 — Atomic timer and run write
- **Decision:** the timer's Lua write also (a) closes the old run (`status=closed, closeReason, closedAtMs, elapsedAtCloseMs`), (b) adds it to `ff:rooms:runs:unsettled` (score `closedAtMs`), (c) creates the new run record (`status=open, openedAtMs`). The script holds no rules: all values are computed in TypeScript. Keys: `ff:room:{roomId}:run:{runId}` (hash), `ff:room:{roomId}:run:{runId}:participants` (hash, userId → JSON), `ff:rooms:runs:unsettled` (sorted set `{roomId}:{runId}`). A settled run is deleted (`finishRun`), so Redis keeps only live state.
- **Why:** the timer change and the run closure can never disagree (D17), and a crash leaves the closed run in the unsettled set.

### RF4 — Opt-in
- **Decision:** `POST /rooms/:roomId/focus-participation` in the order of the protocol (check, insert session, atomic ledger add, announce). `planned_seconds = round((durationMs − elapsedMs)/1000)` from the authoritative timer at opt-in; if it is below 60 (the CHECK bound) the answer is `409 RUN_ENDING` and nothing is written. Presence is the user's live room presence in Redis (`NOT_PRESENT`); a break → `NOT_FOCUS_PHASE`; an existing in-progress session (solo or another room) → `409 SESSION_IN_PROGRESS` with the session in `details`, except the user's own half-completed opt-in in this same run, which is repaired and returned (`200`). `RUN_CHANGED` deletes the just-created row in the same request.
- **Why:** an opt-in that cannot satisfy the plan bounds must not leave a row; repairing a retry avoids duplicates.

### RF5 — Focused time and `ended_at`
- **Decision:** pure functions of ledger values (protocol table). Seconds are rounded **down** and clamped to `[0, planned_seconds]`. `completed` → `planned_seconds`. `ended_at` is the Redis instant of the event clamped into `[started_at, PostgreSQL clock_timestamp()]` (stored timestamps stay ordered, E9 style). `timer_lost` → `focused_seconds = 0`, `ended_at` = recovery time (D37 default; D37 is a deferred item).
- **Why:** never invent time that cannot be proven.

### RF6 — Settlement is idempotent
- **Decision:** every transition locks the session row (`FOR UPDATE`) and only touches rows still `in_progress`; duplicates, concurrent workers and a crash between PostgreSQL and Redis are safe because the durable write comes first and the ledger cleanup is repeatable. Announcements run after the commit, separate from each other.

### RF7 — Grace
- **Decision:** the disconnect is recorded with a version-checked ledger write (`elapsedAtDisconnectMs` from the timer and Redis TIME), then a deterministic job `room-grace_{roomId}_{runId}_{userId}_{disconnectedAtMs}` (queue `focus-session`, ensure semantics, delay `60 s − age`). The grace is 60 s plus a 1 s early tolerance (`GRACE_EARLY_TOLERANCE_MS`) for clock differences between BullMQ and Redis TIME, so at most 61 s. The job settles only if the ledger still holds this participant disconnected at exactly that instant AND the user is still absent from the room (re-checked); a reconnect clears the marker, so a stale job is a no-op. Several sockets: only the user's **last** room socket leaving counts. A reconnect after a normal phase completion completes the session only if it happened within 60 s of the disconnect (Redis TIME); a reset/phase change has already abandoned it.

### RF8 — Departure
- **Decision:** opt-out (`opted_out`), `room:leave` and `DELETE …/membership` (`left_room`) and host removal (`removed`, in the same transaction as the membership delete) abandon the session in PostgreSQL first, then clear the ledger, then announce. Leaving presence is **not** leaving membership (M9); a plain disconnect is a grace case (RF7), not a departure.

### RF9 — Reconciler
- **Decision:** step 3 settles runs in the unsettled set; steps 4 and 7 are one PostgreSQL-driven sweep of in-progress room sessions (keyset batches, `FOR UPDATE SKIP LOCKED`, per-session transactions): participants past grace → `grace_expired`; a connected-looking participant whose user is absent from the room → late grace; closed-run participants → settlement; a session with no ledger entry older than 2 minutes → `timer_lost`. Solo steps skip room sessions.

### RF10 — Redis data loss
- **Decision:** global recovery (the existing epoch mechanism) abandons every in-progress **room** session as `timer_lost` (focused 0), once, notifying each user; solo sessions are untouched. Local recovery already sends `room:resync`; the recreated timer is idle with a new run (RT11). A plain Redis reconnection is not data loss.

### RF11 — Solo isolation
- **Decision:** pause/resume/stop on a room session → `409 NOT_SOLO_SESSION`; solo sweeps, hints and grace never touch room sessions; `GET /focus-sessions/current` returns the room session with `context.kind = "room"`; history shows both with their `context`.

### RF12 — Events
- **Decision:** `room:focus:participants { roomId, focusRunId, participants }` to the room after every committed ledger change and after a run changes; `focus:session:updated` to the user after every committed session transition. Both after commit, independent, never able to fail the request. The join snapshot carries `focus: { focusRunId, participants, me }`.

### RF13 — Frontend
- **Decision:** the room page gets a "Focus together" panel under the timer: participants (with connected/reconnecting state), an optional task picker, Join/Leave controls with pending, error and offline states, and a plain-language outcome for each end. Nothing in the browser decides an outcome; the client countdown is display only.

### RF14 — Ledger entries and privacy
- **Decision:** participants are visible only to room members (the room channel); the ledger stores ids and timestamps, never task titles. `GET …/focus-participation` is member-only (404 otherwise, M4) and returns only the caller's own session.

### RF15 — Orphans
- **Decision:** a room session whose `(room_id, focus_run_id)` has no ledger entry is repaired on retry (RF4) or abandoned `timer_lost` by the reconciler after `ORPHAN_RECOVERY_MS` (2 min, by PostgreSQL `started_at`).

### RF16 — Review
- **Decision:** history and summary count room sessions exactly like solo ones (same statuses and `focused_seconds`); each history item shows its `context`.

### Accepted limits of room focus runs (Phase 8 reviews)
- **~~No stale cap for room sessions (RF-L7)~~ — resolved by RF17.** The 12 h expiry (E2) was solo-only, so a participant of a run whose timer was never resumed could block a solo start; RF17 now expires such room sessions.
- **Phase 7 timers in a live Redis:** a focus-phase timer hash written before Phase 8 has no run; opt-in answers `RUN_CHANGED` until the host resets or changes phase (development environments only; a Redis loss recreates the timer with a run).
- **Repaired opt-in time:** a retry that repairs a lost ledger entry rebuilds `elapsedAtOptInMs` from the planned seconds (within 0.5 s).
- **Grace tolerance:** the grace boundary uses a 1 s tolerance between BullMQ's delay clock and Redis TIME; an overdue reconnect (more than 61 s) is `grace_expired`.
- **Participant list from the ledger alone:** if the ledger cleanup after a PostgreSQL abandon fails, the ended participant stays listed until the run closes or their next opt-in.
- **Abandon reasons are not tied to the session type by a constraint** (application code never mixes them).

### RF17 — Stale room sessions (implemented 2026-11-11, replaces RF-L7)
- **Decision:** Room focus sessions still `in_progress` 12 h after `started_at` are expired (`abandoned`, reason `expired`, no schema change) by reconciler step 6b (after steps 3/4/7 and solo step 6), with a 16-hour absolute maximum (`ROOM_STALE_AFTER_MS` and `ROOM_STALE_HARD_MAX_MS` in `apps/api/src/modules/room-focus/types.ts`; code `room-focus/stale.ts`; tests `stale.int.test.ts`, `model.test.ts`). A session whose own run is open with the timer running is exempt until 16 h; a closed-unsettled run is left to its settlement until 16 h (then expired with the run's frozen `elapsedAtCloseMs`); paused and idle runs expire at 12 h. Focused time is from opt-in to the timer's elapsed (or frozen at close), floored and clamped, never past a recorded disconnect; no ledger entry means 0 s. Redis is read first: if it cannot answer, nothing is decided (deferred to the next sweep) and focused time is never silently discarded. PostgreSQL decides under `FOR UPDATE SKIP LOCKED` with the age re-checked using the PostgreSQL clock, and only the `in_progress` row of that run changes (idempotent). After commit: compare-and-delete the ledger entry (by sessionId) and `finishRun`, then announce `room:focus:participants` and `focus:session:updated`; failed ledger cleanups are kept in the process backlog and retried by every full reconcile run (a closed-run settlement also removes leftovers). Solo sessions are never selected (`room_id IS NOT NULL`) and solo stale cleanup ignores room rows.
- **Why:** an idle or paused room run must never hold the user's single session slot for ever (E2's intent for solo sessions, D14/15/35).

### Implemented technical details of Phase 8 (accepted 2026-11-11)
- **participantsVersion (G2):** a per-run, server-owned monotonic version in the run hash, incremented inside the ledger Lua scripts; carried by the join snapshot's `focus` and by `room:focus:participants`. A client applies an event only for the same `focusRunId` and a higher version; a join snapshot is authoritative (it may carry a lower number after a Redis loss).
- **True end (G3, with D17a):** `closedAtMs = min(now, endsAt)` for a completed run; `wasPresentThroughEnd` treats a disconnect at or after the true end as present at the end; `pendingEndAtMs` settles a still-open run at its true end when the delayed phase-end job has not run.
- **Knock compensation (G4):** when an approve loses against a reject or an expiry, the compensation abandons the room session with reason `removed` and announces the member removal; the web clears a stale `removed` flag on `room:knock:resolved` (approved) or `room:member:joined` for the user.
- **Defaults:** `ROOM_FOCUS_RATE` 10 per 10 s; `RECOVERY_SETTLE_MS` 10 s; reconciler room sweep batches of 100, concurrency 4, with a cursor; a timer pause is rejected at or after the phase end; opt-in retries up to 4 attempts; `SCHEDULE_TIMEOUT_MS` 2 s (a follow-up waits at most that long for the job schedule before the event is sent); grace configurable as `FOCUS_GRACE_MS`.

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
