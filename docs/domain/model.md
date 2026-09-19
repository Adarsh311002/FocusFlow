# Domain Model

## Entities

| Entity | Meaning | Stored in |
|---|---|---|
| **User** | A person with an account. Identity is separate from how they sign in. | PostgreSQL |
| **Auth identity** | An external sign-in method linked to a user (Google in the MVP). A password is stored on the user row. | PostgreSQL |
| **Auth session** | One logged-in device. Holds the rotating refresh token (D23). | PostgreSQL |
| **Task** | Something the user intends to work on. At most one is the user's current task (D3). Soft-deleted (D38). | PostgreSQL |
| **Focus session** | One block of actual focused work, solo or in a room (D5). Recorded when it starts; ends `completed` or `abandoned` (D14/15/35). May reference a task (D4). | PostgreSQL |
| **Room** | A persistent shared focus space with one host, a join code, privacy, and saved phase durations (D8, D16). | PostgreSQL |
| **Room membership** | Durable access/history relationship between a user and a room (D9). | PostgreSQL |
| **Presence** | Who is connected right now: per user (for solo sessions) and per room. | Redis only |
| **Room timer** | The room's live timer: phase, status, timing, version. | Redis only |
| **Focus run** | One instance of a room focus phase, identified by `focusRunId`. Its participant list links live timer state to durable focus sessions. | Redis only (the run ID is also stored on each room focus session) |
| **Knock** | A pending request to enter a private room. | Redis only, with TTL |
| **Chat message** | A temporary room message (D7). | Not stored (passes through the server) |

Later phases add AI jobs and insights, uploads, subscriptions and payments, notifications and preferences. None of these exist in the MVP schema.

## Relationships

```
User 1──* AuthIdentity
User 1──* AuthSession
User 1──* Task
User 0..1── current Task        (users.current_task_id, same user, open, not deleted)
User 1──* FocusSession
Task 0..1──* FocusSession        (optional; kept when the task is soft-deleted)
Room 0..1──* FocusSession        (room sessions; NULL for solo)
User 1──* Room                   (as host, rooms.host_id)
User *──* Room via RoomMembership (the host also has a membership row)
User *──* Room via Presence       (Redis only)
```

## PostgreSQL ERD (MVP)

Target: PostgreSQL 18, accessed through Drizzle ORM (I6). All IDs are UUIDv7, generated in the application (the database default `uuidv7()` is a fallback). All timestamps are `timestamptz` in UTC, set from the database clock. Column names are snake_case; API contracts are camelCase. Status-like columns (`status`, `abandon_reason`, `provider`) are `text` with `CHECK` constraints, not PostgreSQL enums. Every constraint and index is named explicitly (`pk_`, `fk_`, `uq_`, `ix_`, `ck_`).

Task references (`users.current_task_id`, `focus_sessions.task_id`) are **plain foreign keys with no `ON DELETE` action** (P1). Tasks are soft-deleted (D38), so normal deletion never removes a task row, and nothing relies on `ON DELETE SET NULL`.

```
users
  id                  PK
  email               UNIQUE, case-insensitive
  email_verified_at   NULL                         (D1)
  display_name        NOT NULL, 1–50 chars
  password_hash       NULL                         (NULL for Google-only accounts)
  avatar_url          NULL
  current_task_id     NULL, composite FK (current_task_id, id) → tasks(id, user_id), no ON DELETE action   (D3, P1)
  created_at, updated_at

auth_identities
  id                  PK
  user_id             FK → users, ON DELETE CASCADE
  provider            'google'
  provider_subject    Google "sub"
  email_at_link       email reported by the provider when linked
  created_at
  UNIQUE (provider, provider_subject)

auth_sessions                                      (D23, one row per device)
  id                  PK  (the "sid" claim; also the first part of the refresh token)
  user_id             FK → users, ON DELETE CASCADE
  current_token_hash
  previous_token_hash    NULL
  previous_valid_until   NULL
  rotated_at             NULL
  expires_at
  revoked_at             NULL
  created_at, last_used_at

tasks
  id                  PK
  user_id             FK → users, ON DELETE CASCADE
  title               NOT NULL, 1–200 chars
  completed_at        NULL   (NULL = open)
  deleted_at          NULL   (D38)
  created_at, updated_at
  UNIQUE (id, user_id)                              (target of composite FKs)
  INDEX (user_id, created_at) WHERE deleted_at IS NULL

focus_sessions
  id                  PK
  user_id             FK → users, ON DELETE CASCADE
  task_id             NULL, composite FK (task_id, user_id) → tasks(id, user_id), no ON DELETE action   (D4, P1)
  room_id             NULL, FK → rooms                                              (NULL = solo)
  focus_run_id        NULL   (room sessions only; no FK, runs live in Redis)
  status              in_progress | completed | abandoned
  abandon_reason      NULL | stopped | expired | grace_expired | opted_out | left_room
                              | removed | reset | phase_changed | timer_lost
  planned_seconds     > 0
  focused_seconds     ≥ 0, default 0                                                (D6)
  running_since       NULL                                                          (D6, solo only)
  started_at
  ended_at            NULL
  CHECK (status = 'in_progress')  =  (ended_at IS NULL)
  CHECK (status = 'abandoned')    =  (abandon_reason IS NOT NULL)
  CHECK running_since IS NULL OR (status = 'in_progress' AND room_id IS NULL)
  CHECK (room_id IS NULL)         =  (focus_run_id IS NULL)
  UNIQUE (user_id) WHERE status = 'in_progress'      (at most one active session per user)
  INDEX (user_id, started_at DESC)
  INDEX (room_id, focus_run_id) WHERE status = 'in_progress'

rooms
  id                  PK
  code                UNIQUE (6 chars, no look-alike characters)
  name                NOT NULL, 1–60 chars
  host_id             FK → users (ON DELETE RESTRICT until D2 is decided)
  is_private
  focus_seconds        DEFAULT 1500, bounded CHECK   (D16)
  short_break_seconds  DEFAULT 300,  bounded CHECK   (D16)
  long_break_seconds   DEFAULT 900,  bounded CHECK   (D16)
  created_at, updated_at

room_members                                        (D9)
  room_id             FK → rooms, ON DELETE CASCADE
  user_id             FK → users, ON DELETE CASCADE
  joined_at
  PRIMARY KEY (room_id, user_id)
```

