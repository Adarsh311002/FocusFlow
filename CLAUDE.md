# Focus Flow

Focus Flow is being redesigned as **Focus Flow v2**.

The existing repository contains an older JavaScript/MERN implementation. We are not blindly restoring that architecture. We are using the existing codebase as a source of product and engineering context while designing a cleaner v2 architecture.

## Current Development Phase

Product/domain/architecture design is complete and the implementation plan is approved (see `docs/implementation/plan.md`).

**Phase state:** Phases 0 (foundation), 1 (accounts) and 2 (tasks) are merged into `main` (checkpoints: tags `phase-1-accounts`, `phase-2-tasks`). Phase 3 (real-time foundation) is implemented on branch `v2/phase-3-realtime`, pending review. Phase 1b (Google sign-in) and Phase 4 onwards have **not started**. Implementation proceeds phase by phase; do not begin a phase, a migration, or large-scale refactoring until that phase is explicitly started by the user.

Do not change the architectural direction again unless a genuine contradiction appears during implementation; if one does, explain it rather than silently changing the design.

## Technology Direction

### Frontend
- React
- TypeScript
- Vite

### Main Backend
- Node.js
- Express
- TypeScript

### Real-time
- Socket.IO
- TypeScript

### Database
- PostgreSQL for durable/persistent application state

### Redis
- Ephemeral state
- Presence
- Room timer state
- Caching where appropriate
- Queue infrastructure
- Rate limiting where appropriate

### AI
- Python
- LangChain
- LangGraph
- LLM provider(s) behind the Python AI service

### Other planned technologies
- Docker / Docker Compose for local development
- S3-compatible object storage when uploads are actually needed
- Razorpay when billing is actually needed

### Approved implementation stack (I1–I12, P2, P3)
Details and rationale: `docs/implementation/plan.md` and `docs/decisions/decision-log.md`.
- **Repository:** one monorepo with pnpm workspaces (pinned `packageManager`, catalogs where useful): `apps/web`, `apps/api`, `packages/contracts`, `infra/`, `docs/`; `e2e/` when required; `services/ai` later.
- **Frontend:** React + TypeScript + Vite, TanStack Router, TanStack Query, Zustand for live room state, typed `fetch` wrapper (no Axios), typed `socket.io-client`, Tailwind CSS v4, native forms initially, Radix primitives only where actually needed, no animation library yet.
- **Backend:** Node.js 24 LTS, Express, Socket.IO, ESM, `pino`/`pino-http`, `jose`, argon2id, Zod environment validation, a light service layer, no generic repository abstraction, no DI container.
- **Database:** PostgreSQL 18, Drizzle ORM with `node-postgres`, SQL migrations generated, reviewed and committed, UUIDv7 IDs, `timestamptz`, snake_case, `CHECK` constraints instead of PostgreSQL enums, explicit constraint/index names, `READ COMMITTED` by default.
- **Redis/jobs:** Redis, BullMQ, `ioredis`. Worker code lives in `apps/api` with its own entry point/role and runs inside the API process initially, so it can become a separate deployment later. All Redis keys use the configurable `REDIS_KEY_PREFIX` (default `ff:`); BullMQ keys use the corresponding prefix (P3).
- **Health checks:** `GET /healthz` = process is alive; `GET /readyz` = PostgreSQL and Redis are reachable (P2).
- **Room timer:** transitions are a pure TypeScript function; Redis `TIME` is the authoritative clock; results are written with a small version-checked atomic Redis operation with bounded retry. Lua stays small and holds no business logic. Property tests cover the state machine and concurrency assumptions.
- **Local development:** PostgreSQL and Redis in Docker via `infra/compose.yaml` (root scripts call `docker compose -f infra/compose.yaml`); web and API run natively on Windows; one origin via the Vite proxy.
- **Testing:** Vitest, Testing Library, fast-check, Testcontainers; Playwright when room functionality arrives.
- **Quality:** ESLint 9 with strict type-aware rules, Prettier, lefthook, Conventional Commits; CI runs typecheck, lint, format check, tests and builds.

## TypeScript Rule

Use TypeScript rather than JavaScript throughout the Node.js ecosystem.

