# Focus Timing Protocol

How the server decides when focus starts, pauses, ends, completes or is abandoned, for room sessions and solo sessions.

Approved decisions implemented here: D5, D6, D10, D11, D14/15/35, D16, D17, D19, and implementation decisions I7 (worker placement) and I8 (timer implementation). Everything else in this document is **Architecture**.

## Principles

1. The server is authoritative (F6). Clients display countdowns from server timestamps and never decide that a phase or session has ended.
2. Durable facts (focus sessions) are written to PostgreSQL. Live room state (timer, presence, run participants) lives in Redis.
3. "Completed" means the planned time was reached **and** the user was present at the end, with a 60-second reconnect grace for an actively running session (D14/15/35).
4. Every scheduled job and every state change is safe to run twice.

## Clocks

| What | Clock |
|---|---|
| Room timer arithmetic, `serverNowMs` sent with timer state | Redis server time, read with `TIME` immediately before each change is computed (I8) |
| Stored timestamps; solo session arithmetic | PostgreSQL `now()` |
| API server clocks | Never used for these |

All hosts run NTP. Room session `ended_at` values come from the focus run's close time.

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
| `disconnect` | The disconnect handler removed the user's last entry (or the instance shut down cleanly) | Of the removal, read in the same transaction |
| `missed_disconnect` | A sync removed a stale entry whose disconnect was never recorded | Of the detecting sync (the real moment is unknown and earlier) |
| `instance_dead` | The reconciler removed a dead instance's entries | The instance's last heartbeat score |

Whether a removal left the user offline is judged in the same transaction as the removal. Only the path that actually removed an entry reports it, so a disconnect and a sync never both report the same socket. Dead-instance cleanup reports **before** it removes the entries: a run that dies in between is repeated by the next run, which reports again with the same last-heartbeat time.

An **online event** `userId` is emitted when a socket of the user is newly recorded (connect, or a sync re-adding it). Phase 4 uses it to clear the disconnect marker early.

**Both are hints, never decisions.** An offline event can be missed (a crash, a failing handler), repeated (always with the same `(userId, disconnectedAtMs)`, so consumers collapse repeats by that key, e.g. with `SET NX`), or stale (the user may already be connected through another instance, for example during a rolling deploy). No Solo Focus outcome is decided from an event alone: every decision (grace expiry, the end job, the reconciler) first re-checks **`checkUser`**, which reads the user's entries, the heartbeats and Redis TIME in one transaction and returns `{ online, checkedAtMs }`. If that check fails, the decision is retried, never taken on an unknown state. The reconciler's sweep of running solo sessions (steps 4–6) is the durable backstop for every lost hint.

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

Solo session state lives entirely in PostgreSQL (D6). Redis holds only user-level presence and scheduled jobs.

### Start, pause, resume, stop

| Action | Rule | Effect |
|---|---|---|
| Start (`POST /focus-sessions`) | User connected (else `409 NOT_CONNECTED`); no in-progress session; optional task theirs and not deleted | Insert `in_progress`, `running_since = now()`, `focused_seconds = 0`; schedule the end job |
| Pause | Running | `focused_seconds += now() − running_since`; `running_since = NULL` |
| Resume | Paused; user connected | `running_since = now()`; schedule a new end job |
| Stop | In progress | `abandoned(stopped)`; `focused_seconds` includes the current stretch if running; `ended_at = now()` |

Pause and resume are safe to repeat. There is no "complete" endpoint: completion is decided by the server.

### Reaching the planned time

The end job fires at `T_end = running_since + (planned_seconds − focused_seconds)`, keyed by session ID and `running_since`, so a pause or resume makes older jobs irrelevant.

1. If the session is no longer in progress, or `running_since` changed, do nothing. If fired early, reschedule.
2. User connected → `completed`: `focused_seconds = planned_seconds`, `ended_at = T_end`, `running_since = NULL`.
3. User disconnected and within grace → wait. Reconnect within grace → `completed` as above. Grace expires → `abandoned(grace_expired)`.

### Disconnect while running

