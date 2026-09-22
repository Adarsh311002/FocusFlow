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
