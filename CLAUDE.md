# Focus Flow

Focus Flow is being redesigned as **Focus Flow v2**.

The existing repository contains an older JavaScript/MERN implementation. We are not blindly restoring that architecture. We are using the existing codebase as a source of product and engineering context while designing a cleaner v2 architecture.

## Current Development Phase

Product/domain/architecture design is complete and the implementation plan is approved (see `docs/implementation/plan.md`).

**Phase state:** Phases 0 (foundation), 1 (accounts), 2 (tasks) and 3 (real-time foundation) are merged into `main` (checkpoints: tags `phase-1-accounts`, `phase-2-tasks`, `phase-3-realtime`). Phase 4A (presence hardening) is merged into `main` (checkpoint: tag `phase-4a-presence-hardening`). Phase 4B (Solo Focus) is **implemented and committed** on branch `v2/phase-4b-solo-focus` (not merged into `main`): E1–E23 are approved; Milestones 1–4 (foundation and migration, solo API, lifecycle jobs and presence integration, reconciler sweep and recovery) are implemented there; Milestone 5 (the Solo Focus web interface and the `focus:session:updated` event, technical defaults W1–W6 awaiting review) is committed on `v2/phase-5-review` (commits `410f948`, `89eaf01` and later). Phase 5 (Review) is **committed and pushed** on branch `v2/phase-5-review` (branched from the Phase 4B branch; not merged into `main`): history and summary endpoints and the `/review` page with technical defaults V1–V8 awaiting review; legacy deletion waits for the owner's answer on deployment and MongoDB data. Phase 6 (Rooms and presence) is **committed and pushed** on `v2/phase-6-rooms` (not merged into `main`; commits `d66b59a`, `f5db99a`). Phase 7 (the shared room timer) is **committed and pushed** on `v2/phase-7-room-timer` (branched from `v2/phase-6-rooms`; not merged into `main`). Phase 8 (room focus runs) is **implemented** on `v2/phase-8-room-focus-runs` (branched from `v2/phase-7-room-timer`; being committed, not merged into `main`). **Owner decision, 2026-11-11:** M1–M13, RT1–RT13 and RF1–RF17 are accepted as the MVP baseline (tested implementation) subject to the changes recorded below (RT1, RT8, D16, D17a, RF7, RF17); migration `0004` (RF1) is approved with a coordinated migration/deployment requirement (migrate first, then deploy all roles together; old workers or API code must not run against the new schema); the non-blocking open items D2, D12, D20, D24, D31, D32, D34, D36, D37 are **deferred**, not blocking delivery. Phase 1b (Google sign-in) has **not started**. Phase 9 (production readiness: REST and socket rate limiting, room lookup/creation abuse protection, membership removal/rejoin policy, production Docker images and Nginx, database migrations and backups, CI/E2E integration, security review, load testing, runbooks, final deployment verification) is the **next milestone, not started**. Implementation proceeds phase by phase; do not begin a phase, a migration, or large-scale refactoring until that phase is explicitly started by the user.

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
- PostgreSQL owns the saved settings. Redis stores the active timer state, including the active phase's duration, which is fixed when the phase is created (RT8); there is no separate Redis copy of the settings.

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
- **R3 Revocation decision (security; revised by review fix R-2):** the Redis marker `auth:revoked:{sid}` is a positive shortcut only: present → revoked, without a PostgreSQL query. A missing marker is never proof of "not revoked": PostgreSQL (`auth_sessions.revoked_at`, one primary-key lookup) decides, and it also decides when Redis is unreachable. When PostgreSQL is needed and unavailable the check fails closed (503 / `INTERNAL`) for REST and the socket handshake alike. A revoked session never becomes trusted because Redis lost, failed to persist or temporarily lacks its marker. The epoch's age no longer affects revocation (the original trust-loss window is superseded); the epoch itself stays for data-loss detection and recovery.
- **R4 Per-user socket cap:** deferred to abuse/rate-limiting hardening.
- **R5 Transports:** Socket.IO's default polling → WebSocket upgrade; not WebSocket-only.
- **R6 Timing defaults (configurable):** `pingInterval` 10 s, `pingTimeout` 10 s, heartbeat 10 s, instance TTL 30 s, reconciler every 30 s plus startup.
- **R7 Roles:** `ROLE=all` (default), `api` or `worker`; a worker-only process has no HTTP listener. Worker health endpoints are revisited with a real separate worker deployment.
- **R8 No product events in Phase 3:** infrastructure only; `user:{userId}` gets its first product event in Phase 4.
- Socket identity comes only from the verified handshake token (the same JWT verification and revocation check as REST); `user:{userId}` and `session:{sid}` are server-derived rooms; token expiry disconnects the socket; revocation disconnects `session:{sid}` on every instance through the Redis emitter; PostgreSQL stays the only durable store.

