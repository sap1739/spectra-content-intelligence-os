# Architecture Decision Records

| #                                             | Title                                                     | Status               |
| --------------------------------------------- | --------------------------------------------------------- | -------------------- |
| [0001](0001-monorepo-tooling.md)              | Monorepo with pnpm workspaces + Turborepo                 | Accepted             |
| [0002](0002-frontend-framework.md)            | Next.js App Router frontend                               | Accepted             |
| [0003](0003-backend-framework.md)             | NestJS on Fastify for the API                             | Accepted             |
| [0004](0004-database-and-orm.md)              | PostgreSQL + Prisma ORM                                   | Accepted             |
| [0005](0005-vector-retrieval.md)              | pgvector behind a provider-neutral vector port            | Accepted             |
| [0006](0006-workflow-engine.md)               | BullMQ for Phase 1 behind queue-neutral ports             | Accepted             |
| [0007](0007-authentication-direction.md)      | Session-based auth direction (Auth.js + API verification) | Accepted (direction) |
| [0008](0008-object-storage.md)                | S3-compatible object storage with MinIO locally           | Accepted             |
| [0009](0009-multi-tenancy-model.md)           | Shared-database, shared-schema multi-tenancy              | Accepted             |
| [0010](0010-research-provider-abstraction.md) | Research provider ports + runtime registry                | Accepted             |
| [0011](0011-citation-storage.md)              | Citations as first-class rows with immutable snapshots    | Accepted             |
| [0012](0012-trend-scoring.md)                 | Versioned, configurable, explainable trend scoring        | Accepted             |
| [0013](0013-observability.md)                 | pino + correlation ids, OpenTelemetry-ready               | Accepted             |
| [0014](0014-first-party-session-auth.md)      | First-party session authentication in the API             | Accepted             |
| [0015](0015-research-pipeline-v1.md)          | Research pipeline v1: first-party RSS, staged executor    | Accepted             |
| [0016](0016-evidence-layer-v1.md)             | Evidence layer v1: lexical embeddings, heuristic claims   | Accepted             |
| [0017](0017-evidence-grounded-generation.md)  | Evidence-grounded generation + first paid AI adapter      | Accepted             |

New significant decisions require a new ADR (`NNNN-kebab-title.md`) using the
Context / Decision / Rationale / Consequences structure.
