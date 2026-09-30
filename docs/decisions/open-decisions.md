# Open Decisions

Undecided items, grouped by when they must be decided. Each has a recommended default so implementation can proceed without waiting. When one is decided, move it to `decision-log.md` and update `CLAUDE.md`.

Nothing below blocks the MVP schema: each item either adds to the design later or only affects behaviour, configuration or a later phase.

## Product decisions that can stay open during implementation

| ID | Question | Recommended default | Must be decided by |
|---|---|---|---|
| D2 | Account deletion and data retention. What happens to rooms a deleted user hosts? | No deletion feature in the MVP. User-owned data cascades; deleting a room host is blocked until this is decided. | Public launch (data-protection law) |
| D12 | Public room discovery, and room size limits | No public listing in the MVP: join by link/code, plus "My Rooms". A global safety limit on people present in a room (e.g. 50). | Before building discovery |
| D18 | Timezone for "days" in reviews | The client passes `tz` (IANA) on summary requests. A stored per-user timezone arrives with personalization. | Personalization phase |
| D20 | Must the host be online for someone to knock? | Yes. Knocking when the host is offline returns `HOST_OFFLINE`. Offline join requests would be a separate later feature. | — |
| D24 | Short temporary chat backlog for late joiners | None in the MVP (still temporary under D7 if added). | — |
| D26 | Guest (logged-out) timer | Browser-only timer with no persistence, or drop the legacy `/timer` route. | Before public launch |
| D29 | Task description field | Leave out until there is UI for it (adding a nullable column later is non-breaking). | — |
| D31 | Opting in to the room's focus during a break (for the next focus) | MVP: opt-in only during a focus phase. | — |
| D32 | Does the next room phase start automatically? | No. Manual start is safe when the host is absent (D10). | — |
| D33 | Landing page claims (pricing, analytics, offline mode, soundscapes) | Rewrite to match what exists. | Public launch |
| D34 | Do abandoned sessions' partial minutes count toward review totals? | The summary returns both `completedFocusedSeconds` and `totalFocusedSeconds`; the UI decides what to show. | Review UI design |
| D36 | Can a member removed from a public room rejoin immediately? | Yes: removal is a "kick" in the MVP. Private rooms require a new knock. Bans are a later feature. | — |
| D37 | Recorded focused time for sessions abandoned as `timer_lost` | 0, because it cannot be known. | — |
| D39 | Email verification and password reset flows | Not needed for the MVP build (D1 removed the security dependency). **Password reset must exist before public launch.** | Public launch |
| D45 | Can a soft-deleted task be restored? | Defer. | Later |

## Facts and actions needed from the project owner

| Item | Needed by |
|---|---|
| Is the legacy app deployed anywhere, or is there MongoDB data worth keeping? (If not, no data migration is needed.) | Before legacy deletion (Phase 5) |
| Create a Google OAuth client for local development and production | Phase 1b |
| Enable branch protection on `main` (require CI) | Phase 0 merge |
| Choose production hosting (managed PostgreSQL 18, Redis with AOF + `noeviction`) | Phase 9 |

## Technical decisions (made during implementation)

| Item | Notes / recommended default |
|---|---|
| Token lifetimes and overlap window | e.g. access 15 min, refresh 30 days, overlap ~20 s. |
| Stale solo session cleanup window | How long a solo session may stay in progress (measured from `started_at`; in practice a paused one) before `abandoned(expired)` (e.g. 12 h). |
| Duration bounds | Room phase durations and solo planned time (e.g. 1–240 min). |
| Knock TTL | e.g. 120 s. |
| Socket.IO ping settings | Tighten so silent disconnects are detected quickly (e.g. `pingInterval` 10 s, `pingTimeout` 10 s). The 60 s grace counts from when the server detects the disconnect. |
| Reconciler interval | e.g. every 30 s, plus on startup. |
| Redis hosting | Must support AOF persistence and `maxmemory-policy noeviction`. |
| Socket.IO transports | If long-polling fallback is enabled and more than one API instance runs, the load balancer needs sticky sessions. |
| `Idempotency-Key` support | For create endpoints; not required for the MVP. |
| Rate-limit values | Chat, knocks, auth endpoints. |
| API bundler | esbuild directly or via `tsdown`. |
| Rate-limiting implementation | `rate-limiter-flexible` (Redis-backed) or a small in-house helper. |
| Exact TypeScript and Drizzle versions | Pinned at Phase 0; upgraded deliberately. |

## Tracked follow-ups

Known work that is deliberately outside the phase that surfaced it.

| Item | Where it goes |
|---|---|
| Phase 1 signup/login request schemas use `z.object` (unknown keys stripped) instead of `z.strictObject` (`architecture/contracts.md`, rule 7) | A separate small hardening/fix PR |
| Security headers (e.g. `helmet`, `Cache-Control: no-store`), rate limiting, `/readyz` caching | The production-hardening phase. **Rate limiting must be in place before the auth API is publicly exposed.** |
| Optimistic updates for tasks (T4) | Later, if the pending states feel slow |
| A per-user task count cap (T6) | Later, if abuse or scale requires it |

## Resolved

| Former item | Resolution |
|---|---|
| ORM and migration tool | Drizzle ORM with `node-postgres`; SQL migrations reviewed and committed (I6) |
| How enums are declared | `text` columns with `CHECK` constraints (I6) |
| D22 — Worker placement | Same codebase, own entry point/role, inside the API process initially (I7) |
| D27 — Monorepo tool | pnpm workspaces (I1, I3) |
| UUID version | UUIDv7 (I6) |
| P1 — Delete behaviour of task references | Plain foreign keys, no `ON DELETE SET NULL`; account deletion clears `users.current_task_id` first (approved) |
| P2 — Health checks | `/healthz` (liveness) and `/readyz` (readiness) (approved) |
| P3 — Redis key prefix | Configurable `REDIS_KEY_PREFIX`, default `ff:`; BullMQ uses the same prefix (approved) |
| D43 — Completing the current task | Clears it as the current task (approved) |
| D44 — Explicit Google linking endpoint | Part of the MVP, Phase 1b (approved) |
| T1–T6 — Phase 2 task details | Single-task read, `id DESC` ordering with one full index, `GET /me` re-read after clearing, no optimistic updates yet, tasks on `/dashboard`, limits (approved; see `decision-log.md`) |

## Later product phases

| ID | Topic |
|---|---|
| D13 | The first AI feature |
| D28 | How the Python AI service reads data: direct read-only PostgreSQL role vs an internal Node API |
| D40 | "Keep me opted in" across room focus runs |
| D41 | Editing or deleting focus history |
| D42 | Changing a room's privacy or name after creation |
| — | Room archiving (D8 "eventually"), bans, offline join requests, persisted chat (would revisit D7) |
| — | Streaks and goals, notifications (email/push), integrations, subscriptions and payments, analytics dashboards |
