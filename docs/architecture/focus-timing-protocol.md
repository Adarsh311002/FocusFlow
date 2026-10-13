# Focus Timing Protocol

How the server decides when focus starts, pauses, ends, completes or is abandoned, for room sessions and solo sessions.

Approved decisions implemented here: D5, D6, D10, D11, D14/15/35, D16, D17, D19, implementation decisions I7 (worker placement) and I8 (timer implementation), presence hardening H1–H4 and Solo Focus E1–E16. Everything else in this document is **Architecture**.

## Principles

1. The server is authoritative (F6). Clients display countdowns from server timestamps and never decide that a phase or session has ended.
2. Durable facts (focus sessions) are written to PostgreSQL. Live room state (timer, presence, run participants) lives in Redis.
3. "Completed" means the planned time was reached **and** the user was present at the end, with a 60-second reconnect grace for an actively running session (D14/15/35).
4. Every scheduled job and every state change is safe to run twice.

## Clocks

| What | Clock |
|---|---|
| Room timer arithmetic, `serverNowMs` sent with timer state | Redis server time, read with `TIME` immediately before each change is computed (I8) |
| Stored timestamps; solo session arithmetic (`started_at`, `running_since`, `ended_at`, `focused_seconds`, `T_end`) | PostgreSQL `clock_timestamp()`, sampled after the session row lock is held (E9) |
| Presence and epoch instants (`disconnectedAtMs`, `checkedAtMs`, the epoch's creation time) | Redis `TIME` (R2, H2, E9) |
| API server clocks | Never used for these |

All hosts run NTP. Room session `ended_at` values come from the focus run's close time. Solo timestamps are written at millisecond precision (`date_trunc('milliseconds', clock_timestamp())`), so a value read back into JavaScript compares exactly. The clock is `clock_timestamp()`, not `now()`: `now()` is fixed when the transaction begins, so a request that begins a transaction, waits on `SELECT … FOR UPDATE`, and then acquires the lock after another transaction changed `running_since` would compute with an instant earlier than that `running_since` (and fail with a clock error). Sampled after the lock is held, `clock_timestamp()` is still the PostgreSQL clock (E9) and is never earlier than anything committed before it.

### Comparing the two clocks (E9)

A Redis instant is only ever compared with a PostgreSQL instant through a fixed tolerance, `CLOCK_SKEW_TOLERANCE_MS = 2000`, and every ambiguous comparison is biased toward grace rather than expiry:

| Comparison | Rule |
|---|---|
| Was the user present through the planned end? | The marker's evidence is `observed` **and** `disconnectedAtMs + tolerance ≥ T_end` ⇒ through the end. `detected` evidence never proves this (E8, E10) |
| Did Redis lose its data during the running stretch? | `epochCreatedAtMs > runningSinceMs + tolerance` ⇒ definite Redis loss |
| Anything else | Not definite: prefer grace (or "unknown, retry") over `expired` |

When a Redis instant becomes a stored value (the end of a `grace_expired` session), it is clamped into `[running_since, T_end]` first, so stored timestamps stay ordered and `focused_seconds` stays within the plan. Comparisons between two Redis instants (`checkedAtMs` against `disconnectedAtMs`) need no tolerance.

**Client display.** The client estimates its clock offset from `serverNowMs` values (Redis TIME, R2), including a `time:sync` burst on connect and every 5 minutes, trusting the sample with the shortest round trip: `offset ≈ serverNowMs − (t0 + t1) / 2`. It shows `max(0, endsAtMs − (Date.now() + offset))`. At 0:00, before new state arrives, it shows "finishing…". It never advances a phase or ends a session by itself, and it ignores timer state with a lower `version` than it already has.

## Presence

Presence is tracked at two levels, both in Redis and both keyed by `{instanceId}:{socketId}` entries so multiple tabs and API instances are handled correctly.

| Level | Meaning | Used for |
|---|---|---|
| User | The user has at least one connected, authenticated socket anywhere | Solo session presence (D14/15/35); `NOT_CONNECTED` checks |
| Room | The user has at least one socket joined to the room | Room presence list; room participant grace (D19) |

- A user is **disconnected** at a level when their last socket at that level goes away. The 60-second grace counts from when the server **detects** this; Socket.IO ping settings are tightened so silent drops are detected quickly.
- Closing a tab is detected immediately. On mobile, a locked screen usually drops the socket (accepted consequence of D14/15/35).
- `room:leave` is sent only for an explicit "Leave room" action. Navigating elsewhere in the app does not leave the room.
- If an API instance dies, its sockets never run their disconnect handlers. Its entries stop counting as soon as its heartbeat (the `ff:instances` score, Redis TIME) is older than the TTL, and the reconciler removes them through the `ff:instance:{instanceId}:sockets` index and treats affected users as disconnected at the instance's last heartbeat. A normal deploy, where clients reconnect within 60 seconds, therefore does not abandon anyone's focus.
- **Implemented in Phase 3** (user level): per-socket entries, read-time liveness filtering, the "user went offline" hook, and reconciler step 1. **Hardened in Phase 4A** (H1–H4): the two-way sync, `disconnectedAtMs`, the online hook and offline-as-hint semantics below. Room-level presence arrives with rooms.

### Synchronisation (H1)

Every presence write is best effort: when Redis is unreachable, a socket's add or removal simply fails. Each API instance therefore **synchronises** its own entries with its live sockets, in both directions:

- It reads its reverse index, then — in the same synchronous step, with nothing awaited in between — reads Socket.IO's live socket map and queues one transaction that adds the missing entries and removes the stale ones from **both** sets.
- Socket.IO removes a socket from that map in the same synchronous step that emits `disconnect`, and every presence write goes through one Redis connection in order. A socket that disconnects during a sync is therefore never re-added: either its removal is already applied and it is absent from the map, or its removal is queued after the sync's write.
- The sync runs **after every heartbeat** (so any missed write is repaired within one interval) and immediately after a Redis reconnect, an epoch change (data loss) or a rejoin. It is single-flight: a request while a sync runs is served by one more sync after it. A failed sync is retried by the next heartbeat; a failed rejoin stays pending until a later heartbeat completes it.
- The sync compares against the reverse index. The two sets are only ever changed together in one transaction, so they cannot drift apart except through writes outside the application.

### Offline and online hints (H2, H4)

When a user's last live socket goes away, presence emits an **offline event** `{ userId, reason, disconnectedAtMs }`:

| `reason` | When | `disconnectedAtMs` (Redis TIME) |
|---|---|---|
| `disconnect` | A socket's own disconnect handler removed the user's last entry | Of the removal, read in the same transaction |
| `missed_disconnect` | A sync removed a stale entry whose disconnect was never recorded | Of the detecting sync (the real moment is unknown and earlier) |
| `instance_dead` | The reconciler removed a dead instance's entries | The instance's last heartbeat score |
| `instance_shutdown` | A clean shutdown removed this instance's remaining entries (sockets whose own removal had not happened) | Of the cleanup read (Phase 4B, E10; Phase 4A reported these as `disconnect`) |

Whether a removal left the user offline is judged in the same transaction as the removal. Only the path that actually removed an entry reports it, so a disconnect and a sync never both report the same socket. Dead-instance cleanup reports **before** it removes the entries: a run that dies in between is repeated by the next run, which reports again with the same last-heartbeat time.

An **online event** `userId` is emitted when a socket of the user is newly recorded (connect, or a sync re-adding it). Solo Focus uses it to clear the disconnect marker early, after confirming presence with `checkUser` (see "Disconnect marker").

**Both are hints, never decisions.** An offline event can be missed (a crash, a failing handler), repeated (always with the same `(userId, disconnectedAtMs)`, so consumers collapse repeats by that key: the monotonic marker update ignores an older or equal timestamp, E10), or stale (the user may already be connected through another instance, for example during a rolling deploy). No Solo Focus outcome is decided from an event alone: every decision (grace expiry, the end job, the reconciler) first re-checks **`checkUser`**, which reads the user's entries, the heartbeats and Redis TIME in one transaction and returns `{ online, checkedAtMs }`. If that check fails, the decision is retried, never taken on an unknown state. The reconciler's sweep of running solo sessions (steps 4–6) is the durable backstop for every lost hint.

## Room timer

### State (Redis)

| Field | Meaning |
|---|---|
| `phase` | `focus` \| `short_break` \| `long_break` |
| `status` | `idle` \| `running` \| `paused` |
| `durationMs` | Length of the current phase, fixed when the phase was created |
| `segmentStartedAtMs` | When the current running stretch began (running only) |
| `elapsedBeforeMs` | Time elapsed before the current stretch |
| `version` | Incremented on every accepted change |
| `focusRunId` | The current focus run (focus phase only) |

Derived: `elapsed = elapsedBeforeMs + (running ? now − segmentStartedAtMs : 0)`; while running, `endsAtMs = segmentStartedAtMs + durationMs − elapsedBeforeMs`.

If a room has no timer key, it is `idle` in a new `focus` phase using the room's saved durations.

### How a change is applied (Approved, I8)

Every timer change (host command, phase end, run closure) follows the same steps:

1. Read the current timer state (with its `version`) and the current time from Redis `TIME`.
2. Compute the result with a **pure TypeScript function** `(state, command, nowMs) → newState | rejection`. All timer rules live in this function; it has no I/O and is fully unit- and property-testable with any clock.
3. Write the result with a small **version-checked atomic Redis operation**: it succeeds only if the stored `version` is still the one read in step 1. Related keys that must change together (the run ledger, the unsettled-runs set, the running-timers index) are written in the same atomic operation.
4. On a version conflict, re-read and retry a bounded number of times; if it still conflicts, reject with `VERSION_CONFLICT` and the current state.

Lua is used only for the atomic compare-version-and-write in step 3. It contains no timer rules. Property tests cover the pure function (remaining time never negative, version only increases, no illegal transitions, elapsed never exceeds duration) and interleavings of concurrent commands.

### Phase durations (D16)

- Saved in PostgreSQL on the room. Redis holds a live copy of the settings.
- A phase's `durationMs` is read from the settings **when the phase is created**: on `reset`, on `setPhase`, and on the automatic transition when a phase reaches zero. Changing settings never alters the current phase.
- The host changes settings over REST; the server updates PostgreSQL, then the Redis copy, then broadcasts `room:settings:updated` with `effectiveFrom: "next_phase"`. The client may offer "apply now", which is a `reset` (and under D17 abandons opted-in sessions).

### Commands

The host sends `room:timer:command`. Each command is applied as described above (pure function, then version-checked write, which bumps `version`), then the server broadcasts `room:timer:state`.

| Command | Allowed from | Effect |
|---|---|---|
| `start` | `idle` | `running`; `segmentStartedAtMs = now`; schedule the phase-end job |
| `pause` | `running` | `elapsedBeforeMs += now − segmentStartedAtMs`; `paused` |
| `resume` | `paused` | `running`; `segmentStartedAtMs = now`; schedule a new phase-end job |
| `reset` (`expectedVersion`) | `running`, `paused` | `idle`, same phase, new duration from settings. In focus: close the run with reason `reset`, open a new run (D17) |
| `setPhase` (`phase`, `expectedVersion`) | any, phase must differ | `idle` in the new phase, duration from settings. Leaving focus: close the run with reason `phase_changed` (D17). Entering focus: open a new run |

- `pause` and `resume` repeated are no-ops that return the current state. `reset` and `setPhase` require `expectedVersion`; a mismatch returns `VERSION_CONFLICT` with the current state, so duplicates cannot apply twice.
- Cancelling an outdated phase-end job is best-effort; the version check makes a leftover job harmless.
- **Host disconnects:** nothing happens (D10). A running timer keeps running; a paused timer stays paused. Timer commands are unavailable until the host returns.
- The next phase is never started automatically (open D32).

### Reaching zero

A BullMQ delayed job fires at `endsAtMs`, with a job ID derived from room and version (job IDs avoid `:`, which BullMQ reserves).

1. Read the state and Redis `TIME`. If the version differs from the job's version or the status is not `running`, do nothing. If the job fired early, reschedule it.
2. The pure function computes the transition: if the phase was focus, the run is closed with reason `completed`; the next phase (`focus → short_break`, any break `→ focus`) is created as `idle` with its duration read from settings; entering focus opens a new run.
3. The result (timer, closed run, unsettled-runs entry, new run) is written in one version-checked atomic operation. On a conflict, the job re-reads and re-evaluates from step 1.
4. The server broadcasts the new timer state, then settles the closed run (below).

## Focus runs (room sessions)

A focus run is one instance of a focus phase. Its Redis ledger holds the run's status and its participants: `{ sessionId, optedInAtMs, elapsedAtOptInMs, disconnectedAtMs?, elapsedAtDisconnectMs? }`.

### Opting in (D11)

`POST /rooms/:roomId/focus-participation` (REST, because it creates a durable row).

1. Check: the user is a member, is present in the room, has no in-progress session, the phase is `focus` (open D31), and the optional task is theirs and not deleted.
2. Generate `sessionId`. Insert the focus session in PostgreSQL: `in_progress`, `room_id`, `focus_run_id`, `planned_seconds = round((durationMs − elapsed) / 1000)`.
3. Small atomic Redis operation: add the participant to the run **only if** the room's current run is still that `focusRunId` and the phase is still focus.
4. If that operation fails because the run changed, delete the just-inserted row and return `409 RUN_CHANGED`.
5. Broadcast `room:focus:participants`.

A retry after a crash between steps 2 and 3 finds the existing in-progress session and repairs it by adding the missing participant. A request that is never retried leaves an orphan, which the reconciler abandons.

Opting in while the timer is idle or paused is allowed; the elapsed time at that moment is used. Pauses need no per-person accounting, because the room timer's elapsed time already excludes paused time.

### Disconnect and reconnect (D19)

- When a participant's last socket in the room drops, an atomic write records `disconnectedAtMs` and `elapsedAtDisconnectMs` (computed from the timer state and Redis `TIME`), and a grace job is scheduled for 60 seconds later. This applies whether the room timer is running or paused.
- Reconnecting (`room:join`) within the grace period clears the disconnect fields; the grace job then does nothing because `disconnectedAtMs` no longer matches.
- If the grace job fires and the participant is still disconnected with the same `disconnectedAtMs`, the session is abandoned with `grace_expired`.

### Leaving, opting out, removal

| Action | Order | Reason |
|---|---|---|
| Opt out (`DELETE /rooms/:roomId/focus-participation`) | PostgreSQL abandon → remove from ledger → broadcast | `opted_out` |
| Intentional leave (`room:leave`, or `DELETE .../membership`) | same | `left_room` |
| Removed by host | PostgreSQL: delete membership and abandon, one transaction → remove from ledger and presence → force the user's sockets out of the room → broadcast | `removed` |

If the process crashes after the PostgreSQL write, the leftover ledger entry is harmless: settlement only updates rows that are still `in_progress`.

### Settlement

When a run closes (`reset`, `phase_changed`, or `completed`), its ID is added to the unsettled set. Settlement then updates PostgreSQL in one transaction, only touching rows where `status = 'in_progress'`:

| Close reason | Participant state | Outcome |
|---|---|---|
| `reset` / `phase_changed` | any | `abandoned` with that reason (D17) |
| `completed` | connected | `completed` |
| `completed` | disconnected, grace not yet expired | Waits. Reconnect within grace → `completed`. Grace expires → `abandoned(grace_expired)` (D14/15/35) |

After settlement, notifications (`focus:session:updated`) go to each affected user's channel. A run leaves the unsettled set once every participant is settled. If the process crashes midway, the reconciler settles the run again; this is safe because of the `in_progress` condition.

### Recorded values for room sessions

| Outcome | `focused_seconds` | `ended_at` |
|---|---|---|
| `completed` | `planned_seconds` | Run close time |
| `reset` / `phase_changed`, connected | `(elapsedAtCloseMs − elapsedAtOptInMs) / 1000` | Run close time |
| `reset` / `phase_changed`, disconnected | `(elapsedAtDisconnectMs − elapsedAtOptInMs) / 1000` | Run close time |
| `opted_out` / `left_room` / `removed` | `(elapsedNow − elapsedAtOptInMs) / 1000` | Now |
| `grace_expired` | `(elapsedAtDisconnectMs − elapsedAtOptInMs) / 1000` | Disconnect time |
| `timer_lost` | 0 (open D37) | Recovery time |

Values are rounded to whole seconds and never negative.

## Solo sessions

Solo session state lives entirely in PostgreSQL (D6): `planned_seconds` (P), `focused_seconds` (F), `running_since` (R, NULL while paused), `started_at`, `ended_at`. Redis holds only user-level presence, the disconnect marker and scheduled jobs. Phase 4B decisions: E1–E16 (`decisions/decision-log.md`).

### Timing formulas

All values come from the PostgreSQL clock, `date_trunc('milliseconds', clock_timestamp())` sampled after the session row lock is held (E9). Partial seconds are always **rounded down** at a pause, stop or settlement (E14), so focused time is never over-counted; a session paused and resumed many times may be under-counted by up to one second per pause.

| Quantity | Formula |
|---|---|
| Accumulated focus | `acc(now) = min(P, F + (R ? now − R : 0))` |
| Planned end (running only) | `T_end = R + (P − F)` |
| Pause | `F := min(P, F + ⌊now − R⌋)`, `R := NULL` |
| Resume | `R := now` (new `T_end = now + (P − F)`) |
| Completion | `status := completed`, `F := P`, `ended_at := T_end`, `R := NULL` |
| Early stop | `F := min(P, F + (R ? ⌊now − R⌋ : 0))`, `ended_at := now`, `abandoned(stopped)` |
| Grace expired | `d := clamp(disconnectedAt, R, T_end)`; `F := F + ⌊d − R⌋`, `ended_at := d`, `abandoned(grace_expired)` |
| Expired (stale or definite Redis loss) | `F` unchanged (the current running stretch is discarded), `ended_at := now`, `R := NULL`, `abandoned(expired)` |

### Start, pause, resume, stop

Every action runs in one PostgreSQL transaction that locks the session row (`SELECT … FOR UPDATE`); Redis writes, job enqueues and the `focus:session:updated` event follow the commit (persist, then emit).

| Action | Rule | Effect |
|---|---|---|
| Start (`POST /focus-sessions`) | `plannedSeconds` is an integer 60–14,400 (E1). User connected (`checkUser`, else `409 NOT_CONNECTED`; `503` while presence is untrusted, E21). No in-progress session (the partial unique index; else `409 SESSION_IN_PROGRESS` with the existing session). Optional `taskId`: the user's own, not deleted, and open, locked `FOR SHARE` (E3; else `404 TASK_NOT_FOUND` / `409 TASK_NOT_OPEN`). The server never fills in `users.current_task_id`. | Insert `in_progress`, `R = started_at =` the PostgreSQL clock, `F = 0`; enqueue the end job |
| Pause | Running and `now < T_end` | Pause formula; clear this session's marker (only if it still belongs to this session, E10). At or after `T_end` the completion decision runs first (E7); if it does not complete the session, the pause applies with `F` capped at `P`. |
| Resume | Paused; user connected (else `409 NOT_CONNECTED`; `503` while presence is untrusted, E21) | `R :=` the PostgreSQL clock; clear this session's marker if still present; enqueue the end job |
| Stop | In progress | At or after `T_end` the completion decision runs first (E7). Otherwise early stop; clear this session's marker (only if it still belongs to this session). |

Repeats are harmless: pause on a paused session, resume on a running one, and pause, resume or stop on an ended session all answer `200` with the session unchanged (E11). There is no "complete" endpoint: completion is decided by the server.

### Disconnect marker (E10)

One key per user, `ff:user:{userId}:disconnected`, value **`{sessionId}:{latestDisconnectedAtMs}:{evidence}`** (Redis TIME), with a safety TTL longer than the 12-hour stale window. It records when the user's last socket went away during the current running stretch of session `sessionId`, and how that time is known:

| Source | `evidence` | What the timestamp means |
|---|---|---|
| A direct socket disconnect (offline event `disconnect` from the socket's own disconnect handler) | `observed` | The user was connected until exactly this instant |
| `missed_disconnect` (a sync found the entry stale) | `detected` | The disconnect happened at some unknown earlier time |
| `instance_dead` (the instance's last heartbeat) | `detected` | The instance was alive then; the socket's own disconnect time is unknown |
| `instance_shutdown` (a clean shutdown's cleanup) | `detected` | The time of the cleanup, not of the socket's own disconnect |
| Late grace (the reconciler or a decision found the user offline with no marker) | `detected` | The time the absence was noticed |

Only `observed` evidence can prove that the user was present through the planned end (E8). `detected` evidence can start or extend a grace, but never proves presence through `T_end` by itself. A newer `detected` disconnect may replace an older `observed` one for the same session (the timestamp is monotonic); that can lose a completion proof and send the session through grace instead — an accepted limitation, because it can never produce a false completion.

The marker is changed only with `WATCH`/`MULTI` and a bounded number of retries (no Lua). If the retries run out, the caller fails and is retried (a job, or the reconciler's next run).

- **Record** a disconnect `(t, evidence)` for session `S` — only after PostgreSQL confirmed that `S` is the user's running solo session, and only if `t` belongs to the current running stretch (`t + tolerance ≥ runningSinceMs`; an event from before a resume is ignored):
  - no marker → set `S:t:evidence`;
  - marker for `S` with an older timestamp → replace it with `S:t:evidence` (the newer event wins, with its own evidence);
  - marker for `S` with the same timestamp → upgrade `detected` to `observed` if the new event is observed; otherwise no change (`observed` is never downgraded to `detected`);
  - marker for `S` with a newer timestamp → no change;
  - marker for another session → that session can no longer be in progress (one in-progress session per user), so replace it with `S:t:evidence`.
  Each recorded timestamp gets its own grace job.
- **Clear on reconnect** for session `S` at `u` (a Redis instant at which `checkUser` confirmed the user online), only **before `T_end`**: delete the marker only if it still belongs to `S`, its timestamp `t` is `≤ u`, and `u` is still inside that disconnect's grace (`u < t + 60 s`). A marker for `S` newer than `u` (a later disconnect) stays; a marker whose grace ran out stays for its grace job (E16); a marker of another session is left alone. At or after `T_end` an online hint never clears the marker (E8). A decision that finds the user online clears it up to `checkedAtMs` only where the decision table says so.
- **Clear on pause, resume, stop or settlement** of session `S`: delete the marker **only if it still belongs to `S`**. Never unconditionally: a delayed cleanup of an ended session must not remove the marker of the user's next session (for example, `S1` settles, `S2` starts, `S2`'s user disconnects and owns the marker, then `S1`'s late cleanup runs — it must leave `S2`'s marker in place).
- A marker for the running session whose timestamp is from before its current stretch (`t + tolerance < runningSinceMs`, left over from before a pause) is treated as absent and cleared for that session.
- A **grace job** settles only if the marker still holds exactly its payload's session and `disconnectedAtMs`; an older job finds a newer timestamp and does nothing (the newer job owns the grace).

### Disconnect while running

- **Offline hint** (H2): if PostgreSQL shows a running solo session for the user, and `checkUser` still reports the user offline, record the disconnect with the event's `disconnectedAtMs` and its evidence, and enqueue a grace job for `disconnectedAtMs + 60 s`. A paused session gets no marker and no grace (D14/15/35).
- **Online hint** (H4): confirm with `checkUser`; if online and the session is running:
  - before `T_end`: clear the marker on reconnect (above, only inside its grace); if it stays (its grace ran out), make sure its grace job is enqueued — that grace job decides (E16);
  - at or after `T_end`: never clear the marker — being online now proves nothing about `T_end` (E8). Make sure the grace job of a recorded disconnect of the current stretch is enqueued, and enqueue an immediate end-decision job: without a recorded disconnect it can complete the session now (D35); with one, it hands over to that grace job.
  The hint itself never completes anything (E8).
- The 60-second grace is compared on Redis instants only: it has expired when `checkedAtMs ≥ disconnectedAtMs + 60 s`.

### The decision for a running session

One procedure decides every running solo session, whether called by the end job, a grace job, the reconciler sweep, or a pause or stop at or after `T_end`. It reads, in this order: the session row (locked), the PostgreSQL clock (`clock_timestamp()`, after the lock) and `T_end`, then one atomic Redis read, the **decision snapshot**: `online`, `checkedAtMs`, the current epoch's creation time and the marker, at one Redis instant (E17; never a cached epoch; a marker from before the current stretch is ignored). If the snapshot fails, the marker alone is read, so an observed disconnect through the end can still decide; if that read fails too, nothing is decided. An observed disconnect through the end completes first and needs neither presence nor the epoch (E8). A disconnect whose marker is not yet written at the snapshot's instant is not evidence for this decision: the socket entry is removed (the disconnect instant) a few round trips before the offline handler records the marker, and a snapshot in between sees the user offline with no marker — `abandoned(expired)` after a definite loss, otherwise late grace, whose newer `detected` marker keeps out the older `observed` one (E10). It never produces a completion without recorded evidence. Otherwise presence must be **trusted** (E18): if `checkUser` fails, the epoch is unknown, or the check falls inside the epoch's **presence-recovery window** `[epochCreatedAtMs, epochCreatedAtMs + INSTANCE_TTL_MS)` (Redis TIME), it decides nothing: a job is retried, the reconciler defers and a pause or stop answers `503` without changing the session (H2). The window only delays: after it, the tables below apply unchanged — a definite Redis loss without E8 proof is still `abandoned(expired)`, online or not. A pause or stop at or after `T_end` takes the terminal outcomes `completed`, `abandoned(grace_expired)` (offline, the current disconnect's grace over) and `abandoned(expired)` exactly as a job would (E7), so the result never depends on which of them takes the row lock first; any other outcome lets the pause or stop apply. "Through the end" (observed evidence only) and "definite Redis loss" use the clock-comparison rules above. Only the **grace job** of exactly the recorded disconnect may apply reconnect-within-grace recovery (E16); the end job, the reconciler and a pause or stop never do.

| Before `T_end` | Outcome |
|---|---|
| Online, no marker | Keep running (the end job stays scheduled) |
| Online, marker for this session, inside its grace (`checkedAtMs < disconnectedAtMs + 60 s`) | A reconnect within grace: clear the marker up to `checkedAtMs`; keep running |
| Online, marker for this session, grace expired — the grace job of exactly this disconnect | **E16** (below): clear the marker up to `checkedAtMs`; keep running |
| Online, marker for this session, grace expired — any other caller | Wait: the grace job of that disconnect decides (scheduled if missing) |
| Offline, marker for this session, grace not yet expired | Wait (the grace job is scheduled) |
| Offline, marker for this session, grace expired | `abandoned(grace_expired)` |
| Offline, no marker, definite Redis loss during the stretch | `abandoned(expired)` |
| Offline, no marker, otherwise | **Late grace** (H3): record a `detected` disconnect at `checkedAtMs` and schedule its grace |

| At or after `T_end` | Outcome |
|---|---|
| Marker for this session, `observed`, through the end | `completed`, `ended_at = T_end` (E8) |
| Online, no marker, no definite Redis loss during the stretch | `completed`, `ended_at = T_end` (present at completion, D35) |
| Online, no marker, definite Redis loss during the stretch | `abandoned(expired)`: the missing marker proves nothing (E9) — also for a pause or stop (E7) |
| Online, marker for this session (not observed-through-the-end) — the grace job of exactly this disconnect | **E16** (below): `completed`, `ended_at = T_end` — or `abandoned(expired)` on a definite Redis loss during the stretch |
| Online, marker for this session (not observed-through-the-end) — the end job or the reconciler | Wait: that disconnect's grace job decides (scheduled if missing; it runs at once if the grace has expired) |
| Online, marker for this session (not observed-through-the-end) — a pause or stop | Not a completion: the pause or stop applies (E7) |
| Offline, marker for this session, grace not yet expired | Wait |
| Offline, marker for this session, grace expired | `abandoned(grace_expired)` (`d` is clamped to `T_end`) |
| Offline, no marker, definite Redis loss during the stretch | `abandoned(expired)` — also for a pause or stop (E7) |
| Offline, no marker, otherwise | Late grace: record a `detected` disconnect at `checkedAtMs`. Detected evidence never proves "through the end", so this can only end in a reconnect seen by its grace job (E16) or `grace_expired` |

**Reconnect-within-grace recovery (E16, a narrow D35/H2 exception).** It applies only in the **grace job** whose marker still holds exactly its payload's session and `disconnectedAtMs`, when that job finds the user online — typically a grace job that ran late (a worker outage) after the online hint that would have cleared the marker was lost, so the exact reconnect time is unknowable. That grace job treats it as a reconnect within grace (D35) and as H2's "online after all": it clears the marker and the session continues, or completes at `T_end` if the planned end has passed. The alternative, `grace_expired` whenever `checkedAtMs > disconnectedAtMs + 60 s`, would penalise the user for a server outage. E16 is not evidence about a Redis data loss: on a definite loss during the stretch the session is `abandoned(expired)` instead (E9). Nothing else applies E16: the end job and the reconciler hand a recorded disconnect over to its grace job, a pause or stop is then not a completion, and an online hint at or after `T_end` never clears the marker, so it cannot turn "marker and online" into "no marker and online".

"No marker and online" completes (D35): no disconnect was recorded during the stretch and the user is present; the reconciler's late-grace sweep is what detects an absence that left no marker. It relies on the marker store having kept its data, so after a definite Redis loss during the stretch it does not complete (E9).

Never: completing a session from `detected` evidence alone, or from an online hint alone without this decision (E8); completing because the user is online now while a disconnect of the stretch is recorded, anywhere but in that disconnect's grace job (E8, E16); completing without observed proof after a definite Redis loss during the stretch (E9); expiring a session on an ambiguous clock comparison (E9); deleting a marker that belongs to another session (E10).

### Paused solo sessions

A disconnect does **not** start the grace for a paused solo session (D14/15/35). The session stays paused, `focused_seconds` keeps the accumulated value, and stale cleanup expires it 12 hours after `started_at` (E2).

### `expired`

A solo session is `abandoned(expired)` only when:
- it is still in progress 12 hours after `started_at` (E2; in practice a paused session, since the longest plan is 4 hours and a running session is resolved by the decision procedure); or
- it is running, no observed disconnect proves presence through the end, Redis **definitely** lost its data during the running stretch (`epochCreatedAtMs > runningSinceMs + 2000`, E9), and either the user is offline with no marker, or the planned end has passed and the user is online — with no marker, or in the grace job of the recorded disconnect (E16). A pause or stop at or after `T_end` with no marker in that state expires the session too, exactly as the end job would (E7); before `T_end` a pause or stop applies as usual.

In both cases only the time accumulated before the current running stretch is kept. A merely missed disconnect gets **late grace** instead (H3): the grace runs from the detection time, which can over-count focused time by at most the detection delay (about one reconciler interval) — preferred over discarding the stretch because of an infrastructure fault.

## Scheduled jobs

| Queue | Job | Keyed by | No-op when |
|---|---|---|---|
| `room-timer` | Phase end | room ID + version | Version changed or not running |
| `focus-session` | Room participant grace | room + run + user + `disconnectedAtMs` | Participant reconnected or already settled |
| `focus-session` | Solo end | session ID + `running_since` (ms) | Session paused, resumed again, or ended. Fired early (PostgreSQL `clock_timestamp() < T_end`) → enqueued again for `T_end` |
| `focus-session` | Solo grace | session ID + `disconnectedAtMs` | Session no longer running, or the marker no longer holds exactly this session and `disconnectedAtMs` (E10) |
| `maintenance` | Reconciler (repeating) | — | — |

Scheduling a `focus-session` job **ensures** it (E20): BullMQ keeps finished jobs for a while, and adding a job whose id it still retains is a silent no-op. So an absent job is added, a waiting, delayed or active one is left alone, and one retained as completed or failed is re-run with its attempts reset (`Job.retry` with `resetAttemptsMade` and `resetAttemptsStarted`). Running a finished job again is harmless: it re-checks everything under the row lock.

## Reconciler

Runs at startup, after Redis recovery and on a repeating BullMQ schedule (every 30 seconds, R6), so normally one worker takes each scheduled run. Every step is safe to repeat, and runs may overlap across instances (startup runs, a long run, direct runs): the session steps lock each row `FOR UPDATE SKIP LOCKED`, so overlapping runs never wait for each other or decide a session twice. Within one process runs are single-flight. Phase 3 implemented step 1 and Phase 4B steps 5–6; the others arrive with the phases that own their state.

**Process-owned trigger (E23).** The schedule is stored in Redis, so a FLUSHALL deletes it and nothing in Redis can restore it. Every worker-running process (`ROLE` `all` or `worker`) therefore keeps a timer of its own, every `RECONCILER_INTERVAL_MS`, that never overlaps itself: with Redis reachable it re-registers the schedule if it is missing, and if the liveness record `ff:reconcile:last-finished` (Redis TIME, written by every finished run however it started) is missing or at least **3 × `RECONCILER_INTERVAL_MS`** old (90 s by default) it runs the reconciler directly in-process (skipped if a run is already in flight there); with Redis unreachable it runs only step 6, which needs only PostgreSQL (E22). This adds at most one direct run per process per interval, and only while scheduled runs are not happening. The epoch's local recovery still re-registers the schedule and its global recovery still enqueues a recovery run.

A session step works in keyset batches of in-progress sessions (100, ordered by user, served by the partial unique index; nothing locked), then decides each session in its own transaction (at most 4 at once, every statement bounded at 5 s) under `SKIP LOCKED`: a row held by a request, a job or another run is skipped and left to its holder. Each step stops starting new sessions after one interval (or at shutdown); the next run starts over. One session's failure is logged and counted, never fatal to the run; a follow-up that fails after a commit (a marker write, a job ensure) is logged and repaired by the next run. Only a committed transition publishes its change.

1. Remove presence entries of dead API instances; treat their users and room participants as disconnected at the instance's last heartbeat, and schedule grace. Users are reported before the entries are removed, so an interrupted run is repeated (H2).
2. Room timers that are running past `endsAtMs`: run the phase end. Running timers without a pending job: schedule it.
3. Closed runs in the unsettled set: settle them.
4. Room participants past their grace, still offline when re-checked: apply `grace_expired` (Phase 8).
5. Every running solo session: run the decision for a running session (above), as a caller that never applies E16. Terminal outcomes — `completed`, `abandoned(grace_expired)`, `abandoned(expired)` (E9) — are **settled directly** in that transaction, not left to a job that may itself be lost. Otherwise its jobs are **ensured** (E20): the grace job of a recorded disconnect (also when the user is online again: only that job may apply E16), the end job of a session still before `T_end`; or late grace starts (H3). When presence, the epoch or the marker cannot be trusted (E17, E18) the session is deferred to the next run, unless qualifying E8 evidence decides it.
6. Every solo session still in progress 12 hours after `started_at` (by the PostgreSQL clock, re-checked under the lock), running or paused: `abandoned(expired)`, keeping the time before any current stretch (E2). **This runs after step 5 and does not depend on it (E19):** a session step 5 settled keeps its result (it is no longer in progress), qualifying E8 evidence still completes it first, but a session step 5 had to defer — presence unknown or recovering, the epoch unknown, Redis unavailable — is expired anyway once it reaches the threshold; the 12 hours are never extended. Paused sessions are untouched before then (D14/15/35).
7. Room sessions `in_progress` whose `(room_id, focus_run_id)` has no ledger entry and that are older than 2 minutes: `abandoned(timer_lost)`.

## Redis state loss

Detected through the `ff:epoch` marker key (see `redis-keys.md`). When Redis loses its data:

- In-progress **room** sessions are abandoned with `timer_lost`. Room timers restart as `idle` focus phases **using each room's saved durations** (D16). Clients receive `room:resync` and rejoin to get a fresh snapshot.
- **Solo** sessions keep their state (PostgreSQL). Their scheduled jobs are recreated by the reconciler. A running session whose user is not connected becomes `expired` only if the new epoch was created more than 2 seconds after its `running_since` (definite loss during the stretch, E9); otherwise it gets late grace. After such a loss, being connected at or after `T_end` does not complete it either: without an observed disconnect through the end it becomes `expired` (E8, E9).
- Presence is rebuilt from the sockets still connected to each API instance.

With AOF persistence, a normal Redis restart loses at most about one second of changes; version checks and the reconciler absorb it.
