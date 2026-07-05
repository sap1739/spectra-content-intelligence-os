# Architecture

## 1. System overview

```
                        ┌──────────────────────────────┐
                        │        apps/web (Next.js)     │
                        │  App Router shell · TanStack  │
                        └──────────────┬───────────────┘
                                       │ REST (problem+json, correlation ids)
                        ┌──────────────▼───────────────┐
                        │      apps/api (NestJS+Fastify)│
                        │ validation · authz · OpenAPI  │
                        └───────┬──────────────┬───────┘
                                │              │ enqueue (workflow-core port)
                     Prisma     │              ▼
                        ┌───────▼──────┐  ┌────────────────┐
                        │  PostgreSQL  │  │ Redis / BullMQ │
                        │  (pgvector)  │  └───────┬────────┘
                        └───────▲──────┘          │ consume
                                │        ┌────────▼────────┐
                                └────────│  apps/worker    │
                                         │ pipelines · jobs │
                                         └────────┬────────┘
                                                  │ storage port
                                         ┌────────▼────────┐
                                         │  MinIO / S3      │
                                         └─────────────────┘
```

Three deployables, seventeen packages. Apps are thin framework adapters; domain logic and
contracts live in packages and are framework-free (dependency inversion).

## 2. Package layering

```
contracts ─────────────► everything (types only, zod)
config, logging, observability ──► apps + adapters
security ──► database, auth, api, worker
database ──► api, worker (Prisma + tenant guard)
research-core / trend-core / knowledge-core / ai-core / media-core / social-core
          ──► worker & api services (ports; adapters arrive in later phases)
workflow-core ──► worker, api (queue-neutral job ports; BullMQ adapter)
storage ──► api, worker (S3/MinIO implementation behind a port)
testing ──► all test suites
ui ──► web
```

Rules:

- `contracts` depends on nothing but zod. Domain packages depend on `contracts`, never on
  each other's internals, never on Nest/Next.
- Vendors are only reachable through ports (`WebSearchProvider`, `SocialPublisher`,
  `JobQueuePort`, `ObjectStorageProvider`, `VectorStoreProvider`, `TextGenerationProvider`…).
- Apps wire ports to adapters at their composition roots.

## 3. Runtime concerns

| Concern          | Mechanism                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Environment      | `@spectra/config` zod schemas; process refuses to boot on invalid env                                                                             |
| Errors           | Typed domain errors → `GlobalExceptionFilter` → RFC 9457 problem+json                                                                             |
| Correlation      | `x-correlation-id` accepted/generated per request; propagated to jobs via `JobEnvelope`                                                           |
| Logging          | pino JSON, ISO UTC timestamps, mandatory redaction paths                                                                                          |
| Health           | `/health` (liveness, dependency-free) · `/health/ready` (Postgres, Redis, worker heartbeat)                                                       |
| Rate limiting    | `@fastify/rate-limit` per-IP now; per-tenant keys when auth lands                                                                                 |
| Jobs             | BullMQ behind `JobQueuePort`/`WorkerRuntimePort`: retries w/ exponential backoff, idempotency keys, DLQ, progress, timeouts, repeatable schedules |
| Multi-tenancy    | Shared DB/schema; `organizationId`+`workspaceId` columns; service-level `assertTenantOwnership`; Prisma tenant-guard extension as a second net    |
| Storage          | Tenant-rooted keys, signed URLs, MIME/size validation, malware-scan port                                                                          |
| Vector retrieval | `VectorStoreProvider` port; pgvector first (extension enabled by migration)                                                                       |

## 4. Technology selections (ADR pointers)

| Area           | Choice                              | ADR                                               |
| -------------- | ----------------------------------- | ------------------------------------------------- |
| Monorepo       | pnpm workspaces + Turborepo         | [0001](adr/0001-monorepo-tooling.md)              |
| Frontend       | Next.js App Router + Tailwind v4    | [0002](adr/0002-frontend-framework.md)            |
| Backend        | NestJS 11 on Fastify                | [0003](adr/0003-backend-framework.md)             |
| Data           | PostgreSQL + Prisma                 | [0004](adr/0004-database-and-orm.md)              |
| Vectors        | pgvector behind a port              | [0005](adr/0005-vector-retrieval.md)              |
| Jobs           | BullMQ now, port for Temporal later | [0006](adr/0006-workflow-engine.md)               |
| Auth           | Session-based direction; Phase 2    | [0007](adr/0007-authentication-direction.md)      |
| Object storage | S3-compatible + MinIO               | [0008](adr/0008-object-storage.md)                |
| Tenancy        | Shared schema, tenant columns       | [0009](adr/0009-multi-tenancy-model.md)           |
| Research       | Provider ports + registry           | [0010](adr/0010-research-provider-abstraction.md) |
| Citations      | First-class rows + snapshots        | [0011](adr/0011-citation-storage.md)              |
| Trend scoring  | Versioned weighted config           | [0012](adr/0012-trend-scoring.md)                 |
| Observability  | pino + correlation ids, OTel-ready  | [0013](adr/0013-observability.md)                 |

## 5. Deployment shape (target)

Web on a Next-compatible host or containers; API and worker as separate containers scaling
independently; managed Postgres (with pgvector), managed Redis, S3-compatible object store.
See [DEPLOYMENT_STRATEGY.md](DEPLOYMENT_STRATEGY.md).
