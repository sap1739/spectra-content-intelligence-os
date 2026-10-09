# SpectraContent Intelligence OS — Project Status

**Snapshot date:** 2026-10-04 · **Branch:** `main`
**Status:** Phases 1–5 complete · Phase 6 complete (6A–6H shipped) · Phase 7 complete (7A–7D shipped) · Phase 8 in progress (8A shipped)

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

| Metric               | Value                                                            |
| -------------------- | ---------------------------------------------------------------- |
| Commits              | 36                                                               |
| Packages             | 39                                                               |
| Apps                 | 3 (`api`, `web`, `worker`)                                       |
| TypeScript/TSX lines | ~80,000 (api 19,100 · web 13,960 · worker 697 · packages 46,123) |
| API routes           | 131 across 29 controller files                                   |
| Prisma models        | 46                                                               |
| Migrations           | 29                                                               |
| ADRs                 | 39                                                               |
| Permissions          | 36 (permission-oriented authz; never role-name branching)        |
| Web pages            | 23 (all real — placeholders removed in 6A)                       |

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
trend-core/       Versioned, explainable trend scoring engine (+ measured engagement signal, 6H)
analytics-core/   AnalyticsProvider port, metric model where unavailable ≠ 0, aggregation [Phase 6H]
analytics-pipeline/ Provider resolver, idempotent sync runs, backoff, read models   [Phase 6H]
knowledge-core/   Vector store port, chunking, prompt-injection scanner + isolation
ai-core/          12 provider-neutral AI ports
ai-anthropic/     Anthropic adapter for TextGenerationProvider, env-gated
ai-voyage/        Voyage adapter for EmbeddingProvider, env-gated        [Phase 5A]
content-pipeline/ Evidence-grounded drafting with prompt isolation
claim-verification/ Corroboration, contradiction, staleness, eligibility  [Phase 5H]
document-extract/ PDF/DOCX/TXT extraction with citation anchors           [Phase 5G]
media-core/       Rendering ports (image/video/audio/subtitles/design)
media-sharp/      Real sharp ImageRenderer + DesignRenderer adapters            [Phase 3/7A]
design-studio/    Template layout model, render planner, raster PDF writer      [Phase 7A]
video-studio/     Storyboard model, render planner, SRT/VTT, FFmpeg arg builder [Phase 7B]
media-ffmpeg/     FFmpeg VideoRenderer: capability probing, progress, cancel   [Phase 7B]
video-pipeline/   Executes one render job: inputs, encode, storage, outcome     [Phase 7B]
audio-core/       Voice consent gate, provider capability, mix planning, FFmpeg args [Phase 7C]
audio-pipeline/   Executes one audio render: consent, mix, waveform, transcript  [Phase 7C]
campaign-orchestration/ Evidence gate, deterministic strategy engine, plan/calendar, run executor [Phase 7D]
billing-core/     Plan catalog, entitlement engine, credit ledger, BillingProvider port [Phase 8A]
billing-stripe/   Stripe adapter: checkout, portal, sync, webhook signature verification [Phase 8A]
social-core/      SocialPublisher + PostPublisher + account-discovery ports, capability matrix
social-oauth/     Provider-neutral OAuth broker: state, PKCE, tokens, sealed bundles [Phase 6C]
social-linkedin/  Real LinkedIn adapter: discovery, Images API, Posts API (text + 1 image) [Phase 6D]
social-meta/      Real Meta adapters: Facebook Pages (text + photo), Instagram (1 JPEG) [Phase 6E]
social-youtube/   Real YouTube adapter: channels + resumable video uploads       [Phase 6F]
social-tiktok/    Real TikTok adapter: creator info + Direct Post video upload    [Phase 6G]
social-x/         Real X adapter: text + up to 4 images (v2 chunked upload)       [Phase 6G]
social-threads/   Real Threads adapter: text or 1 image via a media container     [Phase 6G]
social-pinterest/ Real Pinterest adapter: board discovery + image pins            [Phase 6G]
social-wordpress/ Real WordPress adapter (REST + application password; comment-count analytics) [Phase 4D/6H]
publishing/       Dispatch + resolver (all nine live targets) + media loader/links
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
- **6D:** **LinkedIn — the first live OAuth publisher.** `@spectra/social-linkedin` posts text and
  single-image posts through LinkedIn's official, versioned APIs only (OpenID Connect `userinfo`,
  Organization Access Control, the Images API, the Posts API; `LINKEDIN_API_VERSION`, default
  `202608`). Connecting discovers the member and the pages they can post as (APPROVED
  administrator/content roles only); each account stores a capability snapshot that separates
  "missing permission" from "not implemented", and each connection names the LinkedIn products its
  grant lacks and whether LinkedIn reviews them. Images are registered, uploaded to a checked
  `*.linkedin.com` URL, confirmed where the token may check, and recorded (`social_media_uploads`)
  so a retry reuses them. Scheduling refuses a post LinkedIn would reject, with the reason; the
  executor re-checks and refuses unsupported media as UNSUPPORTED before any request. Every attempt
  records a `failureCode` (reconnect, permission, rate limit, ambiguous…); a 401 marks the
  connection for reconnect and stops later attempts; the worker refreshes a token shortly before
  expiry when LinkedIn issued a refresh token. One resolver (`createPublisherResolver`) now serves
  the worker and the tests. Video, documents, multi-image, articles and polls are declared not
  implemented wherever they could be chosen (ADR-0035).
