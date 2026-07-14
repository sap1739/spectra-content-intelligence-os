# SpectraContent Intelligence OS

Research-first content intelligence, multimedia creation, campaign management, scheduling,
publishing and analytics platform for B2B/B2C businesses, agencies, creators and regulated
enterprises — built around **user-defined custom verticals** and **evidence-backed content**.

> **Status: Phase 4 in progress (Phases 1–3 complete).** On top of the identity + research
> foundation: evidence-grounded content generation behind the ai-core port
> (`@spectra/ai-anthropic`, env-gated — no key means honestly unavailable, never fabricated),
> with citation validation, a full content lifecycle (human edits, review/approval, AI
> moderation gate), strategy entities (campaigns, briefs, personas, pillars, topic ideas), a
> content calendar, and real image rendering (`@spectra/media-sharp`). Phase 4 adds the
> publishing foundation — a declared per-platform capability matrix, deterministic content-fit
> validation, and social-target registration with AES-256-GCM sealed credentials. No social
> platform is wired for live posting yet (the UI says so plainly); every number comes from real data.

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
  research-pipeline/ First-party RSS pipeline v1: fetch, snapshot, dedup, score (ADR-0015)
  trend-core/     Versioned, explainable TrendScoringEngine + trend lifecycle
  knowledge-core/ Vector store port, chunking, prompt-injection scanner & isolation
  ai-core/        12 provider-neutral AI interfaces (ports; vendors plug in behind them)
  ai-anthropic/   Anthropic Claude adapter for the TextGenerationProvider port (env-gated; ADR-0017)
  content-pipeline/ Evidence-grounded drafting: prompt isolation + cited draft generation (ADR-0017)
  media-core/     Rendering ports (Sharp/SVG/HTML-to-image/FFmpeg/Remotion/subtitles/audio)
  media-sharp/    Real sharp ImageRenderer adapter (resize/crop/rotate/overlay/format; ADR-0018)
  social-core/    SocialPublisher port + declared capability matrix + variant validation (no platform wired; ADR-0019)
  publishing/     Dispatch machinery: claims due entries, attempts publish → honest UNSUPPORTED (ADR-0020)
  workflow-core/  Queue-neutral job ports; BullMQ + in-memory adapters
  storage/        Object storage port + S3/MinIO impl, tenant-scoped keys, upload validation
  testing/        Deterministic, schema-validated test data factories
  ui/             Accessible shadcn-style primitives (Tailwind CSS v4)
infrastructure/
  docker/         PostgreSQL (pgvector), Redis, MinIO via Docker Compose
  scripts/        bootstrap.sh, verify.sh
docs/             Product, architecture, security and strategy documentation
docs/adr/         21 Architecture Decision Records
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