### Presence hardening decisions (Phase 4A: H1–H4)
- **H1 Two-way sync:** each instance reconciles its live Socket.IO sockets against its reverse index after every heartbeat and at once after a reconnect, an epoch change or a rejoin: missing entries are added and stale ones removed from both sets in one transaction, queued in the same synchronous step that reads the live sockets. Single-flight; failed syncs and rejoins are retried by the next heartbeat.
- **H2 Offline events are hints:** `{ userId, reason: disconnect | missed_disconnect | instance_dead | instance_shutdown, disconnectedAtMs }`, with Redis TIME of the removal, of the detecting sync, the dead instance's last heartbeat, or a clean shutdown's cleanup (`instance_shutdown` added by E10 in Phase 4B; `disconnect` means only a socket's own disconnect handler). They may be missed, repeated (same key) or stale. Never decide a Solo Focus outcome from one: re-check `checkUser` (one atomic read with Redis TIME) and retry when it fails. Consumers collapse repeats by `(userId, disconnectedAtMs)`.
- **H3 Late grace:** a running solo session whose user is offline with no disconnect marker gets a normal 60-second grace from the detection time, unless Redis **definitely** lost its data during the running stretch (`epochCreatedAtMs > runningSinceMs + 2000`, refined by E9), in which case it is `abandoned(expired)`. The late-grace marker carries `detected` evidence (E10). Implemented with Solo Focus (Phase 4B).
- **H4 Online hint:** emitted when a user's socket is newly recorded, so the disconnect marker can be cleared early; grace expiry re-checks presence regardless.
- No presence tables, presence log, outbox, Redis streams, Lua, per-entry TTLs or Socket.IO connection-state recovery.

### Solo Focus decisions (Phase 4B: E1–E16)
- **E1** `planned_seconds` integer 60–14,400 (Zod + `CHECK`). **E2** stale window: 12 h from `started_at` → `abandoned(expired)`.
- **E3** `taskId` optional; when given: own, not deleted, open (locked `FOR SHARE`). The server never infers `users.current_task_id`.
- **E4** No `room_id`/`focus_run_id` in Phase 4B (Phase 6 adds them). **E5** `abandon_reason` CHECK allows only `stopped`, `grace_expired`, `expired` until Phase 6.
- **E6** `focus:session:updated` to `user:{userId}` after every committed transition (start, pause, resume, stop, complete, abandon).
- **E7** At or after `T_end`, the decision for a running session runs before a pause or stop, and its terminal outcomes win: `completed`, `abandoned(grace_expired)` (offline, the current marker's grace over), or `abandoned(expired)` after a definite Redis loss during the stretch without E8 proof — the same outcome as the end and grace jobs, whichever takes the row lock first. When it cannot decide (presence or epoch unknown or inside the E18 recovery window, and no E8 proof) the request answers `503` and changes nothing. Before `T_end` a pause or stop is unchanged.
- **E8** A disconnect with **observed** evidence at or after `T_end` (with tolerance) completes with `ended_at = T_end`; `detected` evidence never proves presence through `T_end`. An online-now hint alone never proves presence at `T_end`; completion always uses the session timing and the disconnect marker. Online at the decision completes (D35) only with no disconnect of the current stretch recorded and no definite Redis loss during the stretch (E9), or through E16. With a disconnect recorded, the end job, the reconciler and pause/stop never complete because the user is online now. After a definite Redis loss during the stretch, without observed proof, the session is `abandoned(expired)` even if online, by every caller including pause/stop; an unknown presence or epoch → retry (jobs) / `503` (pause/stop). Observed proof through the end decides on its own: it needs neither presence nor the epoch.
- **E9** PostgreSQL is the clock for session timestamps and focused-time arithmetic, read as `date_trunc('milliseconds', clock_timestamp())` after the session row lock is held (never `now()`, which is fixed at transaction start); Redis TIME for presence/epoch instants. Cross-clock comparisons use `CLOCK_SKEW_TOLERANCE_MS = 2000`, biased toward grace: `disconnectedAtMs + tol ≥ T_end` with `observed` evidence ⇒ through the end; `epochCreatedAtMs > runningSinceMs + tol` ⇒ definite Redis loss; otherwise prefer grace/unknown over `expired`. Redis instants stored as `ended_at` are clamped into `[running_since, T_end]`.
- **E10** Marker `ff:user:{userId}:disconnected` = `{sessionId}:{latestDisconnectedAtMs}:{evidence}`; `evidence` = `observed` (direct socket disconnect) or `detected` (`missed_disconnect`, `instance_dead`, `instance_shutdown`, late grace). Updated with `WATCH`/`MULTI` and bounded retry (no Lua, not `SET NX` alone): older → no change; equal → may only upgrade detected to observed (never downgrade); newer for the same session → replace; another session → replace; events or markers whose Redis timestamp predates the current running stretch (2 s tolerance) are ignored. Accepted limitation: a newer detected disconnect may replace an older observed one, which can lose a completion proof (session goes through grace) but never creates a false completion. **Clearing is always conditional on the marker still belonging to the session concerned** (reconnect: and not newer than the confirmation time, and an online hint clears only before `T_end` and inside that disconnect's grace — otherwise it keeps the marker and ensures its grace job; pause/resume/stop/settlement: never unconditional). Grace jobs settle only when their payload still matches the marker.
- **E11** Pause/resume/stop on an ended session → `200` with the session unchanged.
- **E12** Web: TanStack Query only; no optimistic updates; no Zustand. **E13** Add `fast-check` now; Playwright deferred.
- **E14** Round focused time down at pause/stop/settlement (may under-count repeated pauses by < 1 s each); completion sets `focused_seconds = planned_seconds`.
- **E15** Extra DB invariants: `running_since >= started_at`; `status <> 'completed' OR focused_seconds = planned_seconds`.
- **E16** Reconnect-within-grace recovery, narrowly scoped: only a **grace job** whose marker still exactly matches its session and `disconnectedAtMs`, finding the user online (a late grace job after a lost online hint), clears the marker and continues, or completes at `T_end` if it has passed (definite Redis loss during the stretch → `expired`, E9) — an intentional D35/H2 policy, because the exact reconnect time is unknowable. The end job, the reconciler and HTTP pause/stop never apply it: they hand a recorded disconnect over to its grace job, and a pause or stop is then not a completion.
- DB invariants: `0 ≤ focused_seconds ≤ planned_seconds`, `ended_at ≥ started_at`, `running_since ≥ started_at`, completed ⇒ `focused_seconds = planned_seconds`, one in-progress session per user.

### Solo Focus recovery decisions (Phase 4B Milestone 4: E17–E23, reviewed as A–G)
- **E17 (A)** Every running-session decision (end job, grace job, reconciler, pause/stop at or after `T_end`) reads the epoch and the disconnect marker in the same atomic Redis read as presence (TIME, entries, heartbeats, `ff:epoch`, the marker in one `MULTI`), after the row lock; never a cached epoch. Only when that snapshot fails is the marker read alone (E8 can still decide; if it fails too, nothing is decided). Missing/malformed epoch = unknown. PostgreSQL and Redis are not one transaction: a decision reflects the Redis instant it read; a disconnect whose marker is not yet written at that instant (the socket-removal-to-marker-write interval) is not evidence for it.
- **E18 (B)** Presence-recovery window: for `INSTANCE_TTL_MS` after an epoch is created (`[epochCreatedAtMs, epochCreatedAtMs + INSTANCE_TTL_MS)`, Redis TIME), or with an unknown epoch, every presence-dependent decision defers (jobs retry, reconciler defers, pause/stop at or after `T_end` → `503`). Qualifying E8 evidence keeps its precedence. The window only delays: afterwards a definite Redis loss without E8 proof is still `abandoned(expired)`, online or not (E9).
- **E19 (C)** Reconciler step 5 (the normal decision) runs before step 6 (12 h stale cleanup, E2). A session step 5 settled keeps its result; qualifying E8 evidence still completes first; a session still `in_progress` at 12 h is `abandoned(expired)` even if step 5 deferred. The threshold is never extended because Redis is unavailable.
- **E20 (D)** Scheduling an end/grace job ensures it: absent → add; waiting/delayed/active → nothing; retained completed/failed → `Job.retry(state, { resetAttemptsMade: true, resetAttemptsStarted: true })` (BullMQ 6.3, atomic); a lost race re-reads the actual state. `queue.add` with a retained id is a silent no-op.
- **E21 (E)** Start/resume answer `503` and change nothing when presence is untrusted (check failed, epoch unknown, inside the window); `409 NOT_CONNECTED` only from a trusted check.
- **E22 (F)** Stale cleanup needs only PostgreSQL and runs while Redis is unavailable; it commits the expiry; failed post-commit notifications/follow-ups are logged, never reported as delivered.
- **E23 (G)** Every worker process owns a reconcile trigger (every `RECONCILER_INTERVAL_MS`, non-overlapping): Redis reachable → re-register a missing schedule, and run the reconciler directly when `ff:reconcile:last-finished` is missing or ≥ 3 × `RECONCILER_INTERVAL_MS` old (90 s default); Redis unreachable → stale cleanup only. Runs are single-flight per process; overlapping runs across processes are safe (`FOR UPDATE SKIP LOCKED`, at most 4 sessions at once, 5 s statement timeout, a one-interval budget).

### Review decisions (Phase 5: V1–V8, technical defaults awaiting review)
- **V1** History `from`/`to` are optional instants (ISO-8601 with offset, ≤ ms precision), `startedAt` in `[from, to)`, `from < to`. The instant must also fall in `[1970-01-01T00:00:00.000Z, 9999-12-31T23:59:59.999Z]`: the floor mirrors V4 and the ceiling is the last instant a four-digit ISO year expresses, so an out-of-range bound (year 0, or year 10000 reached through an offset) answers `400 VALIDATION_FAILED` instead of reaching PostgreSQL as an engine-dependent value.
- **V2** History lists every status (in-progress included), `started_at DESC, id DESC`; the cursor is the opaque id of the last session, resolved owner-scoped in PostgreSQL (foreign/unknown → 400); limit 50/100; task joined on id and owner, soft-deleted tasks marked `deleted`.
- **V3** Summary `from`/`to` are required inclusive calendar dates in the required `tz`; no default range. **V4** `from ≤ to`, ≤ 366 days, ≥ 1970.
- **V5** `tz` is the exact name `UTC` or an `Area/Location` name recognised by `Intl` (matched case-insensitively, legacy aliases such as `Asia/Calcutta` and fixed-offset names such as `Etc/GMT+5` accepted); bare offsets, abbreviations and POSIX rules are refused. All summary calendar arithmetic runs in Node with `Intl`; PostgreSQL never receives the zone.
- **V6** The summary counts ended sessions only: completed in both totals and `completedCount`, abandoned (every reason) only in `totalFocusedSeconds`; in-progress excluded.
- **V7** A session counts entirely on its local start date; `days` is dense, oldest first, and sums to the totals. PostgreSQL sums per UTC minute (range widened by 2 days each side); Node maps minutes to dates.
- **V8** `/review` shows the last 7 days in the browser zone (fallback `UTC`), both totals labelled, a per-day table and the paged history (the history list is the whole history, not restricted to the summary range: it sends no `from`/`to`); review queries refetch whenever the page is shown and, since Milestone 5, whenever `focus:session:updated` arrives (W2).

### Solo Focus web decisions (Phase 4B Milestone 5: W1–W6, technical defaults awaiting review)
- **W1** The solo timer is a panel on `/dashboard`, above the tasks (the loop: decide → focus); no new route.
- **W2** `GET /focus-sessions/current` is the truth. A lifecycle answer is written to the cache only after `cancelQueries`, and only about the session the cache already holds (a start alone may fill an empty cache): a late pause, resume or stop for another session never replaces or hides a newer one, and a session a read saw ending is not revived by a late answer. What an answer leaves unwritten, the refetch that always follows corrects. `focus:session:updated` never writes the current session: it validates the payload, remembers a terminal session for the "what just happened" notice, and invalidates every `['focus-sessions', userId]` query (current, Review history and summary), restarting a read already in flight so a read answered before the change cannot stand in for it (a read still loading its first data is asked again once it settles). Every socket (re)connect, the first included, invalidates too, because events sent between the handshake and the room join are lost.
- **W3** Display only: remaining time from `focusedSeconds` plus the running stretch on the synced server clock, clamped to `[0, planned]`, with a note until the first clock sample. At 0:00 the panel says "Finishing… waiting for the server to confirm" and re-asks the server (about 0, 2 and 5 s, then every 10 s). The browser never completes, abandons or stops a session on its own.
- **W4** Every lifecycle control is disabled while any request is pending; a duplicate request with the same variables joins the one in flight; a start answered `409 SESSION_IN_PROGRESS` adopts the existing session; every mutation error refetches (the request may have committed). Stopping needs an in-page confirmation. Keyboard focus follows a replaced control only when focus is free or already inside the panel.
- **W5** Start form: 15/25/50-minute presets plus custom whole minutes 1–240; an optional task chosen from open tasks, preselecting the user's open current task as a visible convenience (the server never infers it, E3). Starting is not gated on the local socket state: `409 NOT_CONNECTED` and `503` (E21) are shown as the server's answer.
- **W6** The API emits `focus:session:updated` from its own after-commit listener, separate from the job follow-ups so neither can block the other; the room is derived from the session owner on the server. The event is typed in `packages/contracts` and its payload is a hint to refetch, never proof of an outcome. The Redis emitter publishes without awaiting, so a failed publish cannot be caught; the pub/sub connection queues commands while Redis is away, and clients heal a missed event on reconnect.

### Rooms decisions (Phase 6: M1–M13, accepted by the owner 2026-11-11 as the MVP baseline)
Full text: `docs/decisions/decision-log.md`.
- **M1** Phase 6 changed nothing in `focus_sessions` (time-bound; superseded by migration `0004` and RF1, which added the room columns, room abandon reasons, `NOT_SOLO_SESSION` and abandonment on leave/removal in Phase 8). The timer and participants joined the snapshot in Phases 7 and 8.
- **M2** Room codes: six characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, `crypto.randomInt`, unique with up to 5 retries; lookups forgive case and spaces; the code is not a secret (the knock protects a private room).
- **M3** Durations in seconds: focus 60–14,400 (default 1,500), short break 60–3,600 (300), long break 60–7,200 (900). `PATCH /rooms/:roomId/timer-settings` is host only, saves to PostgreSQL and emits `room:settings:updated` (next phase); there is no Redis copy of the settings (RT8).
- **M4** Member-only routes answer `404 ROOM_NOT_FOUND` to non-members and for nonexistent rooms; `403 NOT_HOST` only to members; the by-code preview `{ id, code, name, isPrivate }` is the single exception; leaving a room you are not in is `204`; `room:join` by a non-member is `NOT_A_MEMBER`.
- **M5** Room presence in Redis (`room:{id}:presence`, `room:{id}:presence:{userId}`, per-instance `instance:{id}:rooms`), counted only for live instances, synchronised with the sockets' Socket.IO rooms on every heartbeat, cleaned for dead instances; a socket's authority is `socket.rooms`.
- **M6** `room:join` needs membership, is idempotent, answers a snapshot (room, presence, host-only `pendingKnocks`, `serverNowMs`) and is re-sent after every connect and `room:resync`; `ROOM_MAX_PRESENT` (50) → `ROOM_FULL` (the D12 safety limit; D12 is a deferred item).
- **M7** Knocks: private rooms only, host must be online (D20, a deferred item), 120 s TTL, 5 per minute; approve/reject are REST (host only); PostgreSQL first, then Redis, then events.
- **M8** Chat: socket must be in the room; trimmed 1–1,000 characters; `SET NX` dedupe on `ff:chat:dedupe:{userId}:{roomId}:{clientMessageId}` for 60 s (per user and room; a repeat gets the original ids); 10 per 10 s; nothing stored.
- **M9** `room:leave` ends presence only; leaving the membership (never the host) and host removal (never the host) delete the row and evict the user's sockets with `room:member:removed`.
- **M10** `room:member:joined` announces a new member.
- **M11** Web: `/rooms` and `/rooms/$roomId`; Zustand store per room fed only by the snapshot and socket events; TanStack Query for REST data.
- **M13** Review hardening: chat re-checks membership and the heartbeat sync evicts non-member sockets; atomic room cap; presence read last in the snapshot (client replays buffered presence events); chat dedupe per room; `room:join`/`room:knock:cancel` rate limited; approve vs reject decided by the Redis knock removal (`resolveKnock` returns a boolean).
- **M12** Playwright suite in `e2e/` (`pnpm test:e2e`) against throwaway Testcontainers, the real API and Vite, using the installed Chrome.

### Room timer decisions (Phase 7: RT1–RT13, accepted by the owner 2026-11-11 as the MVP baseline)
Full text: `docs/decisions/decision-log.md`.
- **RT1** The timer hash `ff:room:{roomId}:timer` is created at the first access (join snapshot or first command) as an idle `focus` phase whose `durationMs` comes from the room's saved settings (PostgreSQL), by a version-checked write that requires the key to be absent. A phase's duration is therefore always fixed when the phase is created (D16). `reset` is allowed from any status, including `idle`, so the host can "apply now" a settings change to a phase that has not started. A reset in a focus phase closes the current run with reason `reset` and opens a new run in the same atomic write; a reset from idle creates no session and abandons (reason `reset`, 0 focused s) only the sessions of people who opted in during idle.
- **RT2** A new timer's `version` starts at the Redis TIME in milliseconds instead of 0; every accepted change adds 1. After a Redis loss or rollback the recreated timer's version is above any version a client or a leftover job holds, so an old phase-end job id (`phase-end_{roomId}_{version}`) cannot collide and clients do not ignore the new state. A join snapshot is authoritative: the client replaces its timer with it whatever its version; `room:timer:state` events apply only when their version is greater.
- **RT3** (superseded by RF2) The Phase 7 timer state had `phase, status, durationMs, elapsedBeforeMs, segmentStartedAtMs, version` only; Phase 8 added `focusRunId` (and the run ledger) as additive hash fields.
- **RT4** Queue `room-timer`, job `phase-end`, id `phase-end_{roomId}_{version}`, delayed to `endsAtMs − Redis now`, payload `{ schemaVersion, roomId, version }`. Scheduling uses the E20 "ensure" semantics (retained completed or failed jobs are re-run). A job never trusts its payload: it calls the service, which re-reads the timer; an outdated version or a non-running timer is a no-op, an early job asks to run again after the remaining time, and a duplicate delivery advances nothing twice (the write is version-checked).
- **RT5** `room:timer:command` needs the socket to be in the room (`NOT_JOINED`), the caller to be the room's host (`NOT_HOST`, checked against `rooms.host_id` in PostgreSQL on every command), at most 20 commands per 10 s per user (`RATE_LIMITED`) and a strictly valid payload. A command naming a room the socket has not joined changes nothing and reveals nothing.
- **RT6** `VERSION_CONFLICT` and `INVALID_TRANSITION` acknowledgements carry `error.details = { timer, serverNowMs }` so a stale client catches up without another round trip. The shared ack error shape gained an optional `details`.
- **RT7** Writes retry up to 3 times, re-reading and re-evaluating the pure function each time. `start`, `pause` and `resume` are judged against the fresh state; `reset` and `setPhase` carry `expectedVersion`, and a mismatch against the fresh state is `VERSION_CONFLICT`. A repeated `pause` while paused or `resume` while running is a successful no-op: no write, no version change. `start` while running or paused and `resume` while idle are `INVALID_TRANSITION`.
- **RT8** Phase durations are read from PostgreSQL whenever a phase is created. PostgreSQL owns the saved settings; Redis holds the active timer state including the active phase's duration, fixed when the phase is created. There is no separate Redis copy of the settings (the `ff:room:{roomId}:settings` key in the first Redis design is not implemented): phase creation is rare and a primary-key read is cheap, and it removes a second copy that could disagree. `PATCH timer-settings` still only saves and announces (`room:settings:updated`); it never touches the running timer.
- **RT9** The next phase is never started automatically (D32, a deferred item): `focus → short_break`, any break `→ focus`, always `idle`. `long_break` is reachable only through `setPhase`.
- **RT10** A phase end happens whoever is present; a host disconnect changes nothing (D10). Commands cannot arrive without the host's socket.
- **RT11** After a Redis loss the timer is recreated idle with the saved durations (RT1, RT2); Phase 6 already sends `room:resync`, and the rejoin snapshot carries the recreated timer.
- **RT12** Step 2: (a) running timers past `endsAtMs` get their phase end run (`ff:rooms:timers:running` scored by `endsAtMs`), (b) every running timer gets its phase-end job ensured. Batches of at most 100, single-flight, one room's failure is logged and never fatal.
- **RT13** After every committed change: ensure the phase-end job when the new state is running, then emit `room:timer:state { roomId, timer, serverNowMs }` to the room. A failed schedule is repaired by the reconciler; a failed emit by the clients' resync on reconnect.

### Room focus run decisions (Phase 8: RF1–RF17, accepted by the owner 2026-11-11 as the MVP baseline)
Full text: `docs/decisions/decision-log.md`.
- **RF1** `focus_sessions.room_id` / `focus_run_id` (both or neither, no FK for the run), `running_since` solo-only, room-only abandon reasons `opted_out, left_room, removed, reset, phase_changed, timer_lost`.
- **RF2/RF3** every focus-phase timer (idle too) carries a `focusRunId`; a timer change and its run closure/opening are one atomic Redis write; closed runs enter `rooms:runs:unsettled`.
- **RF4** opt-in: checks, PostgreSQL insert, atomic ledger add, announce; `planned_seconds` = remaining phase time (`409 RUN_ENDING` below 60 s); `RUN_CHANGED` deletes the just-created row; a retry repairs the ledger.
- **RF5/RF6** focused time rounded down and clamped; `ended_at` clamped; every transition locks the row and touches only `in_progress` rows.
- **RF7** 60 s grace (plus a 1 s early tolerance, `GRACE_EARLY_TOLERANCE_MS`, for BullMQ clock differences: at most 61 s) for the user's last room socket, deterministic `room-grace` job, stale jobs are no-ops; **RF8** opt-out/leave/removal abandon in PostgreSQL first; **RF9** PostgreSQL-driven reconciler sweep; **RF10** global Redis-loss recovery: room sessions without a ledger entry become `timer_lost` (focused 0), solo untouched; **RF11** solo isolation (`NOT_SOLO_SESSION`); **RF12** `room:focus:participants` and the snapshot's `focus`.
- **RF13** web "Focus together" panel (display only, the browser decides no outcome); **RF14** participants visible to room members only, the ledger stores no task titles; **RF15** orphan sessions repaired by a retry or `timer_lost` after 2 min; **RF16** history and summary count room sessions like solo ones, each item has its `context`.
- **RF17** (implemented) Room sessions still `in_progress` 12 h after `started_at` are expired (`abandoned`, reason `expired`, no schema change) by reconciler step 6b (after steps 3/4/7 and solo step 6), with a 16-hour absolute maximum (`ROOM_STALE_AFTER_MS`, `ROOM_STALE_HARD_MAX_MS` in `room-focus/types.ts`; code `room-focus/stale.ts`). A session whose own run is open with the timer running is exempt until 16 h; a closed-unsettled run is left to its settlement until 16 h (then expired with the run's frozen `elapsedAtCloseMs`); paused/idle runs expire at 12 h. Focused time runs from opt-in to the timer's elapsed (or frozen at close), floored and clamped, never past a recorded disconnect; no ledger entry means 0 s. Redis is read first: if it cannot answer nothing is decided (next sweep). PostgreSQL decides under `FOR UPDATE SKIP LOCKED`, the age re-checked with the PostgreSQL clock, touching only the `in_progress` row of that run (idempotent). After commit: compare-and-delete the ledger entry (by sessionId) + `finishRun`, then announce `room:focus:participants` and `focus:session:updated`; failed ledger cleanups stay in the process backlog and are retried by every full reconcile run. Solo sessions are never selected (`room_id IS NOT NULL`) and solo stale cleanup ignores room rows. This replaces the accepted limit RF-L7 (resolved by RF17).
- **D17a** (owner-approved 2026-11-11; called "Rev J3" in code comments) A phase that has already reached its true end is completed even if the `reset`/`setPhase` command arrives late (before its phase-end job ran): the run closes `completed` with `closedAtMs = min(now, endsAt)`; people present at the end complete (D35); a disconnect recorded at or after the true end counts as present at the end (also when the delayed grace job runs before the delayed phase-end job: completed at the true end). A reset/phase change at least 1 ms before the end abandons as before (D17).
- **Implemented technical details:** `participantsVersion` (G2: a per-run, server-owned monotonic version in the run hash, incremented in the ledger Lua scripts; carried by the join snapshot's `focus` and by `room:focus:participants`; the client applies an event only for the same run and a higher version, and a join snapshot is authoritative). G3: `closedAtMs = min(now, endsAt)`, `wasPresentThroughEnd`, `pendingEndAtMs` / open-run settlement at the true end. G4: the knock approve-vs-reject/expiry compensation abandons the room session with reason `removed` and announces the member removal; the web clears a stale `removed` flag on `room:knock:resolved` approved / `room:member:joined` for the user. Defaults: `ROOM_FOCUS_RATE` 10 per 10 s, `RECOVERY_SETTLE_MS` 10 s, reconciler room sweep batch 100 / concurrency 4 / cursor, a pause is rejected at or after the phase end, opt-in retries up to 4 attempts, `SCHEDULE_TIMEOUT_MS` 2 s, grace configurable as `FOCUS_GRACE_MS`.
- **Deployment (migration `0004`):** migrate first, then deploy all roles together; stop old workers before the new migration goes live, because old code on the new schema would not exclude room rows from solo sweeps.

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
