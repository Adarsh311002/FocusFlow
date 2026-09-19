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

### F3 — TypeScript throughout the Node ecosystem
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

## Authentication decisions

### D1 — Google account linking
- **Decision:** Never link Google to an existing password account automatically just because the verified emails match. If Google sign-in finds a password account with that email and no linked Google identity, refuse the merge and tell the user to sign in normally and link Google explicitly from account settings. The user model includes `email_verified_at`; Google-created accounts may be marked verified.
- **Why:** Automatic linking allows account pre-hijacking when password signups don't verify email ownership.

### D23 — Per-device sessions and rotating refresh tokens
- **Decision:** Auth sessions are per device. The refresh token lives in an httpOnly cookie and is rotated on every refresh. Reuse of an already-rotated token revokes that session; a short previous-token overlap window prevents simultaneous refreshes from being treated as theft. Access tokens are short-lived and kept in client memory. Exact lifetimes are set during implementation.
- **Consequences:** The refresh token encodes its session ID so reuse of any older token can be detected; revocation is checked on REST and socket authentication. See `architecture/auth.md`.

## Accepted architecture direction

The following are accepted as the design direction but were not approved as individual product decisions. They may be refined during implementation if they stay consistent with the decisions above:

- Monorepo layout with a shared `packages/contracts` package.
- Focus runs and a Redis run ledger for settling room sessions.
- BullMQ delayed jobs for phase ends, solo session ends and grace expiry, plus a periodic reconciler.
- Redis-loss detection through an epoch marker key, with `timer_lost` recovery.
- Knock approval over REST; knocks themselves over Socket.IO with a TTL.
- Same-origin deployment (frontend, `/api` and `/socket.io` behind one origin).
- Clock sources: Redis server time for room timer arithmetic; PostgreSQL `now()` for stored timestamps and solo session arithmetic.
