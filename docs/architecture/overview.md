# Architecture Overview

## Product in one paragraph

Focus Flow helps people do focused work, alone or together. The core loop is: **decide what to work on → focus for a period of time → record the accomplishment → review progress.** Solo users pick a task and run a timed focus session. Rooms are persistent shared spaces where people focus on one server-controlled timer, see who is present, and chat. Every feature must strengthen that loop.

## Components

```
                 ┌─────────────────────────── one origin ───────────────────────────┐
 Browser ──────► │ Nginx ── /            → web (static React build)                 │
 (React + TS)    │       ── /api/v1/*    → api (Express, TypeScript)                │
                 │       ── /socket.io/* → api (Socket.IO, TypeScript)              │
                 └───────────────────────────────────────────────────────────────────┘
                                   │                         │
                                   ▼                         ▼
                         PostgreSQL 18 (managed)     Redis (AOF, noeviction)
                         durable system of record     presence, live timer state,
                                                      knocks, BullMQ queues,
                                                      Socket.IO adapter, rate limits
                                   ▲                         ▲
                                   └────── worker (TypeScript, BullMQ) ──┘
                                           phase ends, session ends, grace,
                                           reconciler — inside the api process
                                           initially (I7)

 Later phases: Python AI service (LangChain/LangGraph) consuming queue jobs;
               S3-compatible object storage; Razorpay; notifications.
```

| Component | Responsibility | Status |
|---|---|---|
| `web` | React + TypeScript + Vite single-page app (`apps/web`). Renders from server state; holds only UI state and the in-memory access token. | Approved (I4) |
| `api` | Express REST API and Socket.IO server in one Node.js 24 process (`apps/api`). Authentication, authorization, validation, all PostgreSQL writes, request-driven socket emits. | Approved (I5) |
| `worker` | BullMQ consumers: room phase ends, solo session ends, grace expiry, run settlement, reconciler. Same codebase as `api` (`apps/api`) with its own entry point/role; runs inside the `api` process initially and can become a separate deployment later. Sends socket events through the Socket.IO Redis emitter. | Approved (I7) |
| PostgreSQL 18 | Users, auth identities and sessions, tasks, focus sessions, rooms, memberships. Accessed through Drizzle ORM. | Approved (F1, I6) |
| Redis | Presence, room timer state and settings copy, focus run ledger, knocks, queues, Socket.IO adapter, rate limits, revocation markers (a shortcut only; PostgreSQL decides revocation). | Approved (F2) |
| Python AI service | AI orchestration and LLM calls. Not part of the MVP. | Later (F4) |

## Communication rules

- **REST** for anything that changes stored data (F5). The server persists first, then emits.
- **Socket.IO** for live state (presence, timer, knocks, chat) and for notifying users of durable changes.
- **Identity** on sockets comes only from the authenticated connection (F7).
- **Server authority** for shared room state (F6): clients render the room timer from server timestamps.
- **Clocks:** room timer arithmetic uses Redis server time (read with `TIME` before each change is computed, I8); stored timestamps and solo session arithmetic use PostgreSQL `now()`. API servers never use their own clocks for these. All hosts run NTP.

## Node ↔ Python boundary (later phase)

- **Node owns:** authentication and authorization, public APIs and sockets, the PostgreSQL schema and migrations, creating AI jobs, quotas and rate limits, notifying the user.
- **Python owns:** LangGraph workflows, LangChain components, prompts, LLM provider selection, validating LLM output (Pydantic), retrying LLM calls inside a job.
- **What crosses:** a queue job `{ jobId, type, schemaVersion, userId, correlationId, input }`, where `input` holds IDs and options, not bulk data. Python fetches what it needs when the job runs (how is open, D28).
- **Results:** written to an `ai_jobs` table; Node learns of completion (BullMQ events or Redis pub/sub) and emits to the user's socket channel; the client fetches the result over REST.
- **Contracts:** job payload and result schemas are defined with Zod in `packages/contracts`, exported to JSON Schema, and generated into Pydantic models. See `contracts.md`.
- When AI jobs arrive, "insert `ai_jobs` row + enqueue" should use an outbox or polling dispatcher, because it writes to two systems.

