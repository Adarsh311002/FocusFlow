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
| **Redis data loss** | Detected via `ff:epoch` at startup, on every heartbeat and on every reconnect. Room sessions in progress → `timer_lost`; rooms restart idle with saved durations; presence rebuilt from each instance's sockets; the reconcile schedule re-registered (by the epoch's local recovery, and by each worker process's own trigger, which also runs the reconciler directly until scheduled runs finish again, E23); clients get `room:resync`. Solo sessions survive; a running solo session of a disconnected user → `expired` only if the new epoch was created more than 2 s after its `running_since` (definite loss, E9), otherwise late grace. Every decision reads the epoch together with presence, never a cached value (E17); for `INSTANCE_TTL_MS` after the new epoch, while the instances re-add their sockets, presence-dependent decisions wait (jobs retry, pause/stop at the planned end and start/resume answer `503`), and only an observed disconnect through the end can complete a session (E18, E21). Revocation is unaffected: without a marker the check always asks PostgreSQL (R3, revised). See `redis-keys.md`. |
| **PostgreSQL unavailable** | REST returns `503`. Timer commands still work (Redis). Run settlement waits in the ledger and completes when PostgreSQL returns. |
| **Duplicate REST requests** | Complete/reopen/stop/pause/resume/opt-out/membership are idempotent. The one-in-progress-session constraint turns a duplicate start or opt-in into `409` with the existing session. Duplicate task or room creation is low harm (`Idempotency-Key` later). |
| **Duplicate socket events** | `pause`/`resume` no-ops; `reset`/`setPhase` need `expectedVersion`; chat de-duplicated by `clientMessageId`; presence counted per socket; repeated knocks refresh one entry. |
| **Out-of-order socket events** | Timer state carries `version`; clients drop older state. |
| **Client reconnect** | New handshake with a fresh token; `room:join` returns a full snapshot. Within 60 s, running sessions (solo and room) continue. |
| **Host disconnect** | Timer unaffected (D10). Phases still end via jobs. Knocks return `HOST_OFFLINE` (D20 default). |
| **Participant disconnect (room)** | 60 s grace (D19), whether the room timer runs or is paused. Afterwards `grace_expired`. |
| **Solo user disconnect** | Running: the disconnect marker records the latest disconnect for the session (E10) and a 60 s grace starts; at expiry the job settles `grace_expired` only if its timestamp still matches the marker and presence is still offline when re-checked (H2). An **observed** disconnect at or after the planned end (within the 2 s tolerance) completes the session (E8); a late grace job that finds the user back online clears the marker and continues or completes (E16). Paused: nothing happens; stale cleanup marks `expired` 12 h after `started_at` (D14/15/35, E2). |
| **Solo job or request at the planned end** | The decision for a running session always runs first (E7): a pause or stop at or after `T_end` completes the session when presence evidence allows, and expires it after a definite Redis loss during the stretch, exactly as the end job would; when it cannot decide, the request answers `503` unchanged. Jobs that fire early are re-enqueued; duplicate jobs are no-ops (deterministic IDs and row locks). |
| **Redis unreachable during a socket connect or disconnect** | The presence write fails and is logged. The instance's next sync (every heartbeat, and at once after the reconnect) adds the missing entry or removes the stale one and reports the user as `missed_disconnect` at the detection time (H1, H2). A running solo session whose disconnect was missed entirely gets late grace (H3), not `expired`. |
| **Retained or exhausted jobs** | A job BullMQ still retains as completed or failed cannot be added again under its id. Scheduling ensures the job instead: it re-runs a retained one with its attempts reset, so a grace job that exhausted its retries during an outage still decides once presence is back (E20). |
| **Outdated timer or grace jobs** | Job IDs include the version, `running_since` or `disconnectedAtMs` they apply to; a mismatch makes the job a no-op. |
| **Worker failure** | BullMQ retries stalled jobs. All handlers are idempotent. If the worker is down for a long time, clients show "finishing…" at 0:00, and the reconciler catches up on restart. Recorded focused time is computed from the plan and the stored timestamps, not from when the job ran. Scheduled jobs that exhausted their attempts run again when re-ensured (E20). If scheduled reconcile runs stop altogether (the schedule lost, the maintenance workers stuck), each worker process notices within 3 × `RECONCILER_INTERVAL_MS` and runs the reconciler itself, re-registering the schedule (E23). |
| **API instance crash or deploy** | Its sockets' presence entries stop counting as soon as its heartbeat is older than the TTL, and the reconciler removes them through the reverse index; affected users are treated as disconnected at the last heartbeat and get the normal 60 s grace. A clean shutdown removes its own entries at once. An instance wrongly declared dead re-adds its sockets on its next sync and itself on its next heartbeat; a failed re-add is retried by later heartbeats. Clients that reconnect in time lose nothing. |
| **Redis unavailable for a long time** | Nothing that needs presence, the marker or the epoch is decided: jobs retry, the reconciler defers, pause/stop at the planned end and start/resume answer `503` (H2, E18, E21). The 12-hour stale cleanup still runs from each worker process's trigger, because it needs only PostgreSQL: a session still in progress at the threshold is `abandoned(expired)` and committed; its change notification and marker clear fail and are logged, not reported as delivered (E19, E22). |
| **Redis unreachable during shutdown** | Every shutdown step has a share of the budget; the worker closes forcibly and unreachable connections are dropped instead of waiting on QUIT, so shutdown always completes. |
| **Partial write: opt-in** | Crash after the PostgreSQL insert → a retry repairs it; otherwise the reconciler abandons the orphan (`timer_lost`). Run changed meanwhile → the new row is deleted and `409 RUN_CHANGED`. |
| **Partial write: run closure** | The closed run stays in the unsettled set; the reconciler settles it. |
| **Partial write: opt-out / leave / removal** | PostgreSQL already has the final state; the leftover ledger entry is ignored by settlement. |
| **Partial write: knock approval** | Membership exists but the requester was not notified → their knock times out client-side; they re-check access and find they are a member. |
| **Partial write: member removal** | Membership is gone; if eviction did not happen, the removed user's socket can still see chat until it disconnects. They cannot rejoin a private room. Accepted for the MVP. |
| **Invalid payloads** | Rejected by Zod at every entry point; nothing unvalidated reaches business logic. |
| **Unauthorized room actions** | Identity only from `socket.data`; membership required to join; host checked against PostgreSQL; knock results only to the target user. |
| **Access token expires while connected** | The socket is disconnected; the client reconnects with a fresh token and rejoins. |
| **Refresh token stolen and reused** | Reuse detection revokes the session in PostgreSQL; the revocation check (Redis marker, otherwise PostgreSQL) stops its access tokens immediately and its sockets are disconnected. |
| **Clock skew** | Timer arithmetic uses Redis time; stored timestamps use PostgreSQL time; clients correct their display with a measured offset. |

## When an outbox becomes worth building

Not needed for the MVP. Build a PostgreSQL outbox (or polling dispatcher) when:

1. **AI jobs arrive:** inserting an `ai_jobs` row and enqueueing a job writes to two systems.
2. **Notifications leave the app** (email, push): a lost notification can no longer be recovered by the client re-fetching.
3. **Room timer state ever moves into PostgreSQL** (it does not today; D10/F2).
