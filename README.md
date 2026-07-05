# SpectraContent Intelligence OS

Research-first content intelligence, multimedia creation, campaign management, scheduling,
publishing and analytics platform for B2B/B2C businesses, agencies, creators and regulated
enterprises — built around **user-defined custom verticals** and **evidence-backed content**.

> **Status: Phase 1 — architectural foundation.** The monorepo, domain contracts, database
> schema, API/worker/web foundations, security and testing standards are in place. No research
> provider, AI generation API or social platform is integrated yet, and the UI shows honest
> empty states instead of fabricated data.

## Product workflow (target)

```
BUSINESS CONTEXT → CUSTOM VERTICAL → RESEARCH → SOURCE VALIDATION → TREND DETECTION
→ TREND SCORING → CONTENT STRATEGY → CAMPAIGN PLAN → MULTIMEDIA GENERATION → HUMAN REVIEW
→ APPROVAL → SCHEDULING → SOCIAL PUBLISHING → ANALYTICS → CONTINUOUS OPTIMIZATION
```

## Repository layout

```
apps/
  web/            Next.js 15 App Router shell (dashboard, research/trends, empty states)
  api/            NestJS 11 + Fastify REST API (health, readiness, OpenAPI at /docs)
  worker/         BullMQ worker (heartbeat, retries, dead-letter, graceful shutdown)
packages/
  contracts/      Zod-first domain contracts (research, trends, knowledge, strategy, media, social)
  config/         Validated environment schemas (fail-fast at boot)
  database/       Prisma schema, tenant-guard client, migrations, deterministic seed
  security/       Permission bundles, tenant isolation guards, AES-256-GCM token encryption
  auth/           Principal model + auth/token-vault ports (direction only; no login yet)
  logging/        pino structured logging with mandatory secret redaction
  observability/  Correlation IDs (AsyncLocalStorage), health aggregation
  research-core/  11 provider-neutral research ports, registry, 22-stage pipeline model
  trend-core/     Versioned, explainable TrendScoringEngine + trend lifecycle
  knowledge-core/ Vector store port, chunking, prompt-injection scanner & isolation
  ai-core/        12 AI provider interfaces (contracts only — no paid APIs)
  media-core/     Rendering ports (Sharp/SVG/HTML-to-image/FFmpeg/Remotion/subtitles/audio)
  social-core/    SocialPublisher port + capability guards (no platform integrated)
  workflow-core/  Queue-neutral job ports; BullMQ + in-memory adapters
  storage/        Object storage port + S3/MinIO impl, tenant-scoped keys, upload validation
  testing/        Deterministic, schema-validated test data factories
  ui/             Accessible shadcn-style primitives (Tailwind CSS v4)
infrastructure/
  docker/         PostgreSQL (pgvector), Redis, MinIO via Docker Compose
  scripts/        bootstrap.sh, verify.sh
docs/             Product, architecture, security and strategy documentation
docs/adr/         13 Architecture Decision Records
```

## Quick start

Prerequisites: Node ≥ 22, pnpm ≥ 10, Docker Desktop.

```bash
./infrastructure/scripts/bootstrap.sh   # env files, install, docker, migrate, seed
pnpm dev                                # web :3000 · api :4000 · worker
```

Or step by step:

```bash
cp .env.example .env
cp packages/database/.env.example packages/database/.env
pnpm install
pnpm docker:up        # PostgreSQL + Redis + MinIO
pnpm db:generate
pnpm db:migrate       # dev migration (or db:deploy for CI-style apply)
pnpm db:seed          # demo org/workspace/brand/vertical — no fake research data
pnpm dev
```

Verify:

- Web: http://localhost:3000
- API liveness: http://localhost:4000/health
- API readiness (Postgres/Redis/worker heartbeat): http://localhost:4000/health/ready
- OpenAPI: http://localhost:4000/docs
- MinIO console: http://localhost:9001

## Commands

| Command                 | Purpose                                     |
| ----------------------- | ------------------------------------------- |
| `pnpm dev`              | Run web, API and worker in watch mode       |
| `pnpm build`            | Production build of every package and app   |
| `pnpm lint` / `format`  | ESLint / Prettier across the repo           |
| `pnpm typecheck`        | Strict TypeScript checks everywhere         |
| `pnpm test`             | Unit tests (Vitest)                         |
| `pnpm test:integration` | API integration tests (real app, injected)  |
| `pnpm test:e2e`         | Playwright end-to-end tests (built web app) |
| `pnpm db:generate`      | Prisma client generation                    |
| `pnpm db:migrate`       | Create/apply dev migrations                 |
| `pnpm db:seed`          | Deterministic development seed              |
| `pnpm docker:up/down`   | Start/stop local infrastructure             |
| `pnpm clean`            | Remove build artifacts                      |

## Documentation

Start with [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
[docs/ROADMAP.md](docs/ROADMAP.md). Decisions live in [docs/adr](docs/adr/).

## Engineering standards

TypeScript strict mode everywhere; no unexplained `any`; permission-oriented authorization;
tenant scope on every query, job, storage key and vector search; UTC timestamps with explicit
display timezones; structured logs with mandatory secret redaction; deterministic tests.
Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`,
`docs:`, `chore:`, `refactor:`, `test:`).
