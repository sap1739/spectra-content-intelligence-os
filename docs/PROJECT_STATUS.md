# SpectraContent Intelligence OS — Project Status

**Snapshot date:** 2026-09-09 · **Branch:** `main`
**Status:** Phases 1–4 complete · Phase 5 in progress (5A–5E.2 shipped)

> This document is a factual, audited snapshot intended as context for planning further work.
> Every number below was measured from the repository, not estimated.

---

## 1. What this product is

A multi-tenant B2B/B2C SaaS platform for **research-first content intelligence**: it researches a
domain, validates and stores evidence, detects and scores trends, generates evidence-grounded
content with citations, routes it through human review/approval, schedules it, publishes it to
external platforms, and reports on it.

It is built around two distinguishing ideas:

1. **User-defined custom verticals** — the operator defines their own domain (keywords, trusted
   domains, exclusions), rather than choosing from fixed categories.
2. **Evidence-backed content** — generated content is grounded in stored, cited, snapshotted
   sources. Citations are first-class rows with immutable snapshots, and citation markers are
   validated against the evidence actually supplied to the model.

**Target workflow:**

```
BUSINESS CONTEXT → CUSTOM VERTICAL → RESEARCH → SOURCE VALIDATION → TREND DETECTION
→ TREND SCORING → CONTENT STRATEGY → CAMPAIGN PLAN → MULTIMEDIA GENERATION → HUMAN REVIEW
→ APPROVAL → SCHEDULING → SOCIAL PUBLISHING → ANALYTICS → CONTINUOUS OPTIMIZATION
```

---

## 2. The governing principle: honest capability reporting

This is the single most important constraint in the codebase and it shapes nearly every design
decision. **The system never fabricates data or simulates an integration.** Where a capability is
not configured or not built, it says so explicitly rather than degrading into something that looks
like it worked.

Concrete manifestations already in the code:

| Situation                           | Behaviour                                                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| No `ANTHROPIC_API_KEY`              | Generation returns HTTP 503; drafts record `FAILED`. Never fabricated text.                                     |
| No `VOYAGE_API_KEY`                 | Retrieval falls back to first-party lexical embedding **and the UI says retrieval is lexical, not semantic**.   |
| No `BRAVE_SEARCH_API_KEY`           | Search discovery unavailable; a search-only run plan **fails loudly** rather than completing with zero sources. |
| No `SOCIAL_TOKEN_ENCRYPTION_KEY`    | Credential storage refuses (503); publishing resolves `UNSUPPORTED`.                                            |
| Platform adapter not built          | Publish attempt resolves to terminal `UNSUPPORTED` with a truthful reason — never a fake `PUBLISHED`.           |
| No external analytics connected     | `engagement.externalAvailable: false` + explanatory note. No invented metrics.                                  |
| Provider didn't report token counts | Ledger column stays `NULL`, never `0` (zero would claim "measured, and free").                                  |
| Cost figures                        | Always labelled **estimates** from a versioned local rate table; never presented as invoices.                   |
| Page fetch failed during discovery  | Source kept as snippet, flagged `snippetOnly: true` — never passed off as full article text.                    |

Any future work must preserve this. It is enforced socially (CLAUDE.md) and structurally (tests
assert the honest-degradation paths).

---

## 3. Tech stack

| Layer    | Choice                                                                                |
| -------- | ------------------------------------------------------------------------------------- |
| Monorepo | pnpm workspaces + Turborepo                                                           |
| Language | TypeScript strict everywhere; packages compile `tsc` → `dist/` (CJS + d.ts)           |
| API      | NestJS 11 on Fastify, URI versioning `/v1`, Zod validation pipes, problem+json errors |
| Web      | Next.js 15 App Router, React 19, Tailwind v4, TanStack Query, next-themes             |
| DB       | PostgreSQL 17 + pgvector, Prisma ORM with a tenant-guard client extension             |
| Queue    | BullMQ + Redis behind queue-neutral ports (`JobQueuePort` / `WorkerRuntimePort`)      |
| Storage  | S3-compatible (MinIO locally) with tenant-rooted keys                                 |
| Auth     | First-party session auth, scrypt password hashing                                     |
| Crypto   | AES-256-GCM credential sealing (`@spectra/security`)                                  |
| Testing  | Vitest (unit + API integration via real app + fastify `inject`), Playwright (e2e)     |