- **6E:** **Meta — Facebook Pages and Instagram professional accounts.** `@spectra/social-meta`
  publishes text and single-photo posts to Facebook Pages and single-image (JPEG) posts to
  Instagram professional accounts through the Graph API only (`META_GRAPH_API_VERSION`, default
  `v26.0`; `appsecret_proof` on every call). One Facebook connection finds both: the one-hour token
  is exchanged for a long-lived one before anything is stored (a refused exchange stores nothing),
  the grant is read from `/me/permissions`, and each Page's never-expiring token is sealed on its
  own account (Instagram accounts hold their linked Page's). Only an Instagram account Facebook
  reports as the Page's professional account is publishable; the personal profile and settings-only
  Instagram links are listed with the reason under a new `NOT_SUPPORTED` capability status and an
  `UNSUPPORTED_ACCOUNT` failure code. Instagram fetches the image from a 15-minute signed link —
  offered only when storage is internet-reachable — and the media container is recorded on the
  entry (`externalContainerId`) so a retry never publishes twice; the 24-hour allowance is read
  from Instagram before each post. The user token lapsing does not stop publishing; a Page token
  Meta invalidates marks the connection for reconnect, and Reconnect re-seals fresh tokens in place
  (ADR-0036).
- **6F:** **YouTube — resumable video publishing.** `@spectra/social-youtube` uploads a video to a
  channel through the Data API v3 using Google's resumable protocol: a session URI, 256 KiB chunks
  with `Content-Range`, and a resume from the byte YouTube confirms rather than a restart. This
  needed the pipeline's missing half: Spectra renders images but not video, and nothing could
  create a `VIDEO` asset, so a presigned upload path (`POST …/media/uploads` → PUT straight to
  storage → `…/uploads/complete`) now registers a file made elsewhere, recording the size and type
  **object storage** reports rather than the client's claim. Video details (title, description,
  tags, category, privacy, made-for-kids, notify subscribers) live on the entry as
  `publishMetadata`, with an optional custom thumbnail whose refusal is reported without failing
  the video. The resumable session URI is a capability, so it is sealed with the key ring and
  dropped the moment the upload ends; `uploadedBytes` drives both the resume and the progress the
  calendar shows. The two limits that decide what an upload really does are never assumed: an
  unaudited API project has its uploads restricted to private viewing (quoted from Google, and
  compared against the privacy YouTube actually applied, reported in a new `publishNote`), and an
  exhausted allowance is a new `QUOTA` failure code carrying Google's own reason (ADR-0037).
- **6G:** **TikTok, X, Threads, Pinterest — and a decision about email.** Four more adapters, each
  publishing only what its official API allows. **TikTok** Direct Post: every publish first asks
  `creator_info` what that creator permits (TikTok requires it), refuses a privacy level not on
  that list, keeps an interaction the creator disabled disabled, uploads the video in TikTok's
  5–64 MB chunks against a signed URL sealed like any other capability, and records the
  `publish_id` so a retry asks TikTok what happened instead of posting again. Its audit rule is
  quoted wherever it matters: "All content posted by unaudited clients will be restricted to
  private viewing mode." **X:** text and up to four images through the v2 chunked media upload,
  attaching an image only once X reports it processed; the pay-per-usage cost and an access/plan
  refusal are reported as exactly that, and the 280-character cap is labelled as _Spectra's_
  because X's reference states none. **Threads:** text or one image through a media container,
  waiting the ~30 seconds Meta recommends, with the container id recorded so a retry publishes that
  one rather than making another, and Meta's "your account and your app's tester accounts" limit
  stated before anyone connects. **Pinterest:** boards are the destinations and the account itself
  is recorded as somewhere you cannot pin; a pin carries a title, description, alt text and link,
  and because Pinterest documents no formats, sizes or text limits, none are invented — its own 403
  ("The Pin's image is too small, too large or is broken") is passed through. **Email was
  deliberately not integrated:** consent records, unsubscribe handling, suppression lists and
  domain authentication come first, so EMAIL stays unwired and the docs say why. Two small
  extensions let the four fit the existing pipeline: a shared `openConnection` in the resolver
  (connection, account kind, required scopes, refresh) and `subjectId` in discovery, since TikTok
  names a creator only in its token response (ADR-0038).
