# Socket.IO Events

Status: **Architecture**, implementing F5, F6, F7, D9, D10, D11, D16, D17, D19. Timing rules are in `architecture/focus-timing-protocol.md`; authentication details in `architecture/auth.md`.

## Connection model

- **Handshake:** the client sends its access token in `auth: { token }`. Middleware verifies it, rejects revoked sessions, loads the user and sets `socket.data = { userId, sid, displayName, avatarUrl, tokenExpiresAtMs, joinedRooms }`.
- **Channels:** every socket joins `user:{userId}` and `session:{sid}`. Room sockets also join `room:{roomId}`.
- **Identity:** never taken from payloads. No event carries `userId`, `userName`, role or host status from the client.
- **Validation:** every incoming payload is validated with Zod. Failures are answered through the acknowledgement with `VALIDATION_FAILED`.
- **Acknowledgements:** every client → server event has an acknowledgement shaped `{ ok: true, … }` or `{ ok: false, error: { code, message } }`.
- **Token expiry:** the server disconnects the socket at token expiry. The client reconnects with a fresh token and sends `room:join` again for any room it was in.
- **Revocation:** logout or refresh-token reuse disconnects all sockets in `session:{sid}`.
- **Disconnect:** handled per user and per room as described in the timing protocol. A plain disconnect never abandons a session immediately; `room:leave` does.
- **Transports:** Socket.IO defaults, polling upgraded to WebSocket (R5). Multiple API instances with polling need sticky sessions. Messages are limited to 16 KB.
- **Handshake refusals** (`connect_error`, `err.data.code`): `UNAUTHENTICATED`, `SESSION_REVOKED`, `INTERNAL`.
- **Implemented in Phase 6:** `room:join`, `room:leave`, `room:knock`, `room:knock:cancel`, `room:chat:send` and the presence, member, settings, knock, chat and resync events (M4–M10). The timer and focus-run parts (`room:timer:command`, `room:timer:state`, `room:focus:participants`, the snapshot's `timer`/`participants`/`me`) arrive in Phases 7 and 8.
- **Implemented in Phase 3:** the handshake, the `user:`/`session:` rooms, token-expiry and revocation disconnects, and `time:sync` (answered with Redis TIME, R2). Phase 4B adds the first server → client product event, `focus:session:updated` (R8, E6; see "Server → client").

## Client → server

| Event | Payload | Acknowledgement (success) | Authorization | Redis change | Broadcast |
|---|---|---|---|---|---|
| `room:join` | `{ roomId }` | `{ snapshot }` (below) | Membership required (D9); `NOT_A_MEMBER` also for a room that does not exist (M4); `ROOM_FULL` for a new person when `ROOM_MAX_PRESENT` are present (M6). Idempotent per socket | Adds room presence. From Phase 8: clears the participant's disconnect marker; settles a completed run the user was waiting on | `room:presence:joined` to the room if this is the user's first socket there; from Phase 8 `focus:session:updated` to the user if settled |
| `room:leave` | `{ roomId }` | `{}` | Joined (`NOT_JOINED`) | Removes this socket from the room's presence; the membership stays (M9). From Phase 8: if the user was a participant, abandons with `left_room` (PostgreSQL first) | `room:presence:left` if the user's last socket; from Phase 8 `room:focus:participants` |
| `room:knock` | `{ roomId }` | `{ expiresAtMs }` | Private room (`NOT_PRIVATE`), not a member (`ALREADY_MEMBER`), host online (`HOST_OFFLINE`, D20 default); at most 5 per minute (`RATE_LIMITED`) | Adds a pending knock with TTL `KNOCK_TTL_MS` (M7) | `room:knock:received` to `user:{hostId}` |
| `room:knock:cancel` | `{ roomId }` | `{}` | Has a pending knock | Removes the knock | `room:knock:removed` to `user:{hostId}` |
| `room:timer:command` | `{ roomId, command }` where `command` is `{ type: "start" }`, `{ type: "pause" }`, `{ type: "resume" }`, `{ type: "reset", expectedVersion }`, or `{ type: "setPhase", phase, expectedVersion }` | `{ timer }` | Joined and host | Timer (atomic); may close a run (D17) | `room:timer:state`; if a run closed: `room:focus:participants` and per-user `focus:session:updated` |
| `room:chat:send` | `{ roomId, clientMessageId (UUID), body }` (body trimmed, 1–1000 chars) | `{ messageId, sentAtMs }` | The socket is in the room (`NOT_JOINED`); at most 10 per 10 s per user (`RATE_LIMITED`) | De-duplication key (60 s) only (D7, M8) | `room:chat:message` to the room, including the sender. A repeat of a `clientMessageId` is answered with the original ids and not delivered again |
| `time:sync` | `{ clientSentAtMs }` | `{ serverNowMs }` | Authenticated | — | — |

Error codes returned through acknowledgements include `NOT_A_MEMBER`, `NOT_JOINED`, `NOT_HOST`, `ROOM_NOT_FOUND`, `ROOM_FULL`, `VERSION_CONFLICT` (with the current timer), `INVALID_TRANSITION`, `NOT_PRIVATE`, `ALREADY_MEMBER`, `HOST_OFFLINE`, `RATE_LIMITED`, `VALIDATION_FAILED`, `INTERNAL`.

A socket may act in a room only while it is in that room's Socket.IO room (`room:{roomId}`): joining puts it there; `room:leave`, a disconnect and removal from the membership take it out (M5, M9).

### `room:join` snapshot

```
{
  room: RoomView,                     // includes timerSettings
  presence: PresenceUser[],           // { userId, displayName, avatarUrl }
  pendingKnocks?: KnockView[],        // host only: { userId, displayName, avatarUrl, expiresAtMs }
  serverNowMs: number
  // Phase 7 adds: timer: TimerView
  // Phase 8 adds: participants: Participant[]  // { userId, displayName, optedInAtMs, connected }
  //               me: { participation: { sessionId, focusRunId } | null }
}
```

The socket joins the Socket.IO room before the presence list is read, so no event between the snapshot and the subscription is missed. Clients send `room:join` again after every connect and after `room:resync`.

## Server → client

| Event | Payload | Sent to |
|---|---|---|
| `room:presence:joined` | `{ roomId, user: PresenceUser }` | Room, excluding the joiner; only when the user's first socket joins |
| `room:presence:left` | `{ roomId, userId }` | Room; only when the user's last socket leaves, disconnects, is evicted or its instance dies (M5) |
| `room:member:joined` | `{ roomId, member: RoomMemberView }` | Room. A new member (a public join or an approved knock); a hint to show them (M10) |
| `room:timer:state` | `{ roomId, timer: TimerView, serverNowMs }` | Room |
| `room:settings:updated` | `{ roomId, timerSettings, effectiveFrom: "next_phase" }` | Room |
| `room:focus:participants` | `{ roomId, focusRunId, participants: Participant[] }` | Room |
| `room:knock:received` | `{ roomId, requester: { userId, displayName, avatarUrl }, expiresAtMs }` | `user:{hostId}` |
| `room:knock:removed` | `{ roomId, userId, reason: "approved" \| "rejected" \| "cancelled" }` | `user:{hostId}` |
| `room:knock:resolved` | `{ roomId, outcome: "approved" \| "rejected" }` | `user:{requesterId}` only |
| `room:chat:message` | `{ roomId, messageId, clientMessageId, sender: { userId, displayName }, body, sentAtMs }` | Room |
| `room:member:removed` | `{ roomId, userId, reason: "removed" \| "left" }` | Room and `user:{userId}`; the server also removes that user's sockets from the room |
| `room:resync` | `{ roomId }` | Room. Clients respond with `room:join` to get a fresh snapshot (used after Redis state loss) |
| `focus:session:updated` | `{ session: FocusSessionView }` | `user:{userId}` (every tab). Sent after every committed session transition: start, pause, resume, stop, completion and abandonment, whether caused by a request, a job or the reconciler (E6). The first product event (R8). Clients apply the payload and then refetch `GET /focus-sessions/current`, so a duplicate, late or missed event heals itself; they also refetch after reconnecting |

Knock expiry is not announced: both sides know `expiresAtMs`. If a knock expires unanswered, the requester's client re-checks access with `GET /rooms/by-code/:code`.

## Duplicate and out-of-order events

- Timer state carries `version`; clients ignore anything older than what they have.
- `pause`/`resume` repeated are no-ops; `reset`/`setPhase` require `expectedVersion`.
- Chat is de-duplicated by `clientMessageId`.
- Presence counts sockets per user, so repeated joins or several tabs show one person.
- A repeated `room:knock` refreshes the existing knock.
