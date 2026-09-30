# Redis Keys and Semantics

Redis holds disposable state and infrastructure (F2). If losing something would permanently lose user data, it belongs in PostgreSQL instead. Status: **Architecture**.

## Configuration

- Client library: `ioredis` for all connections (required by BullMQ) (I7). Per process: one general connection, BullMQ's connections (workers need their own blocking connection), and the Socket.IO adapter's publish/subscribe pair.
- Local development: Redis runs in Docker via `infra/compose.yaml` with the same persistence and eviction settings as production (I9).
- AOF persistence (`appendfsync everysec`): a normal restart loses at most about one second of changes.
- `maxmemory-policy noeviction`: required by BullMQ, and prevents Redis from silently dropping timer or presence keys.
- Correctness never depends on persistence. Data loss is detected and handled explicitly (below).

## Keys

All application keys start with the configured prefix (P3): `REDIS_KEY_PREFIX`, default `ff:`. The keys below are written with the default prefix. Values are validated with Zod when read.

| Key | Type | Contents | Lifetime |
|---|---|---|---|
| `ff:epoch` | String | `{uuid}.{createdAtMs}` (Redis TIME), set once with `SET NX` (R3) | Permanent; its disappearance means Redis lost its data; its age drives the revocation trust window |
| `ff:instances` | Sorted set | `instanceId` scored by its last heartbeat (Redis TIME, ms) (R1) | Refreshed every heartbeat; dead ones removed by the reconciler (the score survives the instance) |
| `ff:instance:{instanceId}:sockets` | Set | `{userId}:{socketId}`: reverse presence index (R1) | Emptied as sockets disconnect; deleted by clean shutdown or the reconciler |
| `ff:user:{userId}:sockets` | Set | `{instanceId}:{socketId}` | Emptied as sockets disconnect; entries of dead instances ignored at read time and removed by the reconciler |
| `ff:user:{userId}:disconnected` | String | `disconnectedAtMs` while a running solo session is in grace | Deleted on reconnect or settlement; safety TTL |
| `ff:room:{roomId}:presence` | Hash | `userId → { displayName, avatarUrl, firstJoinedAtMs }` | Entry removed when the user's last room socket leaves |
| `ff:room:{roomId}:presence:{userId}` | Set | `{instanceId}:{socketId}` | Emptied atomically on join/leave |
| `ff:room:{roomId}:settings` | Hash | `focusSeconds, shortBreakSeconds, longBreakSeconds` (live copy of D16) | Reloaded from PostgreSQL when missing |
| `ff:room:{roomId}:timer` | Hash | `phase, status, durationMs, segmentStartedAtMs, elapsedBeforeMs, version, focusRunId, updatedAtMs` | Absent = idle focus with saved durations |
| `ff:rooms:timers:running` | Sorted set | `roomId` scored by `endsAtMs` | Used by the reconciler to find overdue timers |
| `ff:room:{roomId}:run:{runId}` | Hash | `status (open\|closed), closeReason, closedAtMs, elapsedAtCloseMs, durationMs` | Deleted after settlement |
| `ff:room:{roomId}:run:{runId}:participants` | Hash | `userId → { sessionId, optedInAtMs, elapsedAtOptInMs, disconnectedAtMs?, elapsedAtDisconnectMs? }` | Entries removed as participants settle |
| `ff:runs:unsettled` | Set | `{roomId}/{runId}` | Removed when every participant is settled |
| `ff:room:{roomId}:knocks` | Sorted set | `userId` scored by `expiresAtMs` | Expired entries pruned on read |
| `ff:auth:revoked:{sid}` | String | `1` | TTL = access-token lifetime |
| `ff:ratelimit:{action}:{userId}` | String | Counter | TTL = rate window |
| `ff:chat:dedupe:{userId}:{clientMessageId}` | String | `SET NX` marker | TTL 60 s |

Multi-key changes that must be consistent (timer + run close + unsettled set; presence sets + presence hash; participant add guarded by run ID) are written with small atomic Redis operations (Lua). For the timer (I8), the new state is computed in TypeScript from the current state and Redis `TIME`, and the Lua operation only checks that `version` is unchanged before writing all related keys; conflicts are retried a bounded number of times. Lua never contains business rules.

## Queues (BullMQ)

| Queue | Jobs |
|---|---|
| `room-timer` | Phase end |
| `focus-session` | Room participant grace, solo end, solo grace |
| `maintenance` | Reconciler (repeating) |

Job IDs are derived from the entity and version they apply to, so duplicates collapse and outdated jobs do nothing. Job IDs avoid `:`.

Workers run inside the API process initially, with their own entry point/role (I7). They send socket events through the Socket.IO Redis emitter rather than the in-process server, so running them as a separate process later requires no code change.

BullMQ keys use the same configured prefix (P3): with the default, queues live under `ff:bull` rather than BullMQ's built-in `bull:` prefix. A distinct prefix per test file gives each test an isolated key space in a shared Redis.

The Socket.IO Redis adapter and emitter use pub/sub channels, not keys; the channel prefix is `{REDIS_KEY_PREFIX}socket.io` (P3). Their connections (and BullMQ's) carry no ioredis `keyPrefix` and wait for a reconnect instead of rejecting, because the adapter and emitter do not await their commands.

**Implemented in Phase 3:** `ff:epoch`, `ff:instances`, `ff:instance:{instanceId}:sockets`, `ff:user:{userId}:sockets`, `ff:auth:revoked:{sid}` (Phase 1), and the `maintenance` queue with its reconcile scheduler. The other keys and queues arrive with their phases.

## Restart semantics

**Redis restarts with data (the normal case).** The epoch value is unchanged. Overdue phase-end and session-end jobs run on startup; the reconciler reschedules anything missing. Up to about one second of changes may be lost; version checks and the reconciler absorb it (for example, a lost pause leaves the timer running and the host can pause again; a lost opt-in entry becomes an orphan and is abandoned as `timer_lost`).

**Redis lost its data.** Detected when an API instance reconnects and `ff:epoch` is missing. The instance that succeeds in setting a new epoch runs **global recovery**; every instance runs **local recovery**.

| Lost | Handling |
|---|---|
| Room timers, runs, participants | Global: every in-progress **room** focus session → `abandoned(timer_lost)`. Rooms restart as idle focus with saved durations. |
| Presence | Local: rebuilt from each instance's connected sockets |
| Clients' view | Local: `room:resync` to every served room; clients rejoin for a fresh snapshot; affected users receive `focus:session:updated` |
| Solo sessions | Unaffected (PostgreSQL). The reconciler recreates their jobs. Running sessions of users who are not connected → `abandoned(expired)` |
| Knocks | Expire client-side; the requester can knock again |
| Queued jobs | Recreated by the reconciler from PostgreSQL (solo) or not needed (room timers restarted) |
| Rate limits, chat de-duplication | Harmless to lose |
| Revoked-session list | Lost markers are covered by the trust-loss window (R3): until the new epoch is one access-token lifetime old, revocation checks go to PostgreSQL, so a revoked session never becomes trusted |