- When the user's last socket anywhere drops while a solo session is **running**, a disconnect marker is recorded with the offline event's `disconnectedAtMs` (`SET NX`, so repeated events keep the first time) and a grace job is scheduled for 60 seconds later.
- Reconnecting within grace removes the marker (the online hint). If `T_end` passed during the grace period, the session completes immediately (`ended_at = T_end`).
- At grace expiry the job re-checks presence (H2): if the user is online after all (for example, they reconnected through another instance before the marker was written), the marker is removed and the session continues, or completes if `T_end` has passed. Only if the user is still offline is the session `abandoned(grace_expired)`, with `focused_seconds += min(disconnectedAt, T_end) − running_since` and `ended_at = disconnectedAt`.

### Paused solo sessions

A disconnect does **not** start the grace for a paused solo session (D14/15/35). The session stays paused. Stale-session cleanup marks it `abandoned(expired)` if it remains unresolved beyond the cleanup window, measured from `started_at` (the exact window is a technical setting; see `open-decisions.md`). `focused_seconds` keeps the accumulated value.

### `expired`

A solo session is `abandoned(expired)` when:
- it has been in progress longer than the cleanup window; or
- it is running, the user is not connected, no disconnect marker exists, **and Redis lost its data during the current running stretch** (the current epoch was created after `running_since`), so the marker may have been lost and the server cannot tell when the user left. Only the time accumulated before the current running stretch is kept.

**Late grace (H3, approved).** If the reconciler finds a running solo session whose user is not connected and has no disconnect marker, but the epoch has **not** changed during the running stretch, the disconnect was simply missed or its hint lost. The reconciler then starts a normal 60-second grace from the detection time (`checkedAtMs`, written with `SET NX`) instead of expiring the session. This can over-count focused time by at most the detection delay (about one reconciler interval), which is preferred over discarding the whole stretch because of an infrastructure fault.

## Scheduled jobs

| Queue | Job | Keyed by | No-op when |
|---|---|---|---|
| `room-timer` | Phase end | room ID + version | Version changed or not running |
| `focus-session` | Room participant grace | room + run + user + `disconnectedAtMs` | Participant reconnected or already settled |
| `focus-session` | Solo end | session ID + `running_since` | Session paused, resumed again, or ended |
| `focus-session` | Solo grace | session ID + `disconnectedAtMs` | User reconnected or session ended |
| `maintenance` | Reconciler (repeating) | — | — |

## Reconciler

Runs at startup, after Redis recovery and on a repeating BullMQ schedule (every 30 seconds, R6), so exactly one worker takes each scheduled run. Every step is safe to repeat. Phase 3 implements step 1; the others arrive with the phases that own their state.

1. Remove presence entries of dead API instances; treat their users and room participants as disconnected at the instance's last heartbeat, and schedule grace. Users are reported before the entries are removed, so an interrupted run is repeated (H2).
2. Room timers that are running past `endsAtMs`: run the phase end. Running timers without a pending job: schedule it.
3. Closed runs in the unsettled set: settle them.
4. Room participants and solo users past their grace, still offline when re-checked: apply `grace_expired`. Running solo sessions whose user is offline with no marker: start late grace (H3), unless the epoch changed during the stretch.
5. Running solo sessions past `T_end` with the user connected: complete. Missing end jobs: schedule them.
6. Solo sessions for the `expired` cases above.
7. Room sessions `in_progress` whose `(room_id, focus_run_id)` has no ledger entry and that are older than 2 minutes: `abandoned(timer_lost)`.

## Redis state loss

Detected through the `ff:epoch` marker key (see `redis-keys.md`). When Redis loses its data:

- In-progress **room** sessions are abandoned with `timer_lost`. Room timers restart as `idle` focus phases **using each room's saved durations** (D16). Clients receive `room:resync` and rejoin to get a fresh snapshot.
- **Solo** sessions keep their state (PostgreSQL). Their scheduled jobs are recreated by the reconciler. Running sessions of users who are not connected become `expired`, because the disconnect time is unknown.
- Presence is rebuilt from the sockets still connected to each API instance.

With AOF persistence, a normal Redis restart loses at most about one second of changes; version checks and the reconciler absorb it.
