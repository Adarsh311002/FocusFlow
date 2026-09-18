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