- **6H:** **External analytics — ingested where platforms really report them, and unavailable is
  never zero.** A provider-neutral model (`@spectra/contracts/analytics.ts`) where every metric is a
  value **or** a reason: `null` always carries one of 20 `AnalyticsUnavailableReason`s, enforced by
  the schema, by every adapter (`finalizeMetrics`) and by two Postgres `CHECK` constraints. Each value
  keeps the platform's own field name and a completeness label (`EXACT`, `APPROXIMATE` when the
  platform says so, `DERIVED` for Spectra's engagement rate, which is computed only with a reported
  denominator). Four adapters beside their publishers: **WordPress** (approved comment counts — core
  records nothing else), **YouTube** (views, likes, comments; watch time, average view duration and
  shares with `yt-analytics.readonly`; channel views and rounded subscribers), **LinkedIn** (page share
  statistics with `rw_organization_admin`; member post analytics with `r_member_postAnalytics`), and
  **Meta** (Page and Instagram followers; post insights with `read_insights` /
  `instagram_manage_insights`, impressions reported as deprecated). TikTok, X, Threads and Pinterest
  are explicitly `NOT_IMPLEMENTED` with what each would take; email is `UNSUPPORTED`. Analytics scopes
  are not added to defaults — missing ones are named per metric and never requested. Sync runs
  (`@spectra/analytics-pipeline`) are idempotent (Idempotency-Key, active-run join, per-target
  snapshot keys), budget-checked on a new `ANALYTICS_SYNC` kind, stop calling an account after a
  rate limit or rejected token, retry with backoff, and finish `SUCCEEDED`, `PARTIAL`, `FAILED` or
  the honest no-op `UNAVAILABLE`; scheduled sync exists but is off by default. Eleven API routes and a
  rebuilt Analytics page separate first-party from platform numbers, show freshness everywhere, name
  missing scopes, warn on partial data, gate sync on the new `analytics:sync` permission, and draw no
  charts. Trend scoring gained `measuredEngagement` (EXTERNAL_MEASURED) beside the estimated
  `engagementPotential`; with no measured posts the signal is recorded as unavailable and the
  research score is unchanged (ADR-0039).
- **7A:** **Visual template and design studio — real pixels, no generated imagery.** A flyer, a
  poster, a carousel, a social image and a YouTube thumbnail are now produced by this codebase:
  `SharpDesignRenderer` composites with libvips, draws Spectra's own rectangles through librsvg and
  lays out text with Pango (word wrapping, real font metrics, uploaded TTF/OTF brand fonts). **No
  image-generation API is wired**, and the capability response and the UI say so — the studio
  arranges assets the workspace already uploaded. Templates are layout **data** in
  `@spectra/contracts/design.ts` (normalized fractional boxes, brand colour roles, TEXT/IMAGE
  fields, up to 40 layers a page), validated structurally by `validateTemplateLayout`; six built-ins
  ship as code (quote card, announcement, three-page tips carousel, YouTube thumbnail, event flyer,
  product spotlight) and a workspace can copy and edit any of them, with every design keeping a
  snapshot of the layout it was made from. `buildRenderPlan` is pure and deterministic — it resolves
  brand, tokens, fonts and pixel boxes, refuses every invalid field at once, and reports each
  substitution as a named warning. Eleven output sizes (platform presets plus A4/A3/US Letter at
  150 dpi), each stating where its number comes from; YouTube's documented 2 MB thumbnail limit is
  met by stepping JPEG quality down and saying so. PDF export is a dependency-free PDF 1.4 writer
  embedding each page JPEG via `/DCTDecode` — raster, described as raster everywhere. The brand kit
  lives on `Brand` (logo, palette, typography, tagline, visual style, offerings); its assets must be
  in the same workspace, checked on save and again at render, and SVG is refused as a logo. Exports
  are ordinary tenant-rooted `MediaAsset`s under `renders/`, so the calendar, the publishing
  adapters and the media library use them with no new plumbing; they are idempotent by `renderHash`
  and take a `MEDIA_RENDER` budget pre-flight for their page count before any pixel is drawn.
  Designs move DRAFT → IN_REVIEW → APPROVED → PUBLISHED, and the state is load-bearing: submitting
  needs at least one export, the calendar refuses to schedule an export whose design is not
  approved, and a successful publish marks the design published within that tenant only. The
  integration suite proves the rendering by **decoding the stored bytes** — dimensions, format, PDF
  page count, the brand's primary colour at a pixel, the thumbnail under 2 MB (ADR-0040).
- **7B:** **Video rendering — deterministic, local, and honest about the engine it depends on.**
  FFmpeg is the video engine, invoked as a subprocess and **never vendored**: the worker resolves one
  from `FFMPEG_PATH` or `PATH`, exactly as the licence policy required. Because the build varies by
  host, nothing is assumed — `capabilities()` probes `-version`, `-encoders` and `-filters` and
  reports the H.264 encoder it will use (`libx264` → `h264_videotoolbox` → `libopenh264`) plus
  whether text overlays, burned-in captions, crossfades and an audio bed are possible, each `false`
  carrying a named reason. A storyboard needing a missing capability is **refused before a job is
  queued**. Storyboards are composition data in `@spectra/contracts/video.ts`; `buildVideoRenderPlan`
  (pure, deterministic) resolves absolute scene timing, frame-scaled text and caption cues, and
  `buildFfmpegArgs` turns that into an argument **array** — never a shell string, and with no user
  text in the filtergraph (scene text and captions are written to files and referenced by
  `textfile=` / `subtitles=filename=`, which a unit test pins with an injection payload). Rendering
  covers slideshows, vertical shorts, square and 4:5 feed video, 1080p/720p landscape, crossfades,
  intro/outro cards, an audio bed with gain and fade-out, SRT/WebVTT sidecars or burned-in captions,
  Ken-Burns image motion, and a poster frame. It runs as a **worker job**: real progress parsed from
  `-progress`, a wall-clock timeout and a cancellation that **kill** the encoder rather than
  abandoning it, retries, and a `MEDIA_RENDER` budget pre-flight before the job exists. Inputs are
  probed first, because ffmpeg handed a corrupt looped image waits forever — so a bad asset fails in
  a second as `INPUT_UNSUPPORTED` instead of burning the timeout. The `VideoRender` row is the state
  machine: `QUEUED → RUNNING →` exactly one terminal state, where **only SUCCEEDED has an asset** and
  every other carries one of eleven `VideoFailureReason`s with operator-facing text; a finished
  render is skipped on retry, never re-encoded or re-billed. Outputs are ordinary tenant-rooted
  media assets. The integration suite proves it by **decoding the stored bytes** — `ftyp` box, h264,
  1080×1080, duration within a frame of the plan (ADR-0041).
