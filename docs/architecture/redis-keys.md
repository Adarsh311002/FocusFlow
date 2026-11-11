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
| `ff:epoch` | String | `{uuid}.{createdAtMs}` (Redis TIME), set once with `SET NX` (R3) | Permanent; its disappearance means Redis lost its data. Its creation time is recorded but no longer affects revocation (R3, revised) |
| `ff:instances` | Sorted set | `instanceId` scored by its last heartbeat (Redis TIME, ms) (R1) | Refreshed every heartbeat; dead ones removed by the reconciler (the score survives the instance) |
| `ff:instance:{instanceId}:sockets` | Set | `{userId}:{socketId}`: reverse presence index (R1) | Emptied as sockets disconnect; kept equal to the instance's live sockets by its sync on every heartbeat (H1); emptied by clean shutdown or the reconciler |
| `ff:user:{userId}:sockets` | Set | `{instanceId}:{socketId}` | Emptied as sockets disconnect; stale entries of a live instance removed by its sync (H1); entries of dead instances ignored at read time and removed by the reconciler. Always changed together with the reverse index in one transaction |
| `ff:user:{userId}:disconnected` | String | `{sessionId}:{latestDisconnectedAtMs}:{evidence}` (Redis TIME; `evidence` is `observed` for a direct socket disconnect, `detected` for `missed_disconnect`, `instance_dead`, `instance_shutdown` and late grace) while a running solo session is in grace (E10) | Changed only with `WATCH`/`MULTI` and bounded retry: a newer disconnect for the same session replaces it, an older one is ignored, an equal one can only upgrade `detected` to `observed` (never the reverse), events from before the current running stretch are ignored, another session's marker is replaced. Cleared only while it still belongs to the session concerned: on a confirmed reconnect (up to the confirmation time), and on pause, resume, stop or settlement. Safety TTL longer than the 12-hour stale window. A decision reads it in the same `MULTI` as presence and the epoch (E17), on its own only when that read fails. See `focus-timing-protocol.md`, "Disconnect marker" |
| `ff:reconcile:last-finished` | String | When a reconcile run last finished (Redis TIME, ms), written by every run, scheduled or direct (E23) | TTL 24 h. Missing or at least 3 × `RECONCILER_INTERVAL_MS` old: each worker process reconciles directly |
| `ff:room:{roomId}:presence` | Hash | `userId → { displayName, avatarUrl, firstJoinedAtMs }` | Entry removed when the user's last room socket leaves |
| `ff:room:{roomId}:presence:{userId}` | Set | `{instanceId}:{socketId}` | Emptied atomically on join/leave |
| `ff:instance:{instanceId}:rooms` | Set | `{roomId}:{userId}:{socketId}`: reverse index of room presence (M5) | Kept equal to the instance's sockets in Socket.IO rooms by its sync on every heartbeat; emptied by clean shutdown or the reconciler. Always changed together with the presence sets |
| ~~`ff:room:{roomId}:settings`~~ | — | **Not implemented (RT8):** phase durations are read from PostgreSQL whenever a phase is created | — |
| `ff:room:{roomId}:timer` | Hash | `phase, status, durationMs, segmentStartedAtMs, elapsedBeforeMs, version, focusRunId` (`focusRunId` is set while the phase is focus, `''` in a break; a Phase 7 timer without the field reads as no run until the host changes the timer) | Materialised at first access as idle focus with the saved durations, `version` starting at the Redis TIME in milliseconds (RT1, RT2); never expires; recreated after a Redis loss |
| `ff:rooms:timers:running` | Sorted set | `roomId` scored by `endsAtMs` | Written in the same atomic operation as the timer hash (member present exactly while the timer is running); used by the reconciler to find overdue timers and running timers without a job (RT12) |
| `ff:room:{roomId}:run:{runId}` | Hash | `status (open\|closed), closeReason, openedAtMs, closedAtMs, elapsedAtCloseMs, participantsVersion` (server-owned monotonic counter of the participant list, incremented in the ledger scripts, G2; `closedAtMs` of a completed run is the true end, D17a) | Created and closed by the same atomic write as the timer (RF3); deleted by `finishRun` after settlement |
| `ff:room:{roomId}:run:{runId}:participants` | Hash | `userId → { sessionId, optedInAtMs, elapsedAtOptInMs, disconnectedAtMs?, elapsedAtDisconnectMs? }` | Entries removed as participants settle |
| `ff:rooms:runs:unsettled` | Sorted set | `{roomId}:{runId}` scored by `closedAtMs` | Added by the atomic close; removed by `finishRun` once the run is closed and has no participant left |
| `ff:room:{roomId}:knocks` | Sorted set | `userId` scored by `expiresAtMs` (`KNOCK_TTL_MS`, default 120 s) | Expired entries pruned on read; a repeated knock refreshes its score; removed on approve, reject and cancel |
| `ff:auth:revoked:{sid}` | String | `1` | TTL = access-token lifetime |
| `ff:ratelimit:{action}:{userId}` | String | Counter | TTL = rate window. Phase 6: `chat` (10 per 10 s), `knock` (5 per minute), `join` (30 per 10 s) and `knock-cancel` (10 per minute); one `MULTI` of `SET key 0 PX window NX` and `INCR`, so it works on Redis 6 and later |
| `ff:chat:dedupe:{userId}:{roomId}:{clientMessageId}` | String | `SET NX` marker holding `{messageId}:{sentAtMs}`, so a repeat can be answered with the original ids (M8) | TTL 60 s |

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

**Hardened in Phase 4A:** the presence sets above are synchronised with each instance's live sockets on every heartbeat (H1); no new keys. **Implemented in Phase 3:** `ff:epoch`, `ff:instances`, `ff:instance:{instanceId}:sockets`, `ff:user:{userId}:sockets`, `ff:auth:revoked:{sid}` (Phase 1), and the `maintenance` queue with its reconcile scheduler. The other keys and queues arrive with their phases.

## Restart semantics

**Redis restarts with data (the normal case).** The epoch value is unchanged. Overdue phase-end and session-end jobs run on startup; the reconciler reschedules anything missing. Up to about one second of changes may be lost; version checks and the reconciler absorb it (for example, a lost pause leaves the timer running and the host can pause again; a lost opt-in entry becomes an orphan and is abandoned as `timer_lost`).

**Redis lost its data.** Detected when an API instance reconnects and `ff:epoch` is missing. The instance that succeeds in setting a new epoch runs **global recovery** — on at most one instance per epoch, not guaranteed (the winner can crash first), so its handlers are idempotent and everything they do is also covered by the reconciler; every instance runs **local recovery**, which is idempotent.

| Lost | Handling |
|---|---|
| Room timers, runs, participants | Global: every in-progress **room** focus session → `abandoned(timer_lost)`. Rooms restart as idle focus with saved durations. |
| Presence | Local: rebuilt from each instance's connected sockets |
| Clients' view | Local: `room:resync` to every served room; clients rejoin for a fresh snapshot; affected users receive `focus:session:updated` |
| Solo sessions | Unaffected (PostgreSQL). The reconciler recreates their jobs. A running session whose user is not connected → `abandoned(expired)` only if the new epoch was created more than 2 s after its `running_since` (definite loss, E9); otherwise late grace (H3) |
| Knocks | Expire client-side; the requester can knock again |
| Queued jobs | Recreated by the reconciler from PostgreSQL (solo) or not needed (room timers restarted) |
| Rate limits, chat de-duplication | Harmless to lose |
| Revoked-session list | Harmless to lose: the marker is only a positive shortcut, and without it the revocation check asks PostgreSQL (R3, revised), so a revoked session never becomes trusted |