## Deployment (Architecture)

- Single Docker host behind Nginx to start. API image based on `node:24-slim`, built from an esbuild bundle. Managed PostgreSQL 18 (backups and point-in-time recovery). Redis with AOF persistence and `noeviction`.
- Migrations run as a separate step before a new version starts, never automatically at API startup.
- The worker runs inside the API process initially (I7). Splitting it out means running the same image with a worker-only role.
- **One origin** in every environment. The refresh cookie is `SameSite=Strict` and path-scoped, which requires the web app, `/api` and `/socket.io` to share a site; one origin also removes the need for CORS.
- Presence entries are tagged with the API instance ID from day one, so adding instances later needs no redesign. More than one instance requires the Socket.IO Redis adapter (planned from the start) and, if long-polling is enabled, sticky sessions.
- The Python AI service, when it exists, is a separate deployable unit, never exposed through Nginx.
- No Kubernetes or multi-region at this stage.

## Local development (Approved, I9)

- PostgreSQL 18 and Redis run in Docker via `infra/compose.yaml`. Root scripts always invoke `docker compose -f infra/compose.yaml …`; the legacy root `docker-compose.yml` stays untouched. MinIO and the AI service are added only in the phases that need them.
- The web app and API run natively on Windows with pnpm, for fast reloads and working debuggers.
- The Vite dev server (port 5173) proxies `/api` and `/socket.io` to the API (port 3000), so local development is same-origin like production.
- Every service validates its environment variables at startup (Zod) and ships a `.env.example`.
- The AI service will have a mock LLM provider mode so local work does not need API keys or spend.

## Observability (Architecture)

- Structured JSON logs: `pino` in Node, `structlog` in Python.
- A correlation ID per request, propagated into queue jobs and worker logs.
- Every service exposes `/healthz` (liveness: the process is running) and `/readyz` (readiness: required dependencies such as PostgreSQL and Redis are reachable) (P2). Orchestrators restart on failed liveness and stop routing traffic on failed readiness.
- Log security events: refresh-token reuse detection, session revocation, repeated authorization failures.
- Full tracing/APM is deferred until there is production traffic.

## Security boundaries

- Identity only from verified tokens (REST: bearer access token; sockets: handshake token). Revoked sessions are checked on both.
- Every REST body/query and every socket payload is validated with Zod before business logic runs.
- Host-only actions are authorized against PostgreSQL (`rooms.host_id`).
- Private room details are hidden from non-members. Knock outcomes go only to the target user's channel.
- Refresh token only in an httpOnly, `SameSite=Strict`, path-scoped cookie; access token only in memory.
- Later: the Python service gets a scoped database role and no public endpoint; LLM keys only in Python's environment; payment secrets only in Node's; object-storage access only through short-lived signed URLs.

## Long-term scope: build now, architect now, defer

| Build now (MVP) | Architect now for later | Deliberately defer |
|---|---|---|
| Accounts (password + Google, D1), per-device sessions (D23) | `email_verified_at`; per-device sessions (future "manage devices") | Email verification and password reset flows (before launch, D39) |
| Tasks with current task (D3) and soft delete (D38) | History never destroyed (soft delete, abandonment reasons, UTC timestamps) | Task descriptions, projects, tags, restore (D29, D45) |
| Solo focus sessions with pause (D6) and presence-based completion (D14/15/35) | Per-user presence (reusable for notifications) | Overtime / flexible targets |
| Rooms, membership (D9), knocks, server timer, per-room durations (D16), opt-in sessions (D11, D17, D19), temporary chat (D7) | Run ledger (upgrade path to an outbox); instance-tagged presence; Socket.IO Redis adapter | Archiving, bans, discovery (D12), persisted chat |
| History and summary (review step of the loop) | Summary returns completed and total time (D34) | Analytics dashboards, streaks, goals |
| — | `packages/contracts` with versioned job schemas; correlation IDs; one central permission check (always "allowed" for now) | AI (D13), notifications, integrations, subscriptions and payments, uploads |