- **7C:** **Audio, voiceover and podcasts — real mixing, no generated voices, and consent that
  bites.** Everything local is genuinely done by ffmpeg: segment mixing with per-segment gain,
  generated silence, a music bed with fades mixed under the speech and cut to it, **EBU R128
  loudness normalization** whose result is **measured back** with `ebur128` rather than assumed,
  waveform pictures, and **audiograms** — completing the foundation 7B left as a port. Everything
  needing a vendor is honestly absent: text-to-speech, speech-to-text, audio generation and music
  generation have **no adapter**, and `resolveAudioCapabilities` distinguishes `NOT_IMPLEMENTED`
  (no adapter), `NOT_CONFIGURED` (one exists, no credentials — the reason names the env vars) and
  `DISABLED` (switched off by policy). A script with spoken segments is refused **before a job is
  queued** with `TTS_NOT_CONFIGURED`; no silence is substituted and no tone is passed off as a
  voice. **Consent is the centre of the phase.** A `CLONED` voice is unusable without a `GRANTED`,
  unexpired, in-scope record; the clock and a `revokedAt` override the stored status so a stale row
  cannot become permission; consent is always time-boxed; and creating a cloned voice **requires
  naming the person** at the schema level. The gate runs three times — in the editor, at queue time,
  and **again in the worker against the database** — so a revocation after queueing stops the
  render. Recording or revoking consent needs the separate `voice:consent` permission and is
  audit-logged with actor, subject, scopes and expiry. Transcripts carry a `source` and are
  `SCRIPT_DERIVED` at best: the words come from the script, the timings from the measured mix, and
  nothing listened to the audio. Host notes are production direction and never reach the file —
  proved by reading the finished MP3's bytes. The render job follows 7B exactly, literally sharing
  its process handling (`runFfmpeg`). Proven by decoding stored bytes: MPEG frames, duration
  matching the script within a frame, a real PNG waveform, and a measured LUFS figure (ADR-0042,
  `docs/VOICE_CONSENT_POLICY.md`).
- **7D:** **Research-backed campaign orchestration — the phase that connects the others.** One
  `CampaignOrchestrationRun` walks research → trends → strategy → plan → calendar → content in eight
  recorded stages, and every artifact carries the evidence it came from. The **strategy engine is
  deterministic and derived**, not generated: objectives from the funnel stages actually covered,
  pillars from the vertical's own keywords (a trend matching none becomes its own pillar rather than
  being silently dropped), personas from workspace records → the vertical's named audiences → a
  **labelled placeholder** that says it is one, platform strategy from the declared capability matrix
  plus whether a connected account can actually publish there, CTAs from a fixed library keyed by
  funnel stage. Versioned `spectra-strategy@1.0.0` so every element traces to a row. The **evidence
  gate** (`assessEvidence`) is the centre: six verdicts map to three fixed actions; independence is
  counted by **publisher**, not by article, so six pieces from one outlet are one source; ineligible
  sources (blocked domains, injection-quarantined pages — ADR-0030) are excluded before anything is
  judged; disagreement outranks everything; and a topic whose claims were never verified is
  `LIMITED`, never `SUPPORTED`, with the reason distinguishing "too few sources" from "no claim has
  been verified". `UNSUPPORTED` **blocks** — and blocked topics stay in the plan with their reason
  rather than disappearing. A cautioned topic carries real instruction into the prompt via
  `additionalGuidance` (hedge, date the claim, attribute to the snippet, present the disagreement),
  so the caution lands in the writing rather than only in metadata. **`PARTIAL` is a first-class
  outcome**: with no text-generation provider the run still produces a real strategy, plan, calendar
  and evidence-linked content items, each marked `GENERATION_UNAVAILABLE` with the reason — never
  `SUCCEEDED`, never `FAILED`; and one failed draft never discards the campaign. `CONTENT_DRAFT`
  budget pre-flight runs before the run row exists, sized by the drafts the run would write;
  `runKey` makes a retry adopt the existing run; cancellation is checked against the database between
  stages. A run **never publishes and never schedules** — drafted items go to `REVIEW` for a person
  (ADR-0043, `docs/CAMPAIGN_ORCHESTRATION.md`).
