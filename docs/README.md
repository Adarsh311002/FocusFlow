# Focus Flow v2 — Design Documentation

This folder is the long-term source of truth for the Focus Flow v2 design. `CLAUDE.md` at the repository root holds the short list of rules and approved decisions; these documents hold the full design behind them.

Focus Flow v2 has completed design and its implementation plan is approved. **Phase 0 (foundation) is implemented** on branch `v2/phase-0-foundation`: workspace tooling, shared contracts, the API platform layer with health checks, the web shell, local infrastructure and CI. Nothing beyond that is implemented yet; each later phase begins only when explicitly started (see `implementation/plan.md`). Unless a document says otherwise, what it describes is the design, not the code.

## Status labels

Every statement in these documents falls into one of these categories:

| Label | Meaning |
|---|---|
| **Approved (Dn, Fn, In, Pn)** | An explicit product (D), foundational (F), implementation (I) or approved architecture proposal (P) decision. Listed in `CLAUDE.md` and `decisions/decision-log.md`. Only changed by explicitly revisiting the decision. |
| **Architecture** | Accepted design direction that implements the approved decisions. Can be refined during implementation without a product decision, as long as it stays consistent with the approved decisions. |
| **Open (Dn)** | Undecided. Tracked in `decisions/open-decisions.md`, usually with a recommended default. |
| **Existing (legacy)** | Describes the old JavaScript/MERN implementation in `Client/` and `Server/`. |

## Documents

| Document | Contents |
|---|---|
| [decisions/decision-log.md](decisions/decision-log.md) | Every approved decision, with rationale and consequences |
| [decisions/open-decisions.md](decisions/open-decisions.md) | Every open decision, with the phase that needs it and a recommended default; plus resolved items |
| [implementation/plan.md](implementation/plan.md) | Repository structure, toolchain, stack, local development, testing, CI, legacy strategy, roadmap and the Phase 0 checklist |
| [architecture/overview.md](architecture/overview.md) | System architecture, components, deployment, local development, observability, security boundaries, long-term scope |
| [domain/model.md](domain/model.md) | Entities, PostgreSQL ERD, state machines, where state lives |
| [architecture/auth.md](architecture/auth.md) | Accounts, Google sign-in, per-device sessions, tokens, cookies, socket authentication |
| [architecture/focus-timing-protocol.md](architecture/focus-timing-protocol.md) | Room timer, focus runs, solo session timing, presence and grace, reconciliation |
| [api/rest.md](api/rest.md) | REST endpoints |
| [api/socket-events.md](api/socket-events.md) | Socket.IO connection model and events |
| [architecture/redis-keys.md](architecture/redis-keys.md) | Redis keys, queues and restart semantics |
| [architecture/contracts.md](architecture/contracts.md) | TypeScript contract architecture and the future Node ↔ Python contract |
| [architecture/failure-recovery.md](architecture/failure-recovery.md) | Failure modes and how each one is handled |
| [architecture/legacy-comparison.md](architecture/legacy-comparison.md) | The old implementation compared with v2: reuse, migrate, replace, retire |

## Maintaining these documents

- When an open decision is approved, update `CLAUDE.md`, move the entry from `open-decisions.md` to `decision-log.md`, and update every document that references it.
- When implementation reveals that a design detail must change, update the document in the same change as the code.
- The MVP is the first coherent implementation milestone, not the final product. Each document separates what is built now, what is architected now for later, and what is deliberately deferred.
