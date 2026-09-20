# Focus Flow

Focus Flow helps people do focused work, alone or together: decide what to work on, focus for a set time, record the accomplishment, review progress.

The repository is being rebuilt as **Focus Flow v2** (TypeScript, PostgreSQL, Redis). The design is documented in [`docs/`](docs/README.md); project rules live in [`CLAUDE.md`](CLAUDE.md).

## Repository layout

| Path                                       | Contents                                                           |
| ------------------------------------------ | ------------------------------------------------------------------ |
| `apps/api`                                 | Express backend (TypeScript)                                       |
| `apps/web`                                 | React + Vite frontend (TypeScript)                                 |
| `packages/contracts`                       | Zod schemas and types shared by both apps                          |
| `infra/`                                   | Docker Compose for local PostgreSQL and Redis                      |
| `docs/`                                    | Design documentation and decision records                          |
| `Client/`, `Server/`, `docker-compose.yml` | **Legacy v1 application. Untouched and excluded from v2 tooling.** |

## Requirements

- Node.js 24 LTS. `.node-version` pins it for CI and version managers (fnm, nvm, Volta); the repo also runs on newer Node versions, which `engines` allows.
- pnpm 12 (`corepack enable pnpm`, or run it through `npx pnpm@12.5.1`)
- Docker, for local PostgreSQL and Redis

## Getting started

```bash
pnpm install
pnpm infra:up      # starts PostgreSQL and Redis in Docker
```

Create the environment files from the examples (the API refuses to start without `apps/api/.env`):

```bash
# macOS, Linux, Git Bash
cp apps/api/.env.example apps/api/.env
cp infra/.env.example infra/.env
```

```powershell
# Windows PowerShell
Copy-Item apps/api/.env.example apps/api/.env
Copy-Item infra/.env.example infra/.env
```

Then start everything:

```bash
pnpm dev           # API on 127.0.0.1:3000, web on :5173
```

Open http://localhost:5173. The web app talks to the API through the Vite proxy, so development is single-origin like production.

Git hooks (formatting, linting, Conventional Commit messages) are installed by lefthook during `pnpm install`; run `pnpm hooks:install` if they are missing.

## Where new code goes

- `apps/api/src/platform/`: cross-cutting infrastructure (config, logging, database and Redis clients, HTTP plumbing).
- `apps/api/src/modules/<name>/`: one folder per feature (`http.ts`, `service.ts`, ...).
- `apps/web/src/features/<name>/`: one folder per feature; `app/` holds providers and routing, `lib/` shared client code.
- `packages/contracts/src/`: every request, response and error shape shared by the two apps.

## Common commands

| Command                                        | Purpose                                      |
| ---------------------------------------------- | -------------------------------------------- |
| `pnpm dev`                                     | Run the API and web app together             |
| `pnpm dev:api` / `pnpm dev:web`                | Run one app on its own                       |
| `pnpm typecheck`                               | Type-check every package                     |
| `pnpm lint` / `pnpm format:check`              | Lint / check formatting                      |
| `pnpm test` / `pnpm test:watch`                | Unit tests (run once / watch)                |
| `pnpm test:int`                                | Integration tests (requires Docker)          |
| `pnpm build`                                   | Build the API bundle and the web assets      |
| `pnpm verify`                                  | Everything CI runs, except integration tests |
| `pnpm infra:up` / `infra:down` / `infra:reset` | Start / stop / wipe local databases          |

## Status

Phase 0 (foundation) is in place: workspace tooling, shared contracts, the API platform layer with health checks, the web shell and CI. Authentication, tasks, focus sessions and rooms arrive in later phases; see [`docs/implementation/plan.md`](docs/implementation/plan.md).

## High-level design (v1 reference)

<img width="1929" height="850" alt="ff1" src="https://github.com/user-attachments/assets/5466fec0-ef91-4cc8-8a10-036ba80bd650" />
