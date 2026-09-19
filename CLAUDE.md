# Focus Flow

Focus Flow is being redesigned as **Focus Flow v2**.

The existing repository contains an older JavaScript/MERN implementation. We are not blindly restoring that architecture. We are using the existing codebase as a source of product and engineering context while designing a cleaner v2 architecture.

## Current Development Phase

We are currently in the **product/domain/architecture design phase**.

Do not begin implementation, migration, or large-scale refactoring until the relevant design checkpoints are explicitly approved.

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

## Design-Phase Rules

Until explicitly approved otherwise:

- Do not modify application/source code.
- Do not create database migrations.
- Do not perform MongoDB → PostgreSQL migration.
- Do not choose Prisma, Drizzle, or another ORM prematurely.
- Do not delete old functionality merely because it belongs to the old architecture.
- Do not treat speculative architecture as implemented functionality.
- Clearly distinguish:
  - existing functionality
  - approved v2 decisions
  - proposed ideas
  - unresolved decisions

## Existing Repository

The existing codebase should be treated as useful historical/contextual material.

Do not assume that the existing implementation defines the final v2 architecture.

When an old implementation conflicts with an explicitly approved v2 decision, the approved v2 decision takes precedence.

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
