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
- **Transports:** WebSocket with long-polling fallback. Multiple API instances with polling need sticky sessions.

## Client → server

| Event | Payload | Acknowledgement (success) | Authorization | Redis change | Broadcast |
|---|---|---|---|---|---|
| `room:join` | `{ roomId }` | `{ snapshot }` (below) | Membership required (D9) | Adds room presence; clears the participant's disconnect marker; settles a completed run the user was waiting on | `room:presence:joined` to the room if this is the user's first socket there; `focus:session:updated` to the user if settled |
| `room:leave` | `{ roomId }` | `{}` | Joined | Removes this socket; if the user was a participant, abandons with `left_room` (PostgreSQL first) | `room:presence:left` if the user's last socket; `room:focus:participants` |
| `room:knock` | `{ roomId }` | `{ expiresAtMs }` | Private room, not a member, host online (D20 default) | Adds a pending knock with TTL | `room:knock:received` to `user:{hostId}` |
| `room:knock:cancel` | `{ roomId }` | `{}` | Has a pending knock | Removes the knock | `room:knock:removed` to `user:{hostId}` |
| `room:timer:command` | `{ roomId, command }` where `command` is `{ type: "start" }`, `{ type: "pause" }`, `{ type: "resume" }`, `{ type: "reset", expectedVersion }`, or `{ type: "setPhase", phase, expectedVersion }` | `{ timer }` | Joined and host | Timer (atomic); may close a run (D17) | `room:timer:state`; if a run closed: `room:focus:participants` and per-user `focus:session:updated` |
| `room:chat:send` | `{ roomId, clientMessageId, body }` (body 1–1000 chars) | `{ messageId, sentAtMs }` | Joined; rate limited | De-duplication key (60 s) only (D7) | `room:chat:message` to the room, including the sender |
| `time:sync` | `{ clientSentAtMs }` | `{ serverNowMs }` | Authenticated | — | — |

Error codes returned through acknowledgements include `NOT_A_MEMBER`, `NOT_JOINED`, `NOT_HOST`, `VERSION_CONFLICT` (with the current timer), `INVALID_TRANSITION`, `NOT_PRIVATE`, `ALREADY_MEMBER`, `HOST_OFFLINE`, `RATE_LIMITED`, `VALIDATION_FAILED`.

### `room:join` snapshot

```
{
  room: RoomView,                     // includes timerSettings
  presence: PresenceUser[],           // { userId, displayName, avatarUrl }
  timer: TimerView,
  participants: Participant[],        // { userId, displayName, optedInAtMs, connected }
  me: { participation: { sessionId, focusRunId } | null },
  pendingKnocks?: KnockView[],        // host only
  serverNowMs: number
}
```

## Server → client

| Event | Payload | Sent to |
|---|---|---|
| `room:presence:joined` | `{ roomId, user: PresenceUser }` | Room, excluding the joiner |
| `room:presence:left` | `{ roomId, userId }` | Room |
| `room:timer:state` | `{ roomId, timer: TimerView, serverNowMs }` | Room |
| `room:settings:updated` | `{ roomId, timerSettings, effectiveFrom: "next_phase" }` | Room |
| `room:focus:participants` | `{ roomId, focusRunId, participants: Participant[] }` | Room |
| `room:knock:received` | `{ roomId, requester: { userId, displayName }, expiresAtMs }` | `user:{hostId}` |
| `room:knock:removed` | `{ roomId, userId, reason: "approved" \| "rejected" \| "cancelled" }` | `user:{hostId}` |
| `room:knock:resolved` | `{ roomId, outcome: "approved" \| "rejected" }` | `user:{requesterId}` only |
| `room:chat:message` | `{ roomId, messageId, clientMessageId, sender: { userId, displayName }, body, sentAtMs }` | Room |
| `room:member:removed` | `{ roomId, userId }` | Room and `user:{userId}`; the server also removes that user's sockets from the room |
| `room:resync` | `{ roomId }` | Room. Clients respond with `room:join` to get a fresh snapshot (used after Redis state loss) |
| `focus:session:updated` | `{ session: FocusSessionView }` | `user:{userId}`. Sent whenever a solo or room session completes or is abandoned by the server |

Knock expiry is not announced: both sides know `expiresAtMs`. If a knock expires unanswered, the requester's client re-checks access with `GET /rooms/by-code/:code`.

## Duplicate and out-of-order events

- Timer state carries `version`; clients ignore anything older than what they have.
- `pause`/`resume` repeated are no-ops; `reset`/`setPhase` require `expectedVersion`.
- Chat is de-duplicated by `clientMessageId`.
- Presence counts sockets per user, so repeated joins or several tabs show one person.
- A repeated `room:knock` refreshes the existing knock.