**Architectural pattern:** domain logic lives in `packages/*`; `apps/*` are thin framework
adapters. All third-party integrations implement **ports** defined in `research-core`, `ai-core`,
`media-core`, `social-core`, `workflow-core`, `storage`. This is why swapping/adding a provider
never touches pipeline code.

**Async executor pattern:** domain packages export `executeX(deps, input)` functions called by
**both** worker job handlers and integration tests (tests pass `prisma.client` directly). This
gives real end-to-end coverage of worker logic without running a worker.

---

## 4. Current inventory (measured)

| Metric               | Value                                                          |
| -------------------- | -------------------------------------------------------------- |
| Commits              | 22                                                             |
| Packages             | 26                                                             |
| Apps                 | 3 (`api`, `web`, `worker`)                                     |
| TypeScript/TSX lines | ~31,700 (api 7,711 · web 8,888 · worker 425 · packages 14,661) |
| API routes           | 89 across 25 controllers                                       |
| Prisma models        | 32                                                             |
| Migrations           | 16                                                             |
| ADRs                 | 26                                                             |
| Permissions          | 26 (permission-oriented authz; never role-name branching)      |
| Web pages            | 18 (15 real, 3 stale placeholders)                             |

### Packages

```
contracts/        Zod-first domain contracts (single source of truth for types + enums)
config/           Validated env schemas (fail-fast at boot)
database/         Prisma schema, tenant-guard client, migrations, deterministic seed
security/         Permissions, tenant isolation, AES-256-GCM, scrypt, deepRedact
auth/             Principal + token-vault ports (direction only; superseded by apps/api/src/auth)
logging/          pino with mandatory secret redaction
observability/    Correlation IDs (AsyncLocalStorage), health aggregation
metering/         Usage ledger + versioned cost ESTIMATES               [Phase 5D]
research-core/    11 research ports, provider registry, 22-stage pipeline model
research-pipeline/ Ingest pipeline: feeds + search → one candidate path
research-brave/   Brave Search adapters (web + news), env-gated          [Phase 5B]
trend-core/       Versioned, explainable trend scoring engine
knowledge-core/   Vector store port, chunking, prompt-injection scanner + isolation
ai-core/          12 provider-neutral AI ports
ai-anthropic/     Anthropic adapter for TextGenerationProvider, env-gated
ai-voyage/        Voyage adapter for EmbeddingProvider, env-gated        [Phase 5A]
content-pipeline/ Evidence-grounded drafting with prompt isolation
media-core/       Rendering ports (image/video/audio/subtitles)
media-sharp/      Real sharp ImageRenderer adapter
social-core/      SocialPublisher + PostPublisher ports, capability matrix, validation
social-wordpress/ Real WordPress adapter (REST + application password)   [Phase 4D]
publishing/       Dispatch machinery + per-account publisher resolution
workflow-core/    Queue-neutral job ports; BullMQ + in-memory adapters
storage/          Object storage port + S3/MinIO, tenant-scoped keys
testing/          Deterministic, schema-validated factories
ui/               Accessible shadcn-style primitives (Tailwind v4)
```

---

## 5. What has been built, phase by phase

### Phase 1 — Foundation

Monorepo, Zod domain contracts, Prisma schema, app shells, tenancy model
(shared-DB/shared-schema, `organizationId` on every tenant-scoped model), security and testing
standards, health/readiness endpoints, OpenAPI at `/docs`.

### Phase 2 — Identity, research, evidence

- **Identity:** first-party session auth, scrypt credentials, guard chain
  (OriginCheck → Principal → TenantContext → Permissions), permission-oriented authorization,
  organizations/workspaces/memberships, invitations, login throttling.