### Rules the database cannot enforce alone

- `users.current_task_id` must point to an open task that is not soft-deleted. Soft-deleting the current task (D38) or completing it (D43) clears `users.current_task_id` in the same transaction, with a conditional update to avoid races. Setting a completed or deleted task as current is rejected.
- Account deletion (D2, when implemented) clears `users.current_task_id` in the account-deletion transaction before deleting the user's data. It does not rely on `ON DELETE SET NULL` (P1).
- A session cannot be started or opted into with a deleted task.
- The host always has a `room_members` row (created in the same transaction as the room).

### Deliberately not in the MVP schema

`room_messages` (D7), `rooms.archived_at` (later, D8), `room_members.role` (the host comes from `rooms.host_id`), `tasks.description` (D29), a stored user timezone (D18), `users.role`, and all AI, upload, subscription and payment tables.

## State machines

### Task
```
open ──complete──► completed ──reopen──► open
open | completed ──delete──► deleted (deleted_at set; hidden; history keeps the link)
```
- Only an open, non-deleted task can be current. Completing (D43) or deleting (D38) the current task clears `users.current_task_id`. Reopening a task does not make it current again.

### Focus session
```
(none) ──start (solo) / opt in (room)──► in_progress ──┬──► completed
                                                        └──► abandoned(reason)
solo, while in_progress:  running ⇄ paused   (D6)
```
- `completed` and `abandoned` are final. At most one `in_progress` session per user.
- **Completed** means the planned time was reached and the user was present at the end, allowing the 60-second grace for an actively running session (D14/15/35).
- **Abandon reasons:**

| Reason | Applies to | When |
|---|---|---|
| `stopped` | solo | The user stopped early |
| `expired` | solo | Unresolved too long (still in progress beyond the cleanup window, typically because it was left paused), or running while the user is gone and the disconnect time is unknown |
| `grace_expired` | solo, room | Disconnected while running and did not reconnect within 60 s |
| `opted_out` | room | Left the room's focus but stayed in the room |
| `left_room` | room | Intentionally left the room (D19) |
| `removed` | room | Removed from the room by the host |
| `reset` | room | Host reset the timer during the run (D17) |
| `phase_changed` | room | Host moved away from the focus phase (D17) |
| `timer_lost` | room | The room's live Redis state was lost |

- How `focused_seconds` is calculated for each outcome is defined in `architecture/focus-timing-protocol.md`.

### Room
- MVP: every room is `active`. Whether it is **live** (anyone present) or **idle** is derived from presence and never stored (D8). Archiving comes later.

### Room membership
```
public:   (none) ──POST membership (idempotent)──► member                       (D9)
private:  (none) ──knock──► knocking (Redis, TTL) ──┬──approve──► member
                                                    └──reject / cancel / expire──► (none)
member ──leave | host removes──► (none)
host: member from room creation; cannot leave in the MVP (no host transfer, D10)
```

### Room timer
Each state also carries a phase: `focus`, `short_break` or `long_break`. Every accepted change increments `version`.
```
idle ──start──► running ──pause──► paused ──resume──► running
running | paused ──reset──► idle (same phase, full duration)
idle | running | paused ──setPhase(p)──► idle(p)
running ──reaches zero──► idle(next phase)      focus → short_break; any break → focus
host disconnect: no transition (D10)
```
The next phase never starts automatically (open D32). Full protocol: `architecture/focus-timing-protocol.md`.

### Focus run and participant
```
run:          open ──reset | phase change | reaches zero──► closed(reason) ──settled──► (deleted)
participant:  connected ⇄ disconnected (60 s grace) ──► settled (completed | abandoned(reason))
```

## Where state lives

| State | Owner | Why |
|---|---|---|
| Users, identities, auth sessions | PostgreSQL | Losing them means users cannot sign in |
| Tasks, current task | PostgreSQL | The user's intentions (D3, D38) |
| Focus sessions, including in-progress ones and solo pause accounting | PostgreSQL | The record of accomplishment; written at start so no crash can erase that focus began (D6) |
| Rooms, room settings, memberships | PostgreSQL | Persistent spaces and access grants (D8, D9, D16) |
| Presence (user-level and room-level) | Redis | Temporary by definition; rebuilt from live sockets |
| Room timer state, settings live copy | Redis | Changes often, needs atomic updates; settings reload from PostgreSQL |
| Focus run ledger and participants | Redis | Links live timer to durable sessions; loss is detected and recorded as `timer_lost` |
| Knocks | Redis (TTL) | Only meaningful while the room is live |
| Revoked auth session IDs | Redis (TTL) | Fast revocation checks within one access-token lifetime |
| Queues, rate limits, chat de-duplication | Redis | Infrastructure; safe to lose |
| Chat messages | Not stored | D7 |
| Access token | Client memory | Short-lived; out of reach of persistent XSS storage (D23) |
| Refresh token | httpOnly cookie | Not readable by JavaScript (D23) |
| Countdown display, clock offset, chat list, drafts, modals | Client only | Presentation; always derived from server state |
