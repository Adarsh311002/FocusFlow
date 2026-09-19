# Legacy Implementation vs v2

The existing `Client/` (React + Vite, JavaScript) and `Server/` (Express + Mongoose + Socket.IO, JavaScript) folders are the **Existing (legacy)** implementation. They are historical and contextual material; approved v2 decisions take precedence wherever they conflict. The last legacy commit is from December 2025.

## What the legacy app does

- Email/password signup and login with JWT access and refresh tokens; logout.
- A personal task board (create, list, toggle complete, set one "active" task, delete).
- A solo Pomodoro timer on the dashboard.
- A marketing landing page.
- Partially built: Google sign-in, rooms (create, list, join), private-room knocking, a host-driven synced room timer, room chat, Redis-backed presence.

## Known legacy problems (from the audit)

**The app cannot start from a fresh install.**
- Server imports `socket.io`, `ioredis`, `google-auth-library` and `uuid`, none of which are in `Server/package.json`.
- Client imports `@react-oauth/google` and `socket.io-client`, neither of which is in `Client/package.json`.

**Broken flows.**
- `ActiveRoom.jsx` (room timer, chat, members, knock handling) is not routed; there is no `/room/:roomId` route.
- `room.controller.js`: default import of a named export (`Room`), undefined `userId`, `uuidv4.slice` instead of `uuidv4().slice`, `zod.safeParse` instead of the defined schema. `room.routes.js` imports without the `.js` extension (fails under ESM).
- `googleLogin`: reassigns a `const`, uses an undefined `googleId`, writes `name` instead of `fullname`, and calls a helper as a model method.
- `db.js` reads `MONGO_URL`; `docker-compose.yml` sets `MONGO_URI`.
- `fetchRooms` reads `res.data.data`, but the server returns `rooms`; `joinRoom` posts a bare string instead of `{ roomId }`.
- `AuthContext.jsx` and `SignInOut.jsx` use a named import of `api`, which is a default export.
- `PomodoroTimer.jsx` calls an undefined `handleSaveSession` (sessions are never saved) and uses an undefined `newTime`.
- The landing page references a missing `/web.jpg`; `GoogleAuthBtn.jsx` is never used.

**Design problems.**
- Sockets are not authenticated; clients send `userId`/`userName` in payloads and the server trusts them.
- Knock responses are sent to every connected client (`io.emit`); nothing checks that the approver is the host.
- Presence keys differ between join (`room: X`) and leave (`room:X`), so presence is never cleaned; `user_left` sends `userName` while the client filters by `userId`.
- One refresh token per user (a second login signs out the first device); tokens stored in `localStorage` and cookies at once.
- Login reveals whether an email exists ("User not found").
- The room timer is run by the host's browser and re-broadcast every 5 seconds.
- The server returns `fullname` while the client reads `name`/`fullName`, so display names fall back to the email prefix.
- The client's API base URL is hard-coded to `localhost:8001`.

## Reuse, migrate, replace, retire

| Category | Items |
|---|---|
| **Reuse later** (rebuilt in TSX) | Visual design and markup of the timer, chat box, task board, room lobby cards, active room layout, knock toasts, landing page layout |
| **Migrate conceptually** | Users, tasks, focus sessions, rooms and membership; host-controlled room timer; knock-to-enter private rooms; Redis presence; JWT access + refresh tokens; the task endpoints' shape; Zod validation at the edges |
| **Replace** | MongoDB/Mongoose → PostgreSQL (F1). Browser-run room timer → server-authoritative timer with versions (F6, D10). Payload identity → authenticated handshake (F7). Single refresh token → per-device rotating sessions (D23). `localStorage` tokens → memory + httpOnly cookie (D23). `Room.members` array → `room_members` (D9). `Task.isActive` → `users.current_task_id` (D3). Save-on-completion → save at start, then complete or abandon (D14/15/35). Hard task delete → soft delete (D38). `io.emit` knock replies → per-user channels |
| **Retire** | `User.role`, `Room.topic` (always hard-coded), `Room.isActive` (replaced by presence, D8), `Session.mode` (breaks are not sessions, D5), host re-broadcast on `user_joined`, `prompt()`/`confirm()` dialogs, dead navbar links, `nodemon` in production dependencies, the Mongo service in `docker-compose.yml` |
| **Do not carry forward just because it exists** | Unbacked landing page claims: pricing, analytics, offline mode, soundscapes (D33). The public `/timer` guest route (D26). `TiltCard`/`AudioBars` beyond the marketing page |

## Migration approach (Approved, I12)

- Build v2 in the new `apps/` and `packages/` layout with strict TypeScript. There is no gradual JavaScript-to-TypeScript conversion of the legacy app.
- `Client/`, `Server/` and the root `docker-compose.yml` stay untouched. They are excluded from the pnpm workspace, ESLint and CI; nothing in v2 imports them. Reusable UI markup is copied and rewritten as TSX.
- Legacy code is deleted in one dedicated commit at the solo-core milestone (end of Phase 5 in `implementation/plan.md`), not before.
- `archi/` is not modified or committed unless explicitly instructed.
- Legacy data migration (MongoDB → PostgreSQL) happens only if the project owner confirms there is data worth keeping; it would be a separate, explicitly approved step.