- **Research pipeline v1:** first-party RSS/Atom provider, staged run executor, source
  snapshotting to object storage, URL + content de-duplication, credibility/freshness scoring,
  findings review workflow.
- **Evidence layer:** extracted claims, citations as first-class rows with immutable snapshots,
  evidence packs, pgvector semantic search, trend watchlists + alerts, scheduled recurring runs.

### Phase 3 — Content generation and lifecycle

- **3A:** Evidence-grounded generation; first paid AI adapter (Anthropic) behind `ai-core`;
  prompt isolation via `wrapUntrustedContent()`; env-gated (503 when unconfigured).
- **3B:** Citation validation (markers checked against supplied evidence; dangling markers
  flagged); async worker-based draft generation.
- **3C:** Strategy entities — campaigns, briefs, personas, content pillars, topic ideas.
- **3D:** Content lifecycle (10 states), human edit history, review/approval records, AI
  moderation gate.
- **3E:** Content calendar and scheduling.
- **3F:** Media pipeline v1 — real `sharp` image rendering (resize/crop/rotate/overlay/format).

### Phase 4 — Publishing and analytics

- **4A:** Publishing foundation — declared capability matrix for 10 platforms (honestly labelled
  "declared, not live-verified"), AES-256-GCM sealed credentials, empty publisher registry.
- **4B:** Publishing pipeline — `ContentScheduleEntry` doubles as publication record with unique
  `idempotencyKey`, attempt tracking, dispatch machinery (recurring claim job + per-entry publish
  job), honest `UNSUPPORTED` terminal state.
- **4C:** Analytics v1 — real first-party reporting (content funnel, drafts, publications,
  research counts) via Prisma aggregates; external engagement explicitly reported unavailable.
- **4D:** **WordPress — first live platform adapter.** Real REST publishing
  (`POST /wp-json/wp/v2/posts`) with application-password Basic auth. Worker decrypts the sealed
  credential and builds a per-account publisher. Genuinely posts to real sites.

### Phase 5 — Research depth and cost control (in progress)

- **5A:** Semantic embeddings via Voyage behind `EmbeddingProvider`; **collection pairing** so
  vectors of different models/dimensions never mix; backfill/re-embed job; honest lexical
  fallback that reports itself as lexical.
- **5B:** Brave web + news search adapters behind the research discovery ports; capabilities
  endpoint (`GET /v1/meta/capabilities`) reporting what this deployment can actually do.
- **5C:** **Search-driven research runs.** RSS items and search results normalize to a single
  `CandidateItem`, so both flow through **one** ingest path (same SSRF guard, dedup, injection
  scan, snapshotting, scoring, embedding). Discovered URLs are fetched through the existing
  `safeFetch`; failed fetches keep the snippet and mark `snippetOnly`. Provenance records the
  _query_ that found a source.
- **5E.2:** **Transactional reservations.** The budget decision and the reservation write are now
  one transaction, serialized by a PostgreSQL advisory lock keyed on `organizationId`, so
  concurrent operations cannot all pass on the last remaining allowance. Verified against real
  PostgreSQL, with the test confirmed to fail when the lock is removed. Also fixed the API layer,
  which was reproducing the same check-then-act race one level up (ADR-0029).
- **5E.1:** **Budget hardening.** Fixed a real defect where the DEFAULT Voyage embedding model
  had no rate entry, making all default embedding spend invisible to ceilings. Unpriced work now
  carries an explicit reason; unknown models from known paid providers are conservatively
  over-priced rather than dropped. Embedding paths (search + re-embed, including per-batch)
  guarded. Added per-operation monthly limits, an optional organization ceiling (stricter scope
  wins), a publishing pre-flight seam, and idempotency-keyed reservations for concurrency
  (ADR-0028).
- **5E:** **Workspace budgets.** Optional monthly ceiling per workspace with `OFF`/`WARN`/`ENFORCE`
  modes, enforced pre-flight (API) and re-checked at execution (worker). `NOT_CONFIGURED` is
  distinct from `OK`; every decision carries `unpricedEvents` so the estimate's incompleteness is
  visible. Refusal is `403 budget-exceeded` (not `402` — nothing charges anyone).
