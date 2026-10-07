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

### H3 — Late grace for a missed disconnect
- **Decision:** when the reconciler finds a running solo session whose user is offline with no disconnect marker, and Redis has **not** lost its data during the running stretch (the current epoch was not created after `running_since`), it starts a normal 60-second grace from the detection time instead of marking the session `expired`. `expired` remains for the case where the epoch changed during the stretch.
- **Consequences:** an infrastructure fault no longer discards a user's focused stretch; recorded time can be over-counted by at most the detection delay. Implemented with Solo Focus (Phase 4B); Phase 4A supplies `checkUser` and the event timestamps it needs.

### H4 — Online hint
- **Decision:** presence emits an online event when a socket of a user is newly recorded (connect, or a sync re-adding it), so the future disconnect marker can be cleared early. Like the offline event it is a hint; grace expiry re-checks presence regardless.

## Accepted architecture direction

The following are accepted as the design direction but were not approved as individual product decisions. They may be refined during implementation if they stay consistent with the decisions above:

- Focus runs and a Redis run ledger for settling room sessions.
- BullMQ delayed jobs for phase ends, solo session ends and grace expiry, plus a periodic reconciler.
- Workers send socket events through the Socket.IO Redis emitter, so moving them to a separate process needs no code change.
- UUIDv7 IDs are generated in the application; the database default `uuidv7()` is a fallback.
- Redis-loss detection through an epoch marker key, with `timer_lost` recovery.
- Knock approval over REST; knocks themselves over Socket.IO with a TTL.
- Same-origin deployment (frontend, `/api` and `/socket.io` behind one origin).
- Clock sources: Redis server time for room timer arithmetic (read with `TIME`, see I8); PostgreSQL `now()` for stored timestamps and solo session arithmetic.