- **8A:** **Billing, plans, credits and entitlements — and keeping an estimate from ever becoming
  an invoice.** The product has tracked _estimated_ provider spend since 5D; 8A puts real money
  beside it, so the whole phase is arranged around three numbers with three authorities that are
  never merged: **estimated spend** (Spectra's rate table, refused by a budget at `403`),
  **entitlements** (the plan, refused at **`402`** — a budget is an operator's own ceiling where
  nobody is billed, while a plan limit is resolved by paying), and **invoices** (Stripe's alone; no
  billing endpoint returns a field that could read as money owed, asserted structurally by a test).
  Ten entitlement keys in four kinds — `COUNT`, `PERIOD`, `BYTES` and the inverted `INTERVAL`,
  where a _lower_ analytics-sync gap is the better plan, declared on the definition rather than
  left to each call site. **Unconfigured billing is the free plan, never unlimited**: the engine
  has no "allow" fallback, the free plan ships in the catalog and is seeded everywhere so the
  fallback always exists, and `PAST_DUE` keeps its plan on purpose because dunning belongs to the
  provider. Webhook signature verification is **written out rather than imported** — HMAC over the
  **raw bytes**, constant-time comparison, a timestamp tolerance checked in both directions, and
  **every** `v1` signature tried so a secret rotation does not break — which required declining
  Nest's own JSON parser and registering a raw-body parser scoped to the webhook path alone.
  Idempotency is a unique `(mode, providerEventId)` constraint, so a provider redelivery cannot
  grant a second month of credits. Credits spend **soonest-expiring first** (the monthly allowance
  before anything purchased, because the reverse is unfair), expiry is per grant, the balance is
  **derived rather than cached**, deduction reports a shortfall instead of going negative, and a
  reversal refuses to revive a lapsed grant. Test and live are partitioned by the key's own prefix
  — a live event at a test deployment is stored and ignored. **No payment instrument ever reaches
  Spectra**: card entry is on Stripe's pages and only `cus_…`/`sub_…`/`price_…` are stored.
  Exercised against a local Stripe stand-in that enforces documented request shapes; **nothing has
  been run against Stripe itself** (ADR-0044, `docs/BILLING.md`,
  `docs/BILLING_LIVE_VERIFICATION.md`).

---

## 6. Integration status (what is actually live)

| Integration                                                                                | Status                                                                    | Gate                                                                                                                                      |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic (text generation)                                                                | **Real, working**                                                         | `ANTHROPIC_API_KEY`                                                                                                                       |
| Voyage (embeddings)                                                                        | **Real, working**                                                         | `VOYAGE_API_KEY`                                                                                                                          |
| Brave (web + news search)                                                                  | **Real, working**                                                         | `BRAVE_SEARCH_API_KEY`                                                                                                                    |
| WordPress (publishing)                                                                     | **Real, working**                                                         | Per-account credential + `SOCIAL_TOKEN_ENCRYPTION_KEY`                                                                                    |
| sharp (image rendering)                                                                    | **Real, working**                                                         | none (local)                                                                                                                              |
| Design studio rendering (PNG/JPEG pages, raster PDF) via sharp/libvips + Pango             | **Real, working** — bytes decoded and asserted in the integration suite   | none (local); uploaded TTF/OTF for guaranteed fonts, else the API host's installed fonts                                                  |
| AI image generation                                                                        | **Not built, and not planned here** (ADR-0040)                            | the studio renders the workspace's own assets; no provider to configure                                                                   |
| Video rendering (MP4, captions, poster) via ffmpeg as a subprocess                         | **Real, working when the host has ffmpeg** — bytes decoded in the suite   | `FFMPEG_PATH`/`PATH` + a font file; **no binary is vendored**, and capability is probed and reported per feature (ADR-0041)               |
| Generative video (text-to-video)                                                           | **Not built, and not planned here** (ADR-0041)                            | the engine composes the workspace's own assets; no provider to configure                                                                  |
| Speech-to-text for captions                                                                | **Not built**                                                             | captions are authored in the storyboard; nothing is transcribed                                                                           |
| Audio mixing, EBU R128 normalization, waveforms, audiograms (ffmpeg)                       | **Real, working when the host has ffmpeg** — bytes decoded in the suite   | `FFMPEG_PATH`/`PATH`; loudness is measured back with `ebur128`, not assumed (ADR-0042)                                                    |
| Text-to-speech / voice cloning                                                             | **Not implemented** (ADR-0042) — reported with a reason                   | no adapter exists; a script needing one is refused before a job is queued. Consent gate is already in place for when one is added         |
| Audio and music generation                                                                 | **Not implemented** (ADR-0042) — reported with a reason                   | beds and effects must be uploaded, and must be licensed by the operator                                                                   |
| Campaign orchestration (research → trends → strategy → plan → calendar → content)          | **Real, working** — the strategy engine is deterministic, not generated   | none; runs without an AI key still build everything but the prose, reporting PARTIAL (ADR-0043)                                           |
| AI-generated marketing strategy (personas, pillars invented by a model)                    | **Not built, and not planned here** (ADR-0043)                            | everything is derived from the vertical, the scored trends and the evidence; a persona with nothing behind it is a labelled placeholder   |
| Stripe Billing (checkout, portal, subscription sync, webhooks)                             | **Real — tested against a Stripe stand-in, not yet Stripe itself**        | `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`; unset = billing off and every org on the free plan, limits still enforced (ADR-0044)       |
| Invoices, proration, tax                                                                   | **Not mirrored, by design** (ADR-0044)                                    | Stripe is the only authority on amounts; Spectra mirrors status only, so there is one fewer place for a number to be wrong                |
| PostgreSQL / Redis / MinIO                                                                 | **Real, working**                                                         | docker-compose                                                                                                                            |
| RSS/Atom ingestion                                                                         | **Real, working** (first-party parser)                                    | none                                                                                                                                      |
| OAuth connect: LinkedIn, Facebook Pages, Instagram, Threads, YouTube, TikTok, X, Pinterest | **Real flow, when configured** (6C) — not yet run against a live platform | `SOCIAL_OAUTH_<PLATFORM>_CLIENT_ID/SECRET` + redirect base + `SOCIAL_TOKEN_ENCRYPTION_KEY`                                                |
| LinkedIn (publishing: text + one image, member or page)                                    | **Real — tested against a LinkedIn stand-in, not yet LinkedIn itself**    | LinkedIn connection with `w_member_social` / `w_organization_social` + `SOCIAL_TOKEN_ENCRYPTION_KEY`                                      |
| Facebook Pages (text + one photo) and Instagram professional accounts (one JPEG)           | **Real — tested against a Graph API stand-in, not yet Meta itself**       | Meta (Facebook) connection with App-Reviewed permissions + `SOCIAL_TOKEN_ENCRYPTION_KEY`; Instagram also needs internet-reachable storage |
| YouTube (video upload to a channel, resumable)                                             | **Real — tested against a Data API stand-in, not yet YouTube itself**     | YouTube connection with `youtube.upload` + `SOCIAL_TOKEN_ENCRYPTION_KEY`; a Google project audit decides whether uploads can be public    |
| TikTok (1 video, Direct Post)                                                              | **Real — tested against a Content Posting API stand-in, not yet TikTok**  | TikTok connection with `video.publish`; an unaudited client may only post privately                                                       |
| X (text + up to 4 images)                                                                  | **Real — tested against an X API stand-in, not yet X**                    | X connection with `tweet.write` (+ `media.write` for images) and API access covering writes                                               |
| Threads (text or 1 image)                                                                  | **Real — tested against a Threads API stand-in, not yet Threads**         | Threads connection with `threads_content_publish`; own/tester accounts until advanced access                                              |
| Pinterest (1 image pin on a board)                                                         | **Real — tested against a Pinterest v5 stand-in, not yet Pinterest**      | Pinterest connection with `pins:write`; Trial access until Pinterest reviews the app                                                      |
| Email                                                                                      | **Deliberately not integrated** (ADR-0038)                                | needs consent, unsubscribe, suppression and domain authentication first; resolves `UNSUPPORTED`                                           |
| Publishing through an Instagram Login connection                                           | **NOT wired**                                                             | resolves `UNSUPPORTED`                                                                                                                    |
| External analytics: WordPress (approved comment counts)                                    | **Real — tested against a WordPress REST stand-in, not yet a live site**  | the stored application password                                                                                                           |
| External analytics: YouTube (video + channel statistics; watch time, avg duration, shares) | **Real — tested against Data/Analytics API stand-ins, not yet YouTube**   | `youtube.readonly` (default); `yt-analytics.readonly` for the report metrics                                                              |
| External analytics: LinkedIn (page share statistics; member post analytics)                | **Real — tested against a LinkedIn stand-in, not yet LinkedIn**           | `rw_organization_admin` (page) / `r_member_postAnalytics` (member) — Community Management API, not requested by default                   |
| External analytics: Facebook Pages and Instagram (followers; post insights)                | **Real — tested against a Graph API stand-in, not yet Meta**              | followers with default scopes; `read_insights` / `instagram_manage_insights` (App Review) for post insights                               |
| External analytics: TikTok, X, Threads, Pinterest                                          | **Not implemented** (ADR-0039) — each account reports why                 | resolves `UNAVAILABLE`; X would be billed per call                                                                                        |
| External analytics: Email                                                                  | **Unsupported** — no sending provider                                     | resolves `UNAVAILABLE`                                                                                                                    |
| Payments / billing / plans                                                                 | **Not built**                                                             | usage page states nothing is charged                                                                                                      |
| OpenTelemetry tracing                                                                      | **Real, optional**                                                        | `OTEL_EXPORTER_OTLP_ENDPOINT` (unset => SDK not loaded)                                                                                   |
| Prometheus metrics                                                                         | **Real, working**                                                         | `GET /v1/meta/metrics` (API series only — see below)                                                                                      |

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

**Note on LinkedIn (6D):** the adapter is exercised end to end against a local server that
enforces LinkedIn's documented rules (bearer tokens, per-scope permissions, version headers,
single-use codes, image upload). It has **not** been run against LinkedIn itself — there are no
LinkedIn app credentials in this environment. `docs/LINKEDIN_LIVE_VERIFICATION.md` is the checklist
for the first real run; its largest open question is whether LinkedIn's versioned Posts API accepts
member posts from a self-serve "Share on LinkedIn" app (LinkedIn documents that product with the
legacy `ugcPosts` API).