This includes:
- React frontend → `.ts` / `.tsx`
- Node/Express backend → `.ts`
- Socket.IO server → `.ts`
- Node background workers → `.ts`
- Shared contracts/types → TypeScript

Do not introduce new JavaScript files.

When existing JavaScript is eventually migrated, prefer a deliberate TypeScript migration rather than continuing a mixed JS/TS architecture.

Use strict TypeScript.

Prefer explicit domain types, discriminated unions, and runtime validation rather than `any`.

## Contract Philosophy

We intend to use:
- Zod for runtime validation
- TypeScript types inferred from Zod schemas where appropriate
- Typed Socket.IO events
- Shared contracts between frontend and backend
- Branded ID types where useful

Keep domain/API contracts separate from ORM/database implementation types.

Do not expose persistence-layer types directly as API contracts.

## Domain Decisions Already Approved

### Current focus task
The user's current focus task belongs conceptually to the user.

Use `users.current_task_id` rather than an `is_active` flag on tasks.

### Focus sessions
A FocusSession represents actual focused work.

Pomodoro break phases are not persisted as FocusSession records in the MVP.

A FocusSession should support the lifecycle of:
- `in_progress`
- `completed`
- `abandoned`

A FocusSession may optionally reference a Task.

### Rooms
Rooms are persistent shared focus spaces rather than one-time meetings.

Room identity and membership are durable.

Live room state such as presence and timer state is ephemeral.

### Room chat
Room chat is temporary in the MVP.

Do not add persisted room-message history unless that decision is explicitly revisited.

### Host disconnect
The room timer is server-authoritative.

If the host disconnects while a timer is running, the timer continues.

Do not automatically transfer host ownership in the MVP.

### Room focus sessions
Presence does not imply productivity.

A user must explicitly opt into a focus session.

Being present in a room alone must not automatically create a completed FocusSession.

### Solo pause accounting (D6)
- `focus_sessions.focused_seconds` stores accumulated focused time; `running_since` marks the current active stretch.
- On pause, add the elapsed stretch to `focused_seconds` and clear `running_since`. On resume, set `running_since = now`.
- Individual pause intervals are not stored in the MVP.

### Public room membership (D9)
- Joining a public room creates a persistent `room_members` record. Joining again is idempotent (upsert-like).
- Membership is an access/history relationship and enables a future "My Rooms" view.
- Private rooms still require explicit host approval.

### Reset / phase change during focus (D17)
- If the host resets the timer or changes away from a focus phase while users are opted into the current focus run, their in-progress room FocusSessions are marked `abandoned` with reason `reset` or `phase_changed`.
- The current participant set is cleared and a new `focusRunId` is issued.

### Disconnect grace (D19)
- An unexpected socket disconnect does not immediately abandon a room FocusSession. The participant gets a 60-second reconnect grace period.
- Reconnecting within the grace period preserves the participation. Otherwise the session is marked `abandoned` with reason `grace_expired`.
- An intentional room leave is an immediate abandonment.

### Meaning of "completed" (D14, D15, D35)
There is one meaning of "completed" across solo and room sessions. A FocusSession is `completed` only when the planned focus period has been reached and the user is confirmed present at the end.
- Present at completion → `completed`.
- Actively running session, temporarily disconnected → 60-second reconnect grace. Reconnects within grace → the session continues (and can be `completed` if present at the end). Grace expires → `abandoned(grace_expired)`.
- Paused solo session: a disconnect does NOT start the 60-second abandonment grace. The session stays paused, because pausing is an explicit user action, not an unexpected disappearance. If it stays unresolved too long, the stale-session cleanup policy marks it `abandoned(expired)`.
- Solo early stop → `abandoned(stopped)`, preserving the actual `focused_seconds`.
- A stale solo session that remains unresolved beyond the grace/cleanup policy → `abandoned(expired)`. Stale sessions must never permanently block the user.
- The exact timeout/cleanup mechanics are a technical detail; the meaning of "completed" is fixed.

### Room phase durations (D16)
- Focus, short-break and long-break durations are persisted per room in PostgreSQL, with sensible defaults.
- The host may change them. A change takes effect from the next phase, never retroactively for the current phase.
- Redis holds the live copy while the timer runs.

