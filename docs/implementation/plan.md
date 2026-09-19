# Implementation Plan

How Focus Flow v2 is built. The implementation decisions here are **Approved (I1–I12)** and recorded in `decisions/decision-log.md`; everything else is **Architecture** and may be refined during implementation without a product decision.

Guiding principle: the MVP is the first coherent milestone of a long-term product. Build the foundations and core features now, leave clean extension points, and do not add speculative infrastructure before the product needs it.

## Status

- Implementation plan: **approved** (I1–I12, P1–P3, D43, D44).
- Phase 0: next; **not started.** Each phase begins only when explicitly instructed.
- No architectural questions remain open for Phase 0. Remaining open items are listed in `decisions/open-decisions.md` with the phase that needs them.

## Repository structure (I1, I2)

```
focus-flow/
├─ apps/
│  ├─ web/                    React + Vite + TypeScript
│  │  └─ src/
│  │     ├─ app/              router, providers, layout
│  │     ├─ features/         auth/ tasks/ focus/ review/ rooms/
│  │     ├─ lib/              api-client, socket-client, query-client, time-sync
│  │     └─ components/       shared UI pieces
│  └─ api/                    Express + Socket.IO + background workers (one codebase)
│     ├─ src/
│     │  ├─ main.ts           single entry point; role selects api / worker / all
│     │  ├─ platform/         config, logger, db, redis, http, socket, queues, errors, shutdown
│     │  ├─ db/               Drizzle schema, migrations/ (SQL), seed
│     │  └─ modules/          auth/ users/ tasks/ focus-sessions/ rooms/ room-timer/ presence/ reconciler/
│     │                       each: http.ts, socket.ts, service.ts, queries.ts, jobs.ts, policy.ts (only as needed)
│     └─ test/                integration-test helpers, container setup
├─ packages/
│  └─ contracts/              Zod schemas, inferred types, socket event types, job schemas
├─ e2e/                       Playwright (added with room functionality)
├─ infra/
│  └─ compose.yaml            PostgreSQL + Redis for local development
├─ docs/
├─ services/ai/               Python AI service (created in the AI phase, not before)
├─ tsconfig.base.json · eslint.config.ts · pnpm-workspace.yaml · package.json
├─ lefthook.yml · .gitignore · .gitattributes · .node-version · .editorconfig
└─ Client/ Server/ docker-compose.yml   ← legacy: untouched, not part of the workspace
```

- **Workers** live in `apps/api` (same database code, Redis operations and modules). They run inside the API process initially and have their own role, so they can become a separate deployment later (I7).
- **Database code** stays in `apps/api/src/db`: Node owns the schema and migrations, and the API is the only Node program that accesses PostgreSQL.
- **Socket.IO handlers** live in their feature modules; the server setup is in `platform/socket`.
- **One shared package** (`packages/contracts`). Tool configuration (TypeScript, ESLint, Prettier) is a single set of root files, not packages. There is no shared-utilities package.
- **Tests** sit next to the code: `*.test.ts` (fast) and `*.int.test.ts` (need PostgreSQL/Redis). Browser end-to-end tests live in `e2e/`.
- **`infra/compose.yaml`**, not a root compose file, because Docker Compose would prefer a root `compose.yaml` over the legacy `docker-compose.yml` and silently change what the legacy command does.
- **Python** arrives as `services/ai`, its own `uv` project; pnpm ignores it. The only thing shared with Node is JSON Schema generated from `contracts`.

## Toolchain (I3, I11)

| Area | Choice |
|---|---|
| Runtime | Node.js 24 LTS (`.node-version`, `engines`, Docker `node:24-slim`) |
| Package manager | pnpm workspaces; version pinned in `packageManager`; catalogs for shared dependency versions; allowlist for packages with install scripts |
| Language | TypeScript, strict, one pinned version across the workspace |
| Lint / format | ESLint 9 with type-aware `typescript-eslint` rules; Prettier (config in `package.json`) |
| Git hooks | lefthook (formatting and lint on staged files, commit-message check, typecheck on push) |
| Commits | Conventional Commits |
| CI | GitHub Actions |