- **5D:** **Usage metering.** Append-only `UsageEvent` ledger for every paid operation
  (generation, embeddings, search, page fetches), tenant-scoped and attributed to the causing
  run/draft. Quantities measured from provider reports; cost is a separate versioned **estimate**.
  `EmbeddingProvider.embed()` now returns `{vectors, usage?}` (Voyage's token count was previously
  parsed and discarded). Per-run page-fetch budget (default 100) that degrades to snippet-only
  rather than aborting. Billing placeholder replaced with a real usage page.

---

## 6. Integration status (what is actually live)

| Integration                                                                  | Status                                     | Gate                                                   |
| ---------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------ |
| Anthropic (text generation)                                                  | **Real, working**                          | `ANTHROPIC_API_KEY`                                    |
| Voyage (embeddings)                                                          | **Real, working**                          | `VOYAGE_API_KEY`                                       |
| Brave (web + news search)                                                    | **Real, working**                          | `BRAVE_SEARCH_API_KEY`                                 |
| WordPress (publishing)                                                       | **Real, working**                          | Per-account credential + `SOCIAL_TOKEN_ENCRYPTION_KEY` |
| sharp (image rendering)                                                      | **Real, working**                          | none (local)                                           |
| PostgreSQL / Redis / MinIO                                                   | **Real, working**                          | docker-compose                                         |
| RSS/Atom ingestion                                                           | **Real, working** (first-party parser)     | none                                                   |
| X, LinkedIn, Facebook, Instagram, TikTok, YouTube, Threads, Pinterest, Email | **Declared capabilities only — NOT wired** | resolve `UNSUPPORTED`                                  |
| External engagement analytics                                                | **Not built**                              | reports `externalAvailable: false`                     |
| Payments / billing / plans                                                   | **Not built**                              | usage page states nothing is charged                   |

**Note on WordPress:** the adapter targets **self-hosted WordPress** (WordPress.org software with
application passwords, WP 5.6+). WordPress.com (the hosted service) is _not_ supported — it
requires OAuth, which is not yet built.

---

## 7. Quality gate (current, verified)

| Check                | Result                             |
| -------------------- | ---------------------------------- |
| `pnpm build`         | 29/29 tasks pass                   |
| `pnpm typecheck`     | 53/53 tasks pass                   |
| `pnpm lint`          | pass                               |
| Unit tests           | **218 passing** across 23 packages |
| API integration      | **65 passing** (12 files)          |
| Pipeline integration | **13 passing** (3 files)           |
| E2E (Playwright)     | 1 spec file only                   |
| Web unit tests       | **0**                              |

---

## 8. What is pending

### 8.1 Immediate next candidates (highest value)

1. **OAuth token brokering** **OAuth token brokering** for the platforms that need it (X, LinkedIn, Facebook/Instagram,
   YouTube, TikTok). The `resolvePublisher` seam already exists — adapters slot in behind it with
   no pipeline change.
2. **Live `AnalyticsProvider` adapters** feeding real engagement metrics, which would also
   calibrate the `engagementPotential` input to trend scoring.

### 8.2 Research/quality track

- Content extraction for non-HTML sources (PDF/document extractor) — currently non-HTML discovered
  URLs fall back to snippet.
- Fact verification / claim corroboration across sources.
- Hybrid retrieval tuning + reranking.
- Down-weight `snippetOnly` evidence in trend scoring and evidence-pack inclusion (currently
  treated equally — flagged in ADR-0025).
- `robots.txt` compliance before fetching discovered pages (acceptable at current low,
  operator-directed volume; must be addressed before higher-volume crawling).

### 8.3 Product surface gaps

- **3 stale placeholder pages** whose backends already exist:
  - `brands` — claims "arrives in Phase 2"; **a full 5-route CRUD API already exists**. Pure UI gap.
  - `settings` — claims "Phase 2"; workspace/org settings not editable in UI.
  - `templates` — claims "Phase 3"; prompt/visual templates never built.
- Publishing DLQ / failed-attempt history dashboard (deferred in ADR-0020).
- Per-attempt publication history table.