### Google account linking (D1)
- Never automatically link Google to an existing password account solely because the verified emails match.
- If Google login finds an existing password account with the same email and no linked Google identity, refuse the automatic merge and instruct the user to sign in normally and explicitly link Google from account settings.
- The user model includes `email_verified_at`. Google-created accounts may be marked verified based on Google's verified identity.
- The explicit Google-account linking endpoint is part of the MVP, in Phase 1b (D44).

### Auth sessions and refresh tokens (D23)
- Use per-device auth sessions.
- Refresh tokens live in an httpOnly cookie and are rotated on every refresh.
- Reuse of an already-rotated refresh token revokes that session. A small previous-token overlap window prevents simultaneous browser refreshes from being treated as theft.
- Access tokens are short-lived and kept in memory on the client.
- Exact token lifetimes are finalized during implementation.

### Task deletion (D38)
- Tasks are soft-deleted via `deleted_at` and disappear from normal task lists.
- Historical FocusSessions keep their task relationship/history.
- A deleted task cannot remain the user's current task.
- Physical deletion may happen later as part of account deletion/retention policy.

### Task references use plain foreign keys (P1)
- `users.current_task_id` and `focus_sessions.task_id` are plain foreign keys with no `ON DELETE` action. Do not rely on `ON DELETE SET NULL`.
- When full account deletion is implemented, clear `users.current_task_id` in the account-deletion transaction before deleting the user/account data.

### Completing the current task (D43)
- When a task is completed, clear it as the user's current task if it is currently selected. The current task is always an open, non-deleted task.

### Tasks implementation decisions (Phase 2: T1–T6)
- **T1:** `GET /tasks/:taskId` exists; it resolves/displays the current task and serves later focus-session features.
- **T2:** Task lists are newest-created first, ordered by UUIDv7 `id DESC` and paginated by an opaque keyset cursor, served by one full index `(user_id, id DESC)`. No `completed_at` ordering and no second cursor.
- **T3:** After completing or deleting the currently selected task, the client re-reads `GET /me` to update its user state. Task responses do not carry a `currentTaskCleared` flag.
- **T4:** No optimistic updates in Phase 2: server responses plus pending states only.
- **T5:** Task management lives on `/dashboard`, with the current task shown prominently.
- **T6:** Title 1–200 characters after trimming; list limit default 50, maximum 100; no per-user task count cap for now.
- Tasks are always scoped by `req.authUser.userId`; another user's, a deleted and a nonexistent task all answer `404 TASK_NOT_FOUND`. Completed tasks may be renamed; reopening never makes a task current. Task CRUD uses no Redis.

### Real-time foundation decisions (Phase 3: R1–R8)
- **R1 Presence keys:** per-socket entries in `user:{userId}:sockets` (`{instanceId}:{socketId}`) plus the reverse index `instance:{instanceId}:sockets`; `instances` is a sorted set scored by each instance's last heartbeat (Redis TIME). Dead-instance cleanup never scans user sets and the last heartbeat survives the instance.
- **R2 Clock:** Redis TIME is authoritative for `time:sync`, heartbeats and the future room timer. API `Date.now()` is not used for protocol arithmetic.
- **R3 Revocation trust-loss window (security):** `epoch` records its creation time; while it is missing or younger than one access-token lifetime, "no revocation marker" is not trusted and PostgreSQL decides (failing closed with a 503 if PostgreSQL is down). Outside the window the Redis fast path is used. A revoked session never becomes trusted because Redis lost its keys.
- **R4 Per-user socket cap:** deferred to abuse/rate-limiting hardening.
- **R5 Transports:** Socket.IO's default polling → WebSocket upgrade; not WebSocket-only.
- **R6 Timing defaults (configurable):** `pingInterval` 10 s, `pingTimeout` 10 s, heartbeat 10 s, instance TTL 30 s, reconciler every 30 s plus startup.
- **R7 Roles:** `ROLE=all` (default), `api` or `worker`; a worker-only process has no HTTP listener. Worker health endpoints are revisited with a real separate worker deployment.
- **R8 No product events in Phase 3:** infrastructure only; `user:{userId}` gets its first product event in Phase 4.
- Socket identity comes only from the verified handshake token (the same JWT verification and revocation check as REST); `user:{userId}` and `session:{sid}` are server-derived rooms; token expiry disconnects the socket; revocation disconnects `session:{sid}` on every instance through the Redis emitter; PostgreSQL stays the only durable store.

