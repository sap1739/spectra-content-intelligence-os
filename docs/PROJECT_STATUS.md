# SpectraContent Intelligence OS — Project Status

**Snapshot date:** 2026-09-11 · **Branch:** `main`
**Status:** Phases 1–5 complete · Phase 6 in progress (6A, 6B, 6C shipped)

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

| Metric               | Value                                                           |
| -------------------- | --------------------------------------------------------------- |
| Commits              | 31                                                              |
| Packages             | 30                                                              |
| Apps                 | 3 (`api`, `web`, `worker`)                                      |
| TypeScript/TSX lines | ~47,300 (api 12,822 · web 9,935 · worker 531 · packages 24,036) |
| API routes           | 118 across 29 controller files                                  |
| Prisma models        | 42                                                              |
| Migrations           | 25                                                              |
| ADRs                 | 34                                                              |
| Permissions          | 35 (permission-oriented authz; never role-name branching)       |
| Web pages            | 21 (all real — placeholders removed in 6A)                      |

### Packages

```
contracts/        Zod-first domain contracts (single source of truth for types + enums)
config/           Validated env schemas (fail-fast at boot)
database/         Prisma schema, tenant-guard client, migrations, deterministic seed
security/         Permissions, tenant isolation, AES-256-GCM, scrypt, deepRedact
auth/             Principal + token-vault ports (direction only; superseded by apps/api/src/auth)
logging/          pino with mandatory secret redaction
observability/    Correlation IDs (AsyncLocalStorage), health aggregation
telemetry/        Optional OTel tracing, allow-listed span attrs, Prometheus metrics [Phase 6B]
metering/         Usage ledger + versioned cost ESTIMATES               [Phase 5D]
research-core/    11 research ports, provider registry, 23-stage pipeline model
research-pipeline/ Ingest pipeline: feeds + search → one candidate path
research-brave/   Brave Search adapters (web + news), env-gated          [Phase 5B]
trend-core/       Versioned, explainable trend scoring engine
knowledge-core/   Vector store port, chunking, prompt-injection scanner + isolation
ai-core/          12 provider-neutral AI ports
ai-anthropic/     Anthropic adapter for TextGenerationProvider, env-gated
ai-voyage/        Voyage adapter for EmbeddingProvider, env-gated        [Phase 5A]
content-pipeline/ Evidence-grounded drafting with prompt isolation
claim-verification/ Corroboration, contradiction, staleness, eligibility  [Phase 5H]
document-extract/ PDF/DOCX/TXT extraction with citation anchors           [Phase 5G]
media-core/       Rendering ports (image/video/audio/subtitles)
media-sharp/      Real sharp ImageRenderer adapter
social-core/      SocialPublisher + PostPublisher + account-discovery ports, capability matrix
social-oauth/     Provider-neutral OAuth broker: state, PKCE, tokens, sealed bundles [Phase 6C]
social-wordpress/ Real WordPress adapter (REST + application password)   [Phase 4D]
publishing/       Dispatch machinery + per-account publisher resolution
workflow-core/    Queue-neutral job ports; BullMQ + in-memory adapters; queue inspector
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

### Phase 5 — Research depth and cost control

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
- **5H:** **Claim verification.** Corroboration counts independent sources (syndicated copies
  collapse to one), claims cluster by asserted content, contradictions are detected and surfaced
  for human decision rather than auto-resolved, time-sensitive claims decay, and every claim gets
  an explicit eligibility decision with a reason. Packs carry only usable claims; the prompt states
  how strong each is. Append-only human review with mandatory notes (ADR-0032).
- **5G:** **Document extraction.** PDF/DOCX/TXT/Markdown become anchored evidence via a
  `DocumentExtractionProvider` port (`@spectra/document-extract`, using pdf.js + mammoth).
  Page/section/line citation anchors, MIME + size limits enforced before parsing, mandatory
  prompt-injection scanning of extracted text, and typed failure codes surfaced in the UI. No OCR:
  a scanned PDF fails honestly rather than producing guessed text (ADR-0031).
- **5F:** **Research quality hardening.** robots.txt is consulted before every discovered-page
  fetch (disallowed pages are never fetched, kept snippet-only with the site's own rule as the
  reason; an unretrievable robots.txt records `UNAVAILABLE`, never `ALLOWED`). Snippet-only
  evidence is down-weighted in trend scoring, ranked below fully-retrieved sources in generation,
  and badged in the UI — weaker, but still eligible. Configurable freshness decay with staleness
  labels and evergreen domains. Layered domain credibility (workspace policy → vertical lists →
  neutral) where BLOCKED beats TRUSTED and blocked domains can never be evidence. Syndication no
  longer inflates source diversity. Runs report what they could not do (ADR-0030).
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

### Phase 6 — Product completeness and operations (in progress)

- **6A:** **UI gaps and frontend test foundation.** Removed the three stale placeholder pages that
  claimed already-shipped capabilities were future work (Brands had a five-route CRUD API since
  Phase 2 while its page said "arrives in Phase 2") and deleted the `PlaceholderPage` component.
  Fixed a standing violation of the project's own rule — the UI branched on ROLE NAMES — by
  returning server-resolved `effectivePermissions` from `/auth/me`. Added the missing web unit test
  framework (Vitest + RTL) and expanded Playwright from 5 smoke tests to 18 journeys.
- **6B:** **Observability, DLQ and operations.** A new `/operations` page lists this workspace's
  failed and dead-lettered jobs with reason and correlation id, and retries them under a separate
  `ops:retry` permission. **Retry re-runs the original job**, so its idempotency key holds and
  budget pre-flight runs again — retry cannot be used to bypass a limit or duplicate a publish.
  Tracing is OpenTelemetry over OTLP and fully optional: with no endpoint the SDK is never loaded
  and each service logs why. Span attributes are an **allow-list**, not a deny-list, because traces
  leave the process for a third party and a deny-list fails open. First-party Prometheus metrics at
  `GET /v1/meta/metrics` cover API latency/errors, worker job duration/failures, queue depth,
  provider latency, run and publish durations and budget refusals — cardinality-capped, labelled by
  route PATTERN, and with unreadable gauges OMITTED rather than reported as 0. Readiness gained
  optional `job-queue` and `object-storage` indicators, so a stalled queue degrades the service
  instead of pulling it out of the load balancer. Log redaction widened to header casings,
  credential shapes, model input/output and extracted document text (ADR-0033).
- **6C:** **OAuth token brokering foundation.** One provider-neutral broker
  (`@spectra/social-oauth`) runs the authorization-code flow for LinkedIn, Facebook Pages,
  Instagram, Threads, YouTube, TikTok, X and Pinterest from declared, env-overridable endpoint
  definitions — replacing a Phase 1 port that would have put OAuth in every adapter. State is
  256-bit, stored only as a hash, single-use (consumed atomically), time-limited and bound to the
  user who started the flow, closing login CSRF; PKCE S256 wherever the platform accepts it. The
  redirect URI is computed, the return path allow-listed, and the callback answers every outcome
  with a redirect carrying one fixed code — provider text is never reflected. Flows are refused
  **before consent** when tokens could not be stored; access and refresh tokens are sealed as one
  bundle; refresh re-seals under the active key; a configurable key ring
  (`SOCIAL_TOKEN_ENCRYPTION_KEY_ID` / `_RETIRED_KEYS`) turns key rotation into a runbook. A
  connection (the grant) is separate from an account (the destination), with identity /
  destination / capability discovery ports between them — none registered, so connections
  honestly record discovery as not available. Disconnect asks the platform to revoke where it can,
  reports whether it did, and purges the credential regardless. **No OAuth platform can publish
  yet**; every platform card and connection says so (ADR-0034).

---

## 6. Integration status (what is actually live)

| Integration                                                                                | Status                                                                    | Gate                                                                                       |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Anthropic (text generation)                                                                | **Real, working**                                                         | `ANTHROPIC_API_KEY`                                                                        |
| Voyage (embeddings)                                                                        | **Real, working**                                                         | `VOYAGE_API_KEY`                                                                           |
| Brave (web + news search)                                                                  | **Real, working**                                                         | `BRAVE_SEARCH_API_KEY`                                                                     |
| WordPress (publishing)                                                                     | **Real, working**                                                         | Per-account credential + `SOCIAL_TOKEN_ENCRYPTION_KEY`                                     |
| sharp (image rendering)                                                                    | **Real, working**                                                         | none (local)                                                                               |
| PostgreSQL / Redis / MinIO                                                                 | **Real, working**                                                         | docker-compose                                                                             |
| RSS/Atom ingestion                                                                         | **Real, working** (first-party parser)                                    | none                                                                                       |
| OAuth connect: LinkedIn, Facebook Pages, Instagram, Threads, YouTube, TikTok, X, Pinterest | **Real flow, when configured** (6C) — not yet run against a live platform | `SOCIAL_OAUTH_<PLATFORM>_CLIENT_ID/SECRET` + redirect base + `SOCIAL_TOKEN_ENCRYPTION_KEY` |
| Publishing to those eight platforms, and Email                                             | **NOT wired**                                                             | resolves `UNSUPPORTED`                                                                     |
| External engagement analytics                                                              | **Not built**                                                             | reports `externalAvailable: false`                                                         |
| Payments / billing / plans                                                                 | **Not built**                                                             | usage page states nothing is charged                                                       |
| OpenTelemetry tracing                                                                      | **Real, optional**                                                        | `OTEL_EXPORTER_OTLP_ENDPOINT` (unset => SDK not loaded)                                    |
| Prometheus metrics                                                                         | **Real, working**                                                         | `GET /v1/meta/metrics` (API series only — see below)                                       |

**Note on metrics:** provider-latency, research-run and publish-attempt series are emitted from
the pipeline packages, which run on the **worker** — and the worker does not expose a scrape
endpoint yet, so only the API's own series are scrapable today. A worker metrics listener is the
next observability increment.

**Note on OAuth (6C):** the flow is exercised end to end against a real HTTP server acting as the
platform — it issues single-use codes, verifies the PKCE verifier, checks client authentication and
rotates refresh tokens. It has **not** been run against a real platform's production endpoints (no
platform credentials exist in this environment). Endpoint definitions are declared from public
documentation, dated, and overridable per deployment; the first live adapter must re-verify its
platform's definition.

**Note on WordPress:** the adapter targets **self-hosted WordPress** (WordPress.org software with
application passwords, WP 5.6+). WordPress.com (the hosted service) is _not_ supported — it
requires OAuth; the OAuth broker exists since 6C, but WordPress.com is not one of its declared
platforms.

---

## 7. Quality gate (current, verified)

| Check                | Result                                                 |
| -------------------- | ------------------------------------------------------ |
| `pnpm build`         | 33/33 tasks pass                                       |
| `pnpm typecheck`     | 61/61 tasks pass                                       |
| `pnpm lint`          | pass                                                   |
| `pnpm format`        | clean                                                  |
| Unit tests           | **550 passing** across 28 packages/apps (incl. web 31) |
| API integration      | **136 passing** (17 files)                             |
| Pipeline integration | **95 passing** (11 files, `research-pipeline`)         |
| Metering integration | **74 passing** (7 files)                               |
| E2E (Playwright)     | **28 tests** (stubbed-API UI journeys)                 |
| Prisma               | schema valid · 25 migrations · database up to date     |

Known flake (pre-existing, not introduced by 6B/6C): `budget-hardening.spec.ts` "concurrent
research-run starts cannot all pass the last allowance" intermittently admits more than one run. It
passed in the 6C gate run; the investigation is tracked separately.

---

## 8. What is pending

### 8.1 Immediate next candidates (highest value)

1. **First OAuth publishing adapter** (X or LinkedIn). The broker, sealed storage, refresh,
   revocation and the `resolvePublisher` seam are in place (6C): an adapter implements the discovery
   ports and a `PostPublisher` and registers them. It must re-verify its platform's declared
   endpoints against the live API.
2. **Live `AnalyticsProvider` adapters** feeding real engagement metrics, which would also
   calibrate the `engagementPotential` input to trend scoring.

### 8.2 Research/quality track

- ~~Content extraction for non-HTML sources~~ — **shipped in 5G** (PDF/DOCX/TXT/Markdown with
  citation anchors; scanned PDFs fail `NO_TEXT_LAYER` rather than guessing).
- ~~Fact verification / claim corroboration across sources~~ — **shipped in 5H**.
- ~~Down-weight `snippetOnly` evidence~~ — **shipped in 5F**.
- ~~`robots.txt` compliance~~ — **shipped in 5F**.
- Anchor-aware citation selection: attach 5G document anchors per claim, so a citation reads
  "p. 12" rather than naming a whole document.
- Hybrid retrieval tuning + reranking.
- Review-queue prioritisation and bulk actions for contradicted claims.
- A DomainPolicy management UI; uploaded-document ingestion (today documents arrive only via
  discovery).

### 8.3 Product surface gaps

- ~~3 stale placeholder pages~~ — **fixed in 6A**; `PlaceholderPage` deleted so the pattern cannot
  return. Previously:
  - `brands` — claims "arrives in Phase 2"; **a full 5-route CRUD API already exists**. Pure UI gap.
  - `settings` — claims "Phase 2"; workspace/org settings not editable in UI.
  - `templates` — claims "Phase 3"; prompt/visual templates never built.
- ~~Publishing DLQ / failed-attempt dashboard~~ — **shipped in 6B** as the workspace-scoped
  `/operations` page (failed + dead-lettered jobs, reasons, correlation ids, safe retry).
- Per-attempt publication history table (the queue shows the current failure, not the attempt
  history).
- A metrics scrape endpoint on the worker — pipeline series are emitted there but not scrapable.
- OAuth follow-ups (6C): a background refresh sweep ahead of token expiry; a bulk re-seal job for
  key rotation (today rotation advances on write); Meta's long-lived token and per-Page token
  exchange; revocation is unavailable for LinkedIn and the Meta family (users are told to revoke in
  the platform's settings).

### 8.4 Engineering debt

- ~~E2E coverage is very thin~~ — 28 Playwright journeys now (6A–6C); still one spec file, against a
  stubbed API.
- ~~Zero web unit tests~~ — 31 now (6A, 6C); coverage is concentrated on a few pages.
- Rate table in `@spectra/metering` is hand-maintained list pricing; will drift from vendor
  pricing. `RATE_VERSION` makes drift visible but does not fix it.
- Usage ledger writes are best-effort (failures swallowed so metering never breaks metered work),
  so it is an operational signal, not an audit-grade financial record.
- Discovery page fetches are sequential; no concurrency control.
- ~~No OpenTelemetry tracing/metrics~~ — **shipped in 6B**.

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
  then `prisma migrate deploy`. It worked normally for the 6C migration, so the failure is
  intermittent.
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
- API readiness (Postgres · Redis · worker heartbeat · job queue · object storage):
  http://localhost:4000/health/ready
- API metrics (Prometheus exposition): http://localhost:4000/v1/meta/metrics
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
