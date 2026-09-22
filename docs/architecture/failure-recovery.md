# Failure and Recovery

How Focus Flow v2 behaves when things go wrong. Status: **Architecture**, consistent with the approved decisions.

## Write-ordering rules

- **Durable facts:** PostgreSQL first, then Redis, then socket emits. Notifications about a durable fact are sent only after it is committed.
- **Live state** (timer, presence, knocks): Redis is the owner; broadcast after the Redis update.
- **Operations touching both** are made safe by conditional updates (`WHERE status = 'in_progress'`), guarded Redis scripts, the focus run ledger, and the reconciler.
- Multi-row PostgreSQL changes use one transaction (room + host membership; settlement batches; membership removal + abandonment; task soft delete + clearing the current task).

## Failure modes

| Failure | Behaviour |
|---|---|
| **Redis restart (data kept)** | Overdue jobs run; the reconciler reschedules missing ones. Up to ~1 s of changes may be lost; version checks absorb it. |
| **Redis data loss** | Detected via `ff:epoch`. Room sessions in progress → `timer_lost`; rooms restart idle with saved durations; presence rebuilt; clients get `room:resync`. Solo sessions survive; running solo sessions of disconnected users → `expired`. See `redis-keys.md`. |
| **PostgreSQL unavailable** | REST returns `503`. Timer commands still work (Redis). Run settlement waits in the ledger and completes when PostgreSQL returns. |
| **Duplicate REST requests** | Complete/reopen/stop/pause/resume/opt-out/membership are idempotent. The one-in-progress-session constraint turns a duplicate start or opt-in into `409` with the existing session. Duplicate task or room creation is low harm (`Idempotency-Key` later). |
| **Duplicate socket events** | `pause`/`resume` no-ops; `reset`/`setPhase` need `expectedVersion`; chat de-duplicated by `clientMessageId`; presence counted per socket; repeated knocks refresh one entry. |
| **Out-of-order socket events** | Timer state carries `version`; clients drop older state. |
| **Client reconnect** | New handshake with a fresh token; `room:join` returns a full snapshot. Within 60 s, running sessions (solo and room) continue. |
| **Host disconnect** | Timer unaffected (D10). Phases still end via jobs. Knocks return `HOST_OFFLINE` (D20 default). |
| **Participant disconnect (room)** | 60 s grace (D19), whether the room timer runs or is paused. Afterwards `grace_expired`. |
| **Solo user disconnect** | Running: 60 s grace, then `grace_expired`. Paused: nothing happens; stale cleanup later marks `expired` (D14/15/35). |
| **Outdated timer or grace jobs** | Job IDs include the version, `running_since` or `disconnectedAtMs` they apply to; a mismatch makes the job a no-op. |
| **Worker failure** | BullMQ retries stalled jobs. All handlers are idempotent. If the worker is down for a long time, clients show "finishing…" at 0:00, and the reconciler catches up on restart. Recorded focused time is computed from the plan and the stored timestamps, not from when the job ran. |
| **API instance crash or deploy** | Its sockets' presence entries are removed through the missing heartbeat; affected users are treated as disconnected at the last heartbeat and get the normal 60 s grace. Clients that reconnect in time lose nothing. |
| **Partial write: opt-in** | Crash after the PostgreSQL insert → a retry repairs it; otherwise the reconciler abandons the orphan (`timer_lost`). Run changed meanwhile → the new row is deleted and `409 RUN_CHANGED`. |
| **Partial write: run closure** | The closed run stays in the unsettled set; the reconciler settles it. |
| **Partial write: opt-out / leave / removal** | PostgreSQL already has the final state; the leftover ledger entry is ignored by settlement. |
| **Partial write: knock approval** | Membership exists but the requester was not notified → their knock times out client-side; they re-check access and find they are a member. |
| **Partial write: member removal** | Membership is gone; if eviction did not happen, the removed user's socket can still see chat until it disconnects. They cannot rejoin a private room. Accepted for the MVP. |
| **Invalid payloads** | Rejected by Zod at every entry point; nothing unvalidated reaches business logic. |
| **Unauthorized room actions** | Identity only from `socket.data`; membership required to join; host checked against PostgreSQL; knock results only to the target user. |
| **Access token expires while connected** | The socket is disconnected; the client reconnects with a fresh token and rejoins. |
| **Refresh token stolen and reused** | Reuse detection revokes the session; revoked-session list stops its access tokens and sockets immediately. |
| **Clock skew** | Timer arithmetic uses Redis time; stored timestamps use PostgreSQL time; clients correct their display with a measured offset. |

## When an outbox becomes worth building

Not needed for the MVP. Build a PostgreSQL outbox (or polling dispatcher) when:

1. **AI jobs arrive:** inserting an `ai_jobs` row and enqueueing a job writes to two systems.
2. **Notifications leave the app** (email, push): a lost notification can no longer be recovered by the client re-fetching.
3. **Room timer state ever moves into PostgreSQL** (it does not today; D10/F2).
