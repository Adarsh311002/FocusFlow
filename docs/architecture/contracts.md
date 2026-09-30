# TypeScript Contracts

How the frontend, API, socket server and workers share types and validation. Approved: F3 (strict TypeScript, no new JavaScript). The layout and patterns below are **Architecture**.

## Repository layout (target)

```
apps/
  web/            React + Vite (TSX)
  api/            Express + Socket.IO; worker entry point/role (runs inside the API process initially, I7)
packages/
  contracts/      Zod schemas and inferred types; depends only on zod
    src/ids.ts                  branded IDs
    src/errors.ts               error code union, error body schema
    src/http/                   auth, me, tasks, focus-sessions, rooms request/response schemas
    src/socket/events.ts        ClientToServerEvents, ServerToClientEvents, SocketData, payload schemas
    src/domain/                 view types: user, task, focus-session, room, timer
    src/jobs/                   queue job payload schemas (exported to JSON Schema for Python later)
services/
  ai/             Python AI service (later phase)
tsconfig.base.json              shared strict compiler options (root file, not a package)
```

The workspace uses pnpm (I1, I3). `packages/contracts` has no build step: both apps consume its TypeScript source. Inside `contracts`, relative imports are extensionless (`./errors`), because every consumer resolves the source through a bundler; the API's own files use explicit `.js` extensions (`./config.js`), which also work under Node ESM. Route paths (`API_BASE_PATH`, `healthPaths`) live in `contracts` so the API and the web app cannot drift apart. Domain logic (for example the pure timer transition function, I8) lives in `apps/api`, not in `contracts`; `contracts` holds only schemas and types. The legacy `Client/` and `Server/` folders remain untouched (I12).

## Rules

1. **Zod is the source of truth.** Every request, response, socket payload and job payload is a Zod schema; TypeScript types come from `z.infer`. The server validates everything it receives. The client may also validate responses (at least in development).
2. **Contracts are not persistence types.** ORM/row types stay inside the API's data layer and are mapped to contract views there. The ORM choice therefore never changes the API.
3. **Branded IDs** prevent mixing identifiers: `UserId`, `TaskId`, `FocusSessionId`, `RoomId`, `RoomCode`, `AuthSessionId`, `FocusRunId`. For example `z.uuid().brand<"RoomId">()`.
4. **Discriminated unions** for anything with a lifecycle, so impossible states cannot be represented.
5. **Units in names:** `…Seconds` for session durations; `…Ms` and `…AtMs` (epoch milliseconds) for timer values; `…At` (ISO-8601 strings) for REST timestamps. `Date` objects never cross the wire.
6. **Strict compiler settings:** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noImplicitReturns`, `verbatimModuleSyntax`, `isolatedModules`, `erasableSyntaxOnly` (no `enum`: use string-literal unions and `as const` objects). ESM with `moduleResolution: "bundler"`; the compiler only typechecks. ESLint forbids `any` and unsafe casts (I11).
7. **Inbound schemas are strict objects** (unknown keys rejected), so a client payload that tries to send identity fields such as `userId` fails validation (F7).
8. **Environment variables** are validated with Zod at startup; the process refuses to start with invalid configuration. `process.env` is read only in the config module.

## Key contract shapes

Illustrative shapes (written as TypeScript-like pseudocode, not files):

```
AbandonReason = "stopped" | "expired" | "grace_expired" | "opted_out" | "left_room"
              | "removed" | "reset" | "phase_changed" | "timer_lost"

FocusSessionContext =
  | { kind: "solo" }
  | { kind: "room"; roomId: RoomId; focusRunId: FocusRunId }

FocusSessionView = {
  id: FocusSessionId
  context: FocusSessionContext
  task: { id: TaskId; title: string; deleted: boolean } | null
  plannedSeconds: number
  focusedSeconds: number
  startedAt: string
} & (
  | { status: "in_progress"; runningSince: string | null }   // runningSince only for solo
  | { status: "completed"; endedAt: string }
  | { status: "abandoned"; endedAt: string; abandonReason: AbandonReason }
)

TimerView = {
  phase: "focus" | "short_break" | "long_break"
  version: number
  durationMs: number
  focusRunId: FocusRunId | null
} & (
  | { status: "idle"; remainingMs: number }
  | { status: "running"; endsAtMs: number }
  | { status: "paused"; remainingMs: number }
)

TimerCommand =
  | { type: "start" } | { type: "pause" } | { type: "resume" }
  | { type: "reset"; expectedVersion: number }
  | { type: "setPhase"; phase: TimerView["phase"]; expectedVersion: number }

RoomTimerSettings = { focusSeconds: number; shortBreakSeconds: number; longBreakSeconds: number }

UserView = {
  id: UserId; email: string; emailVerified: boolean; displayName: string
  avatarUrl: string | null; currentTaskId: TaskId | null; identities: "google"[]
}
// Implemented in packages/contracts/src/http/user.ts. `currentTaskId` arrived in Phase 2
// together with the `users.current_task_id` column (Phase 1 omitted it rather than fake it).

TaskView =                                   // packages/contracts/src/http/tasks.ts
  { id: TaskId; title: string; createdAt: string; updatedAt: string } & (
    | { status: "open" }
    | { status: "completed"; completedAt: string }
  )                                          // deleted tasks have no representation

Ack<T> = { ok: true } & T | { ok: false; error: { code: ErrorCode; message: string } }
```

Server-internal states (for example a run that is closing, or a participant waiting for grace) are not part of the shared contract.

## Typed Socket.IO

`packages/contracts/src/socket/events.ts` exports `ClientToServerEvents`, `ServerToClientEvents`, `InterServerEvents` and `SocketData`. The server is `Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>` and the client uses the matching `Socket` type, so every emit, handler and acknowledgement is type-checked on both sides. Payload schemas for client → server events are also used for runtime validation on the server.

## Error codes

One closed union shared by REST and socket acknowledgements, including: `VALIDATION_FAILED`, `UNAUTHENTICATED`, `SESSION_INVALID`, `SESSION_REVOKED`, `INVALID_CREDENTIALS`, `EMAIL_TAKEN`, `ACCOUNT_EXISTS_LINK_REQUIRED`, `GOOGLE_EMAIL_UNVERIFIED`, `GOOGLE_TOKEN_INVALID`, `IDENTITY_ALREADY_LINKED`, `NOT_FOUND`, `TASK_NOT_FOUND`, `TASK_NOT_OPEN`, `SESSION_IN_PROGRESS`, `NOT_CONNECTED`, `NOT_SOLO_SESSION`, `RUN_CHANGED`, `NOT_A_MEMBER`, `NOT_JOINED`, `NOT_HOST`, `HOST_CANNOT_LEAVE`, `KNOCK_REQUIRED`, `KNOCK_EXPIRED`, `NOT_PRIVATE`, `ALREADY_MEMBER`, `HOST_OFFLINE`, `VERSION_CONFLICT`, `INVALID_TRANSITION`, `RATE_LIMITED`.

## Future: Node ↔ Python contracts

- Job payload and result schemas live in `packages/contracts/src/jobs` as Zod schemas with a `schemaVersion` field.
- They are exported to JSON Schema (Zod v4 supports this) and generated into Pydantic models for the Python service.
- A CI check fails if the generated Pydantic models drift from the Zod source.
- Only the queue contract crosses the language boundary. Payloads carry IDs and options, not bulk data.