### 8.4 Engineering debt

- **E2E coverage is very thin** — 1 spec file for an 18-page app.
- **Zero web unit tests** — all frontend logic is untested.
- Rate table in `@spectra/metering` is hand-maintained list pricing; will drift from vendor
  pricing. `RATE_VERSION` makes drift visible but does not fix it.
- Usage ledger writes are best-effort (failures swallowed so metering never breaks metered work),
  so it is an operational signal, not an audit-grade financial record.
- Discovery page fetches are sequential; no concurrency control.
- No OpenTelemetry tracing/metrics despite `observability` package being "OTel-ready".

### 8.5 Not started at all

- Billing/payments (Stripe or equivalent), plans, invoicing, subscription management.
- Multi-language / i18n.
- Video generation pipeline (ports exist in `media-core`; no adapter).
- Audio/TTS pipeline (ports exist; no adapter).
- Public API / webhooks for customers.
- Mobile / responsive audit.
- Production deployment manifests (only local docker-compose exists).

---

## 9. Non-negotiable conventions for future work

These are enforced by CLAUDE.md and must be honored by any further development:

1. **No fake integrations.** Never claim a provider is wired when it is not. UI keeps honest empty
   states. Never fabricate analytics or trends.
2. **No hard-coded secrets.** All config via validated env (`@spectra/config`). Dev credentials
   only in `.env.example` / docker-compose.
3. **Tenant isolation is absolute.** Every query on tenant-scoped models filters by
   `organizationId` (Prisma tenant-guard throws otherwise). Storage keys are tenant-rooted
   (`org/<id>/ws/<id>/…`). Vector search requires tenant scope. **Missing and foreign resources
   return the same error** (no existence leaks).
4. **Permissions, not roles.** Use `hasPermission()` from `@spectra/security`. Never branch on
   role names.
5. **Lifecycles are enums** in `@spectra/contracts` — never scattered string literals.
6. **UTC everywhere.** Timezones are explicit display-only fields.
7. **Never log** passwords, tokens, keys, payment data, or uploaded document content.
8. **Untrusted content is wrapped** via `wrapUntrustedContent()` and never concatenated into
   instructions.
9. Prisma schema changes require a migration **and** a `docs/DATABASE_DESIGN.md` update.
10. Significant decisions require an ADR in `docs/adr/`.
11. Conventional Commits.

### Known local workarounds

- `prisma migrate dev --create-only` silently fails to create migrations in this repo. Workaround:
  `prisma migrate diff --from-schema-datasource … --to-schema-datamodel … --script > migration.sql`
  then `prisma migrate deploy`.
- API dev server must run on SWC (`node --watch -r @swc-node/register`) — tsx/esbuild cannot emit
  `emitDecoratorMetadata`, which breaks NestJS dependency injection.
- API integration tests that enqueue real jobs race a running dev/docker worker on the same Redis.
  For deterministic executor assertions, set state directly rather than enqueuing.

---

## 10. Running it

```bash
./infrastructure/scripts/bootstrap.sh   # env files, install, docker, migrate, seed
pnpm dev                                # web :3000 · api :4000 · worker
```

- Web: http://localhost:3000 (use `PORT=3001` if 3000 is taken; add the origin to `API_CORS_ORIGIN`)
- API liveness: http://localhost:4000/v1/health/live
- API readiness (Postgres/Redis/worker heartbeat): http://localhost:4000/v1/health/ready
- OpenAPI: http://localhost:4000/docs
- MinIO console: http://localhost:9001

**Demo login (dev only, seeded):** `demo@spectra.local` / `spectra-demo-2026` (ORG_OWNER)

Optional keys unlock real integrations; without them the app runs and honestly reports reduced
capability:

```
ANTHROPIC_API_KEY=            # generation
VOYAGE_API_KEY=               # semantic embeddings
BRAVE_SEARCH_API_KEY=         # web/news discovery
SOCIAL_TOKEN_ENCRYPTION_KEY=  # credential storage + publishing (same value in API and worker)
```