**Note on Meta (6E):** the adapters are exercised end to end against a local server that enforces
Meta's documented rules (`appsecret_proof`, Page tokens for Page and Instagram writes,
per-permission refusals, single-use codes, the GET token endpoint and the long-lived exchange) and
that fetches Instagram images from the real signed MinIO link. They have **not** been run against
Meta itself. `docs/META_LIVE_VERIFICATION.md` lists the open questions: whether the GET code
exchange accepts the standard `grant_type` parameter Spectra sends, whether
`content_publishing_limit` answers a Page token, and Business-portfolio permission needs.

**Note on YouTube (6F):** the adapter is exercised end to end against a local server that enforces
Google's documented resumable protocol (a session URI, `Content-Range` chunking, 308 with a
`Range`, 201 with the video), scope checks and quota refusals. It has **not** been run against
YouTube itself. `docs/YOUTUBE_LIVE_VERIFICATION.md` is the checklist; its open questions are
whether a channel must be verified to set a custom thumbnail (thumbnails.set does not say so) and
the exact quota cost of an upload, which Google now expresses as a separate uploads bucket. Spectra
caps a media object at 500 MB and holds an upload in memory while sending it, far below YouTube's
256 GB.

**Note on the 6G four (TikTok, X, Threads, Pinterest):** each adapter is exercised against a local
server that enforces what its platform documents — TikTok's creator-info-then-init-then-chunks flow
and its privacy options, Threads' container/publish pair, X's initialize/append/finalize/status
upload and its plan refusals, Pinterest's paged boards and pin creation. **None has been run against
the real platform.** `docs/REMAINING_PLATFORMS_LIVE_VERIFICATION.md` is the checklist, and it names
the two places the documentation is silent: X states no post character limit (Spectra caps at 280
and says the cap is its own) and Pinterest states no image formats, size or text limits (its own
refusal is passed through).