## TypeScript foundation

- Root `tsconfig.base.json`; one small `tsconfig.json` per project. No project references until typechecking becomes slow.
- Compiler options: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noImplicitReturns`, `verbatimModuleSyntax`, `isolatedModules`, `erasableSyntaxOnly` (no `enum`, `namespace` or parameter properties; use string-literal unions and `as const` objects).
- ESM everywhere (`"type": "module"`). `module: "preserve"`, `moduleResolution: "bundler"`. The TypeScript compiler only typechecks (`noEmit`); Vite builds the web app and esbuild bundles the API.
- Targets: api `ES2024`; web `ES2022`.
- `packages/contracts` has no build step: both apps consume its TypeScript source.
- API: development with `tsx watch`; production bundle with esbuild (third-party packages external, workspace packages bundled, source maps on).
- Imports: package names across packages (`@focus-flow/contracts`); relative within a feature; `#`-prefixed `package.json` imports across features within an app. No TypeScript `paths`.
- Rules: only `.ts`/`.tsx` (config files included); `import type` for type-only imports; no `any`; no type assertions except `as const` (and in tests); branded IDs only via Zod parsing; `@ts-expect-error` requires a reason, `@ts-ignore` is banned; `process.env` only in the config module; `no-floating-promises` and `no-misused-promises` enforced.

## Frontend (I4)

| Area | Choice |
|---|---|
| Framework | React + TypeScript + Vite |
| Routing | TanStack Router (code-based routes; type-checked links and params) |
| Server data | TanStack Query (socket events update its cache) |
| Live room state | Zustand, one store per room, fed only by socket events |
| API client | Typed `fetch` wrapper: access token in memory, single shared refresh on 401, typed error envelope |
| Socket client | Typed `socket.io-client`; `auth` callback fetches a fresh token on each connect |
| Validation | Schemas from `@focus-flow/contracts` |
| Forms | Native forms and React 19 actions initially |
| Styling | Tailwind CSS v4 |
| Components | Radix primitives only where actually needed |
| Animation | None yet; visual design is deferred |
| Optimistic updates | Tasks only; server-controlled state (sessions, timer) shows a pending state instead |

## Backend (I5)