### Tracked follow-ups (not part of Phase 2)
- Phase 1 signup/login request schemas use `z.object` (unknown keys stripped) rather than `z.strictObject`; fix in a separate small hardening PR.
- Security headers, rate limiting and `/readyz` caching belong to the later production-hardening phase. **Rate limiting must be in place before the auth API is publicly exposed.**
- A per-user socket cap (R4) belongs to the same abuse/rate-limiting hardening.
- Worker health endpoints (R7) are revisited when the worker becomes a separate deployment.

## Important Architecture Principles

- PostgreSQL is the durable system of record.
- Redis is for disposable/ephemeral state and infrastructure concerns.
- If losing Redis would cause permanent loss of user data, that data belongs in PostgreSQL.
- The server is authoritative for important shared room state.
- The client should not be trusted to provide its own identity in authenticated Socket.IO payloads.
- Socket identity must come from the authenticated connection/access token.
- Stored-data mutations should generally use REST.
- Live state, real-time notifications, and room synchronization should generally use Socket.IO.
- When a REST operation changes persisted state and other connected users need to know about it, the server should persist first and then emit the appropriate event.
- Do not introduce technologies merely for the sake of using them. Every technology should serve a product or engineering requirement.

## AI Architecture Principle

AI is a later phase of the product, not automatically part of the MVP.

When an AI feature exists:
- Node should own the application/API boundary.
- Python should own AI orchestration and LLM interaction.
- LangChain/LangGraph should live inside the Python AI service.
- Long-running or expensive AI operations should run asynchronously through a queue.
- AI job state/results should eventually be persisted durably.
- The exact first AI feature is still a product decision unless explicitly approved.

## Product Philosophy

The core Focus Flow loop is:

decide what to work on
→ focus for a period of time
→ record the accomplishment
→ review progress

New features should strengthen this loop rather than being added simply because they are technically interesting.

## Long-Term Product Principle

The MVP is the first coherent implementation milestone, not the final product. Focus Flow is intended to grow into richer productivity, collaboration, analytics, AI, personalization, notifications, integrations, and monetization.

When scoping work, distinguish:
- Build now
- Architect now for later
- Deliberately defer

Do not add speculative infrastructure just because the product may grow, but do not create throwaway architectural boundaries either.

## Phase-Gate Rules

Until the relevant implementation phase is explicitly approved:

- Do not write application/source code for it.
- Do not create database migrations.
- Do not install dependencies.
- Do not perform any MongoDB → PostgreSQL data migration.
- Do not delete old functionality merely because it belongs to the old architecture.
- Do not treat speculative architecture as implemented functionality.
- Clearly distinguish:
  - existing functionality
  - approved v2 decisions
  - proposed ideas
  - unresolved decisions

## Design Documentation

The full v2 design lives in `docs/` (start at `docs/README.md`). Approved decisions are recorded in `docs/decisions/decision-log.md` and open ones in `docs/decisions/open-decisions.md`. When a decision is approved, update this file, both decision documents, and every design document that references it.

## Existing Repository

The existing codebase should be treated as useful historical/contextual material.

Do not assume that the existing implementation defines the final v2 architecture.

When an old implementation conflicts with an explicitly approved v2 decision, the approved v2 decision takes precedence.

Legacy rules (I12):
- `Client/`, `Server/` and the root `docker-compose.yml` remain untouched. v2 is built in the new `apps/` structure; there is no gradual JavaScript-to-TypeScript conversion of the legacy app.
- Legacy code is not deleted before the solo-core milestone (end of Phase 5).
- Do not modify or commit `archi/` unless explicitly instructed.

## Claude Working Style

Before making substantial changes:
1. Inspect the relevant code and documentation.
2. Explain the proposed approach.
3. Identify important assumptions.
4. Make the smallest coherent change.
5. Validate the change.
6. Report what changed and what remains.

Do not make broad unrelated refactors while working on a focused task.

Keep the architecture understandable and avoid unnecessary abstraction.