**Note on external analytics (6H):** every adapter is exercised against local stand-ins that follow
the platform's documentation (counts as strings, rounded subscriber counts, omitted-means-zero share
statistics, insights refusals, rate limits). **None has been run against the real platform.**
`docs/ANALYTICS_LIVE_VERIFICATION.md` is the checklist; its open questions include whether LinkedIn
ever returns `uniqueImpressionsCount` per share, how many days YouTube Analytics reports lag the Data
API counts, and how long Instagram insights take to appear (Meta says up to 48 hours). With default
scopes YouTube reads counts only and Meta reads followers only — by design, and the UI names the
scope to add.

**Note on WordPress:** the adapter targets **self-hosted WordPress** (WordPress.org software with
application passwords, WP 5.6+). WordPress.com (the hosted service) is _not_ supported — it
requires OAuth; the OAuth broker exists since 6C, but WordPress.com is not one of its declared
platforms.

---

## 7. Quality gate (current, verified)

| Check                | Result                                                  |
| -------------------- | ------------------------------------------------------- |
| `pnpm build`         | 51/51 tasks pass                                        |
| `pnpm typecheck`     | 97/97 tasks pass                                        |
| `pnpm lint`          | pass                                                    |
| `pnpm format`        | clean                                                   |
| Unit tests           | **1092 passing** across 46 packages/apps (incl. web 48) |
| API integration      | **312 tests**, 27 files — see the flake note below      |
| Pipeline integration | **95 passing** (11 files, `research-pipeline`)          |
| Metering integration | **74 passing** (7 files)                                |
| E2E (Playwright)     | **79 tests** (stubbed-API UI journeys)                  |
| Prisma               | schema valid · 34 migrations · database up to date      |

Known flake 1 (pre-existing, not introduced by 6B–8A): `budget-hardening.spec.ts` "concurrent
research-run starts cannot all pass the last allowance" intermittently admits more than one run. It
appeared in both 8A gate runs. It is not fixed — tracked separately.

Known flake 2 (first recorded in the 7A gate; narrowed in 7B, 7C and 7D). The symptom is a cluster
of failures across unrelated API spec files. Four causes have been found and addressed:

1. **A stale Redis backlog** starving `ops.spec.ts`'s poll and cascading. **Drain
   `bull:spectra-system*` before a gate run, and leave no test jobs behind.**
2. **Unbounded vitest parallelism.** `apps/api/vitest.config.ts` caps `maxWorkers`.
3. **Timeouts tuned for a smaller suite** (7C): `ops.spec.ts`'s job poll 20s → 45s, suite ceilings
   30s → 60s/90s.
4. **The cap itself going stale** (7D): measured at 26 files, 2 workers ran green in ~21s while 3
   failed and 1 was slower still.