- Node.js 24 LTS, Express 5, Socket.IO, ESM.
- **Startup order:** validate config → logger → PostgreSQL pool → Redis connections → Redis epoch check → Express app → HTTP server → Socket.IO with Redis adapter → modules → workers (if the role includes them) → listen.
- **Layering:** thin HTTP/socket handlers (parse, call service, map result) → **service functions** (authorization, transactions, write ordering, idempotency) → `queries.ts` for named or reused Drizzle queries. No generic repository abstraction, no dependency-injection container: `main.ts` builds a plain `deps` object (db, redis, queues, emitter, clock, logger) and passes it in.
- **Auth libraries:** `jose` (JWTs, and Google ID token verification via Google's public keys); argon2id for password hashing.
- **Errors:** an `AppError` carrying a contract error code and HTTP status; middleware maps errors to the envelope; named database constraints translate to domain errors (for example the one-in-progress-session index → `409 SESSION_IN_PROGRESS`).
- **Logging:** `pino` / `pino-http`, request ID and user ID carried through `AsyncLocalStorage`, passed into jobs as `correlationId`.
- **Environment:** validated with Zod at startup; the process refuses to start on invalid configuration.
- **Graceful shutdown:** stop accepting connections → close Socket.IO (clients reconnect; the 60 s grace covers deploys) → let running jobs finish → close Redis and PostgreSQL → forced exit after a timeout.

## Database (I6)

- PostgreSQL 18; Drizzle ORM with `node-postgres`.
- **Migrations:** generated by Drizzle as SQL, reviewed, hand-edited where Drizzle cannot express something, and committed. Forward-only. Run as a separate `migrate` step, never automatically at API startup.
- **IDs:** UUIDv7, generated in the application (some IDs must be known before insert). The database default `uuidv7()` is a fallback.
- **Types and naming:** `timestamptz` set from the database clock (`now()`); snake_case, plural table names, `{singular}_id` foreign keys; status-like columns are `text` with `CHECK` constraints instead of PostgreSQL enums; every constraint and index is named explicitly (`pk_`, `fk_`, `uq_`, `ix_`, `ck_`).
- **Transactions:** `READ COMMITTED` by default. Correctness comes from unique constraints, conditional updates and `FOR UPDATE` where a read precedes a write. Transactions stay short; no Redis or network calls inside a transaction.
- **Task references (P1):** `users.current_task_id` and `focus_sessions.task_id` are plain foreign keys with no `ON DELETE` action. Tasks are soft-deleted (D38); account deletion, when implemented, clears `users.current_task_id` in its transaction before deleting the user's data.
- **Email:** normalized to lowercase at the boundary; plain unique index.
- **Seed:** an idempotent development-only seed script. Tests use factories.
- **Test databases:** Testcontainers PostgreSQL per test run; migrations applied once to a template database; each test file gets its own copy.
- **Production:** separate migration role (DDL) and application role (read/write).

## Redis and jobs (I7, I8)

- Redis (AOF persistence, `noeviction`), `ioredis` everywhere, BullMQ for delayed and repeating jobs.
- **Key prefix (P3):** every application key uses the configured `REDIS_KEY_PREFIX` (default `ff:`); BullMQ keys use the corresponding prefix (default `ff:bull`).
- **Worker placement:** worker code lives in `apps/api` with its own entry point/role and runs **inside the API process** initially. Workers always send socket events through the Socket.IO Redis emitter (never the in-process server), so splitting them into a separate deployment later is a configuration change, not a code change.
- **Timer implementation (I8):**
  - Timer state transitions are a **pure TypeScript function**: `(state, command, nowMs) → newState | rejection`.
  - `nowMs` comes from Redis `TIME`, the single authoritative clock for room timer arithmetic.
  - The new state is written with a small, **version-checked atomic Redis operation** (it succeeds only if the stored version is still the one that was read). A conflict triggers a bounded re-read and retry.
  - Lua stays intentionally small (compare-version-and-write, including any related keys such as the run ledger and running-timers index); it contains no business logic.
  - The same pattern applies to phase ends, run closure and the opt-in guard.
  - Property-based tests cover the pure state machine and the concurrency assumptions (see Testing).
- The reconciler runs as a BullMQ repeating job and at startup (see `architecture/focus-timing-protocol.md`).

## Local development (I9)

- PostgreSQL and Redis run in Docker via **`infra/compose.yaml`**. Root scripts always call `docker compose -f infra/compose.yaml …`. The legacy root `docker-compose.yml` stays untouched.
- The web app and API run **natively on Windows** (`pnpm dev`) for fast reloads and working debuggers.
- Database ports are bound to `127.0.0.1` only.
- One origin locally: the Vite dev server (port 5173) proxies `/api` and `/socket.io` (including WebSocket) to the API (port 3000).
- `.env.example` in `apps/api`, `apps/web` and `infra`; real `.env` files are git-ignored.

## Environment variables and secrets

| Owner | Variables | Secret |
|---|---|---|
| web (browser-visible) | `VITE_GOOGLE_CLIENT_ID` (from Phase 1b). No API URL: the app is same-origin. | No |
| api: runtime | `APP_ENV`, `NODE_ENV`, `PORT`, `ROLE` (from Phase 3), `LOG_LEVEL`, `SHUTDOWN_TIMEOUT_MS` | No |
| api: database | `DATABASE_URL`; `MIGRATION_DATABASE_URL` (migration step) | Yes |
| api: Redis | `REDIS_URL`, `REDIS_KEY_PREFIX` (default `ff:`) | Yes (URL) |
| api: auth (Phase 1) | `JWT_ACCESS_SECRETS` (with key IDs for rotation), `JWT_ISSUER`, `JWT_AUDIENCE`, `ACCESS_TOKEN_TTL_SECONDS`, `REFRESH_TOKEN_TTL_SECONDS`, `REFRESH_OVERLAP_SECONDS`, `GOOGLE_CLIENT_ID` | Yes (JWT secrets) |
| Later: api | Razorpay secrets, S3 credentials | Yes |
| Later: AI service | LLM provider keys | Yes |

Naming: UPPER_SNAKE_CASE, units in the name (`_SECONDS`, `_MS`), `_URL` for connection strings. Production secrets come from the host's secret store; never baked into images or committed.

## Testing (I10)

| Layer | Tools |
|---|---|
| Unit | Vitest |
| Property-based | fast-check (timer state machine invariants: remaining time never negative, version only increases, no illegal transitions, elapsed never exceeds duration; concurrent command interleavings) |
| Integration | Vitest + Testcontainers (real PostgreSQL 18 and Redis) |
| API | Vitest against a real server on a random port |
| Socket.IO | Vitest + multiple typed `socket.io-client` connections |
| Frontend components | Vitest + Testing Library |
| End-to-end | Playwright (multiple browser contexts), added with room functionality |

**Required before merging:** typecheck, lint, format check, no-JavaScript check, unit and integration tests, builds. Every state transition and every endpoint's permission rule needs a test; every bug fix adds a regression test. No coverage-percentage gate. A Playwright smoke suite becomes required from the rooms phase.

## Code quality (I11)

- ESLint rules: `typescript-eslint` strict type-checked set, React Hooks, `jsx-a11y`, import sorting, boundary rules (`web` cannot import `api`; `contracts` imports only `zod`; nothing imports legacy folders), `process.env` banned outside config.
- `.gitattributes` with `* text=auto eol=lf`.
- File names: kebab-case (safe on case-insensitive Windows file systems). Types and components PascalCase; functions and variables camelCase; database snake_case; API camelCase; socket events `area:action`; error codes UPPER_SNAKE.
- A CI check fails on any `.js`, `.jsx`, `.cjs` or `.mjs` file outside `Client/`, `Server/` and build output.

## CI

- GitHub Actions on pull requests and pushes to `main`: frozen install (pnpm store cached) → typecheck, lint, format check, no-JavaScript check → unit tests → integration tests (Testcontainers) → builds.
- Work happens on short-lived branches merged through pull requests, so CI runs on every change.
- Later: Playwright smoke tests (rooms phase), Docker image builds, dependency audit, Python schema-drift check (AI phase), deployment.

## Legacy strategy (I12)

- `Client/`, `Server/` and the root `docker-compose.yml` remain untouched. v2 is built in the new structure; there is no gradual JavaScript-to-TypeScript conversion of the legacy app.
- Legacy code is excluded from the workspace, ESLint and CI. Nothing imports it; reusable UI markup is copied and rewritten as TSX.
- Legacy code is deleted in one dedicated commit at the **solo-core milestone** (end of Phase 5), not before.
- `archi/` is not modified or committed unless explicitly instructed.

## Roadmap

| Phase | Purpose | Prerequisites | Done when | Milestone |
|---|---|---|---|---|
| 0 Foundation | A repository where correct code is easy and wrong code fails CI | Plan approved | Checklist below complete | — |
| 1 Accounts | Email/password accounts, per-device sessions, refresh rotation, revocation (D23) | 0 | Authentication security tests pass | — |
| 1b Google sign-in | D1 sign-in and the explicit linking endpoint (D44) | 1; Google OAuth client | D1 and linking cases pass | — |
| 2 Tasks | Tasks, current task, soft delete (D3, D38, D43) | 1 | Ownership, soft-delete and current-task rules tested | — |
| 3 Real-time foundation | Authenticated sockets, Redis adapter and emitter, per-user presence, BullMQ, `ROLE`, reconciler skeleton, epoch check, clock sync | 1 | Presence, revocation and dead-instance cleanup tested | — |
| 4 Solo focus | Solo sessions with pause, server-driven completion, grace, stale cleanup | 2, 3 | Every solo transition and race tested | — |
| 5 Review | History and summary | 4 | Timezone aggregation tested | **Solo core loop**; legacy deleted |
| 6 Rooms and presence | Rooms, membership, knocks, room presence, temporary chat; Playwright added | 3 | Permission, knock and multi-client tests | — |
| 7 Room timer | Pure timer logic, version-checked writes, host commands, phase-end jobs, D16 settings | 6 | Property and race tests pass | — |
| 8 Room focus runs | Opt-in, run ledger, settlement, grace, full reconciler, Redis-loss recovery | 4, 7 | Grace, settlement and Redis-failure scenarios pass | **MVP feature-complete** |
| 9 Launch readiness | Production images, Nginx single origin, migration job, backups, security review, E2E required, D39, D2, D33 | 8 | Launch checklist complete | **Launchable MVP** |
| 10+ | AI foundation, then D13; notifications; analytics; payments | 9 | — | — |

## First slice

Phase 0, followed immediately by Phase 1 email/password accounts: a person can sign up, log in, reload and stay logged in, log out, and a revoked session stops working immediately. It exercises every layer (contracts, web, API, PostgreSQL migration, Redis, cookies, same-origin proxy, CI with real databases), builds the most security-sensitive logic while the codebase is small, and avoids any throwaway fake authentication.

## Phase 0 checklist

Branch: `v2/phase-0-foundation`, merged through a pull request.

### Repository root
- [ ] `.gitignore` (dependencies, build output, coverage, test artifacts, logs, `.env*` except `.env.example`)
- [ ] `.gitattributes` (`* text=auto eol=lf`; binary types marked binary)
- [ ] `.editorconfig`, `.node-version` (24)
- [ ] `package.json`: private; `packageManager` pinned; `engines.node` 24; Prettier config; scripts `dev`, `build`, `typecheck`, `lint`, `format`, `format:check`, `test`, `test:int`, `check:no-js`, `infra:up`, `infra:down`, `infra:reset`, `infra:logs` (all `infra:*` scripts call `docker compose -f infra/compose.yaml …`)
- [ ] `pnpm-workspace.yaml`: `apps/*`, `packages/*`; catalog for shared versions (TypeScript, Zod, Vitest, `@types/node`); allowlist for packages with install scripts
- [ ] `tsconfig.base.json` with the compiler options above
- [ ] `eslint.config.ts` with the rule set above; ignores `Client/`, `Server/`, build output
- [ ] `lefthook.yml`: pre-commit (Prettier + ESLint on staged files), commit-msg (Conventional Commits check), pre-push (typecheck)
- [ ] `scripts/check-no-js.ts` and `scripts/check-commit-msg.ts`
- [ ] Root `Readme.md`: v2 quick start and a note that `Client/`/`Server/` are legacy

### `infra/`
- [ ] `compose.yaml`: `postgres:18` (health check, named volume, `127.0.0.1:5432`) and Redis (`--appendonly yes --maxmemory-policy noeviction`, health check, named volume, `127.0.0.1:6379`)
- [ ] `.env.example` for the Compose credentials

### `packages/contracts`
- [ ] Package setup (`@focus-flow/contracts`, ESM, exports TypeScript source, depends only on `zod`)
- [ ] Branded-ID helper
- [ ] Error envelope schema and the initial error-code union (codes used in Phase 0 only)
- [ ] Liveness and readiness response schemas
- [ ] Unit tests for the schemas

### `apps/api`
- [ ] Package setup (`@focus-flow/api`), `tsconfig.json`, Vitest config (unit and integration projects), esbuild build script
- [ ] `platform/config.ts`: Zod-validated environment (`APP_ENV`, `NODE_ENV`, `PORT`, `LOG_LEVEL`, `DATABASE_URL`, `REDIS_URL`, `REDIS_KEY_PREFIX`, `SHUTDOWN_TIMEOUT_MS`)
- [ ] `platform/logger.ts` (pino), request context (`AsyncLocalStorage`), request ID middleware
- [ ] `platform/errors.ts`: `AppError`, error middleware, 404 handler, response envelope
- [ ] `platform/db.ts` (node-postgres pool) and `platform/redis.ts` (ioredis connection factory applying `REDIS_KEY_PREFIX`, default `ff:`, P3)
- [ ] `GET /api/v1/healthz` (liveness, no dependency checks) and `GET /api/v1/readyz` (PostgreSQL and Redis reachability; `503` when not ready), response shapes from `contracts` (P2)
- [ ] `platform/shutdown.ts`: graceful shutdown on SIGTERM/SIGINT
- [ ] `main.ts` wiring it together
- [ ] `.env.example`
- [ ] Tests: config validation and error mapping (unit); health endpoint with both databases up and with Redis down (integration, Testcontainers)

### `apps/web`
- [ ] Package setup (`@focus-flow/web`), `tsconfig.json`, `vite.config.ts` (React, Tailwind v4, proxy for `/api` and `/socket.io` with WebSocket)
- [ ] `index.html`, `src/main.tsx`
- [ ] TanStack Router (root and index routes) and TanStack Query provider
- [ ] Typed `fetch` client (base path `/api/v1`, error envelope parsing, response validation; no auth yet)
- [ ] A system-status view showing API health through the proxy
- [ ] Component test for the status view

### CI
- [ ] `.github/workflows/ci.yml`: install (frozen, cached) → typecheck, lint, format check, no-JavaScript check → unit tests → integration tests → builds

### Validation
- [ ] From a fresh clone: `pnpm install`, `pnpm infra:up`, copy the `.env.example` files, `pnpm dev` → the browser at `localhost:5173` shows the API as live and ready through the proxy
- [ ] Stopping Redis makes `/readyz` return `503` and the status view show the API as not ready, while `/healthz` still returns `200`
- [ ] `typecheck`, `lint`, `format:check`, `check:no-js`, `test`, `test:int` and `build` pass locally and in CI
- [ ] `git diff` shows no changes to `Client/`, `Server/`, the root `docker-compose.yml` or `archi/`

### Deliberately not in Phase 0
Database schema, Drizzle schema files and migrations (Phase 1); authentication (Phase 1); Socket.IO, BullMQ, the worker role and presence (Phase 3); Zustand (Phase 6); Dockerfiles and a full-stack Compose profile (Phase 9, or earlier if CI end-to-end tests need them); `e2e/` and Playwright (Phase 6); Radix.

## Decisions resolved before Phase 0

| ID | Resolution |
|---|---|
| P1 | Plain foreign keys for task references; no reliance on `ON DELETE SET NULL`; account deletion clears `users.current_task_id` first |
| P2 | `/healthz` (liveness) and `/readyz` (readiness) |
| P3 | Configurable `REDIS_KEY_PREFIX` (default `ff:`); BullMQ uses the same prefix |
| D43 | Completing the current task clears it as the current task |
| D44 | Explicit Google linking endpoint is part of Phase 1b |

Still needed from the project owner, by phase: Google OAuth client (Phase 1b); branch protection on `main` (Phase 0 merge); whether the legacy app is deployed or has MongoDB data worth keeping (before legacy deletion, Phase 5); production hosting (Phase 9). See `decisions/open-decisions.md`.