Every media and billing phase also fixed a contributor of its own: `video-rendering.spec.ts`,
`audio-podcast.spec.ts` and `campaign-orchestration.spec.ts` stub `QueueService.enqueue` so none
leaves jobs in the shared queue, and `billing.spec.ts` sets its provider env in `setup-env.ts`
rather than a `beforeAll`, because `getApiEnv()` memoizes and vitest reuses a worker across files —
a spec mutating `process.env` later got an unconfigured provider whenever another spec had already
read the env.

What remains: on a loaded machine the API suite is still intermittent. The 8A gate produced
**310/312 and 309/312** across two runs, failing only in `budget-hardening.spec.ts` (flake 1) and
one tenant-isolation test whose setup lost a race. **No failure has occurred in `billing.spec.ts`,
`campaign-orchestration.spec.ts`, `audio-podcast.spec.ts` or `video-rendering.spec.ts`.** The
durable fix is per-suite database and queue isolation, which remains tracked.

-------------------- | ------------------------------------------------------ |
| `pnpm build` | 40/40 tasks pass |
| `pnpm typecheck` | 75/75 tasks pass |
| `pnpm lint` | pass |
| `pnpm format` | clean |
| Unit tests | **838 passing** across 35 packages/apps (incl. web 43) |
| API integration | **196 passing** (21 files) |
| Pipeline integration | **95 passing** (11 files, `research-pipeline`) |
| Metering integration | **74 passing** (7 files) |
| E2E (Playwright) | **34 tests** (stubbed-API UI journeys) |
| Prisma | schema valid · 28 migrations · database up to date |

Known flake (pre-existing, not introduced by 6B–6G): `budget-hardening.spec.ts` "concurrent
research-run starts cannot all pass the last allowance" intermittently admits more than one run. It
failed in the full 6G gate run and again on the first re-run of that file, then passed on the
second; the investigation is tracked separately.

---

## 8. What is pending

### 8.1 Immediate next candidates (highest value)

1. **Run the four live-verification checklists** (`docs/LINKEDIN_LIVE_VERIFICATION.md`,
   `docs/META_LIVE_VERIFICATION.md`, `docs/YOUTUBE_LIVE_VERIFICATION.md`,
   `docs/REMAINING_PLATFORMS_LIVE_VERIFICATION.md`) against real apps: all nine live targets are
   built and tested against stand-ins only, and a real run is now worth more than another adapter.
2. **Run `docs/ANALYTICS_LIVE_VERIFICATION.md`** with the analytics scopes granted, then calibrate
   the trend-scoring engagement reference rate (a 5% constant today) from real distributions.
3. **Analytics for the platforms marked `NOT_IMPLEMENTED`** (TikTok Display API, Threads Insights,
   Pinterest pin analytics; X only with a budget in place, since every call is billed).

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
- Analytics follow-ups (6H): LinkedIn page follower statistics; Facebook comment and share counts;
  daily breakdowns and history charts once enough real snapshots exist; honouring `Retry-After`
  from YouTube, LinkedIn and Meta (their clients do not surface headers yet); a dedicated worker
  metric for sync durations.
- Per-attempt publication history table (the queue shows the current failure, not the attempt
  history).
- A metrics scrape endpoint on the worker — pipeline series are emitted there but not scrapable.
- OAuth follow-ups (6C): a background refresh sweep ahead of token expiry; a bulk re-seal job for
  key rotation (today rotation advances on write); revocation is unavailable for LinkedIn and the Meta family (users are told to revoke in
  the platform's settings).
- LinkedIn follow-ups (6D): video (Videos API, initialize → upload parts → finalize), documents,
  multi-image, articles and polls; mentions; editing and deleting posts; engagement analytics; a
  `ugcPosts` fallback if self-serve apps turn out not to be accepted by the Posts API.
- Meta follow-ups (6E): Facebook video and multi-photo posts; Instagram Reels, stories, carousels
  and video; Facebook photo alt text; the Instagram Login publishing path; insights; a
  public media proxy for deployments whose object storage is private.
- 6G follow-ups: TikTok photo posts and inbox drafts; X video, polls, quotes, threads and replies;
  Threads video and carousels; Pinterest video pins, carousels and board creation; editing or
  deleting a published post anywhere; analytics for these four (6H marks them not implemented). Two open questions belong to a live
  run rather than more code: X's real character limit for a verified account, and what Pinterest
  actually refuses (if that is stable, Spectra can refuse it before the call).
- Email (deliberate, ADR-0038): a subscriber list with provable consent, `List-Unsubscribe` and a
  one-click endpoint honoured before every send, bounce/complaint suppression with its feedback
  loop, and per-workspace sending-domain authentication — then an ESP adapter.
- YouTube follow-ups (6F): streaming the upload instead of holding the file in memory (a media
  object is capped at 500 MB today); captions, playlists, livestreams and community posts; editing
  or deleting a published video; a category picker fed by `videoCategories.list`; polling
  `processingDetails` until YouTube finishes processing.

### 8.4 Engineering debt

- ~~E2E coverage is very thin~~ — 34 Playwright journeys now (6A–6F); still one spec file, against a
  stubbed API.
- ~~Zero web unit tests~~ — 43 now (6A–6F); coverage is concentrated on a few pages.
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
