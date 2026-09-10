# Roadmap

## Phase 1 — Foundation ✅ (this repository)

Monorepo, contracts, schema, API/worker/web foundations, tenancy + security + observability
standards, testing foundations, CI, documentation, ADRs. No external integrations.

## Phase 2 — Identity & Research ✅ COMPLETE

**Goal: a signed-in user runs a real research project end-to-end with free/first-party
providers.**

- ✅ Authentication (ADR-0014): first-party sessions (scrypt + Redis), register/login/
  logout/me, org/workspace switching, permission + tenant guards live on every route,
  ✅ link-based invitations with auto-join on registration, ✅ per-email+IP login
  throttling (429 after 5 failures/15 min).
- Tenant hardening: per-tenant rate limits and Postgres RLS remain deliberate
  deployment-phase hardening items (see SECURITY.md / DEPLOYMENT_STRATEGY.md).
- ✅ Vertical management UI + CRUD APIs for verticals, brands, workspaces and research
  projects (tenant-isolated, audit-logged). Remaining: brand/project management screens.
- ✅ Research pipeline v1 (ADR-0015): first-party RSS + extraction providers with SSRF
  containment, snapshots to object storage, injection quarantine, URL/content/title dedup,
  keyword topic tagging, credibility/freshness scoring, queue-executed runs with live
  stage/stats. ✅ Internal-knowledge retrieval (lexical embeddings + pgvector, ADR-0016),
  heuristic claim extraction with cross-source corroboration, per-finding citations,
  living evidence packs. Remaining: scheduled/recurring runs, neural embeddings + LLM
  claim verification (Phase 3). ✅ Scheduled/recurring runs (per-project cadence via
  queue schedulers with a self-cleaning worker dispatcher).
- New tables: ✅ source_snapshots, extracted_claims, citations, evidence_packs,
  document_chunks (pgvector + HNSW), trend_alerts. Remaining: research_questions/queries,
  topic_clusters, uploaded documents.
- ✅ Trend scoring in production: real signals (freshness/velocity/diversity/credibility)
  feed the versioned engine; explainable trend UI with per-component breakdown.
  ✅ State-change alerts with in-app notification bell + acknowledge. ✅ Watchlists with
  score-threshold alerts. External trend-signal providers move to Phase 4.
- ✅ Research/trends screens show real data: project detail with live run progress,
  findings review queue (validate/reject), scored trends.

## Phase 3 — Strategy, Generation & Media (in progress)

- ✅ **Increment A — cited draft generation.** First paid AI adapter
  (`@spectra/ai-anthropic`) behind the ai-core `TextGenerationProvider` port, env-gated with
  an honest unavailable state (no key → 503, never fabricated text). `@spectra/content-pipeline`
  grounds drafts in evidence packs (findings + citations), separating trusted instructions from
  wrapped untrusted evidence; each `ContentDraft` records the exact grounded citation/finding
  ids plus model + versioned prompt for full provenance. Content Studio UI with the honest
  availability banner (ADR-0017). Schema: `Campaign`, `ContentItem`, `ContentDraft`.
- ✅ **Increment B — generation hardening.** Citation-placement validation flags `[n]`
  markers with no backing source (dangling / fabricated refs surfaced, not trusted);
  generation moved to an async worker executor (honest 503 guards stay synchronous), with
  the Studio polling live and rendering a citation-verification badge.
- ✅ **Increment C — strategy entities.** Campaigns + briefs, audience personas, content
  pillars and topic ideas (traceable to research) — schema + tenant-scoped CRUD API +
  Campaigns and Strategy UIs.
- ✅ **Increment D — content lifecycle & approvals.** Enforced lifecycle transitions
  (`CONTENT_LIFECYCLE_TRANSITIONS`, invalid moves → 422), human edits with an edit history,
  submit → review → approve/request-changes/reject flow with approval records, and a real AI
  moderation gate on approval (FLAGGED blocks approval; honestly recorded as SKIPPED when no
  provider is configured — never a fake pass). Studio workflow controls.
- ✅ **Increment E — content calendar.** Schedule approved content onto a per-platform
  calendar at UTC instants (first scheduling moves APPROVED → SCHEDULED; scheduling a
  non-approved item → 422); calendar list + cancel; timezone-aware Calendar UI.
- ✅ **Increment F — media pipeline v1.** Real image rendering via `@spectra/media-sharp`
  behind the media-core `ImageRenderer` port (resize/crop/rotate/overlay/format), storing
  tenant-rooted derived assets and streaming bytes back through the API; honest capability
  status (image real; video/audio/HTML-to-image reported unavailable until their engines are
  wired). Media UI with upload → resize/convert and an asset library (ADR-0018).
- Remaining in Phase 3: content-angle entities; versioned prompt-template registry; streaming
  generation; ffmpeg audio/video, sandboxed HTML-to-image and (license-permitting) Remotion.
- Data export + retention jobs.

## Phase 4 — Publishing & Analytics (in progress)

- ✅ **Increment A — publishing foundation.** First-party declared `PlatformCapability` matrix
  (`social-core`, honestly labelled not-live-verified) + deterministic `validateVariant`;
  `SocialPublisherRegistry` that is honestly empty (no platform wired); `SocialAccount`
  registration model with `PENDING` targets and AES-256-GCM sealed credentials
  (env-gated on `SOCIAL_TOKEN_ENCRYPTION_KEY`, never returned); real Social Accounts page with an
  honest "live publishing not wired" state and a content-fit checker (ADR-0019).
- ✅ **Increment B — publishing pipeline v1.** The calendar entry doubles as the publication
  record (target account, unique idempotency key, attempt/failure/external fields; +`QUEUED`/
  `PUBLISHING`/`UNSUPPORTED`). `@spectra/publishing` worker executor: a recurring dispatcher
  claims due targeted entries and enqueues publish jobs; with no adapter wired every attempt
  resolves to an honest `UNSUPPORTED`, never a fabricated `PUBLISHED`. `publish-now` API,
  live-polling calendar with status + failure reason (ADR-0020).
- Next: OAuth connection flows (encrypted vault) for the platforms that require them
  (LinkedIn, YouTube, X); a formal DLQ dashboard.
- ✅ **Increment C — analytics v1.** Real first-party workspace reporting (`analytics/overview`):
  content funnel by lifecycle, drafts, publications by dispatch status, research runs/findings/
  packs, trends by state — all real counts. External platform engagement is honestly reported as
  unavailable until an adapter is connected; no metrics are fabricated. Live Analytics page with
  stat tiles, a funnel chart and an honest engagement banner (ADR-0021).
- ✅ **Increment D — WordPress, the first live platform adapter.** Real publishing via the
  WordPress REST API with application-password Basic auth (no OAuth dance): a narrow
  `PostPublisher` port in `social-core`, `@spectra/social-wordpress` doing genuine HTTP
  `POST /wp-json/wp/v2/posts`, and per-account publisher resolution in `executePublication`.
  The worker holds `SOCIAL_TOKEN_ENCRYPTION_KEY`, decrypts the sealed
  `username:application-password` and builds the adapter per account; any missing piece
  (no key, no credential, unwired platform) still degrades to an honest `UNSUPPORTED`.
  API marks WordPress wired + validates credential format; web collects the credential
  (ADR-0022).
- Next: live `AnalyticsProvider` adapters feeding `engagementPotential` trend-score calibration
  and campaign reporting. Billing & usage metering.

## Phase 5 — Optimization & Scale

- Continuous optimization loop (performance → recommendation weights per vertical).
- Multi-region/read-replica posture, queue partitioning, cost dashboards.
- Enterprise: SSO/SCIM, advanced retention/compliance packs, client portals.

## Standing invariants across all phases

Honest UI states; provenance on every claim; explainable scores; permission-based authz;
tenant isolation everywhere; no unlicensed data usage; ADR for every significant decision.

## Phase 5 — Research Depth (in progress)

Phases 1–4 built a broad port surface with one adapter behind each. Phase 5 attacks the
weakest link in the differentiator: research and evidence quality.

- ✅ **Increment A — semantic embeddings.** `@spectra/ai-voyage` behind the ai-core
  `EmbeddingProvider` port (voyage-4, 1024-d default), replacing lexical hashing (ADR-0016)
  as the active retriever when `VOYAGE_API_KEY` is set — with an honest lexical fallback that
  states, in the API response and the UI, that it matches words rather than meaning. The
  pgvector column widened from `vector(256)` to unconstrained `vector` so collections of
  different widths coexist; `resolveEmbedding()` returns provider + collection as one value so
  ingestion and search can never disagree; the port gained query/document asymmetry. A
  `knowledge.reembed` worker job + `POST knowledge/reembed` backfills the active collection
  (idempotent, source collection preserved for instant rollback) and `GET knowledge/status`
  reports real index coverage — switching model can never silently empty search (ADR-0023).
- ✅ **Increment B — live discovery providers.** `@spectra/research-brave` implements the
  `WebSearchProvider` and `NewsSearchProvider` ports against Brave's independent index
  (header-only auth, web/news endpoints, coarse freshness buckets widened rather than narrowed).
  Env-gated on `BRAVE_SEARCH_API_KEY`: unconfigured providers are not registered at all, and a
  request failure raises rather than returning an empty set that would look like a thorough
  search finding nothing. Results without a usable absolute http(s) URL are dropped, never
  guessed; timezone-less dates are pinned to UTC (regression-tested UTC−8…UTC+14).
  `GET /v1/meta/capabilities` reports what is actually live in the deployment (ADR-0024).
- ✅ **Increment C — search-driven research runs.** RSS items and search results normalize to a
  single `CandidateItem`, so both flow through ONE ingest path — same SSRF guard, dedup,
  injection scan, snapshotting, scoring and embedding (two parallel paths would drift, and the
  one that drifts is the one that stops scanning). Discovered URLs are fetched through the
  existing `safeFetch` for real article text; a failed fetch keeps the snippet and marks the
  source `snippetOnly` rather than dropping it or passing it off as the full article. Provenance
  records the _query_ that found a source. A search-only plan with no configured provider fails
  loudly instead of completing with zero sources, and provider errors are recorded rather than
  swallowed. Runs accept `feedUrls` and/or `searchQueries` (ADR-0025).
- ✅ **Increment D — usage metering + per-run budgets.** Every paid provider (Anthropic, Voyage,
  Brave) and every page fetch now writes to an append-only `UsageEvent` ledger, tenant-scoped and
  attributed to the run/draft that caused it. Quantities are MEASURED from what providers report;
  cost is a separate, versioned ESTIMATE from a local rate table and is labelled as such
  everywhere — unreported figures stay NULL (never 0, which would claim "measured and free") and
  unpriced events are counted separately instead of folded in at zero. `EmbeddingProvider.embed()`
  now returns `{vectors, usage?}` so Voyage's token count — previously parsed and discarded — is
  actually captured; usage travels with the result rather than via a stateful accessor that would
  misattribute tokens across concurrent callers. Ledger writes are best-effort: a meter failure
  never breaks the work it measures. Discovery is capped per run (default 100 fetches) and
  degrades to snippet-only past the cap, reporting that it did. The billing placeholder is now a
  real usage page that also states plainly that nothing charges anyone (ADR-0026).
- ✅ **Increment E — per-workspace budgets with pre-flight enforcement.** An optional monthly
  ceiling per workspace (`OFF` / `WARN` / `ENFORCE`), evaluated against summed estimated spend for
  the current UTC calendar month. `NOT_CONFIGURED` is a distinct status — never `OK`, which would
  assert a real ceiling was checked. Every decision carries `unpricedEvents`, so the fact that
  enforcement runs on an _estimate_ (and therefore under-counts) travels with the number instead
  of being dropped. Only `ENFORCE` blocks; `WARN`/`OFF` report the identical breach without
  refusing, so an operator can observe before committing to a hard cap. Enforcement is pre-flight
  (API refuses before creating the row or enqueueing) **and** at execution (the worker re-checks,
  since a job can be queued before the ceiling is hit) — the worker marks the row `FAILED` and
  returns without throwing, because retrying cannot help until the limit is raised. Refusal is
  `403` with a distinct `budget-exceeded` problem type, not `402`, since nothing here charges
  anyone (ADR-0027).
- ✅ **Increment E.1 — budget hardening.** An audit of 5E found the mechanism sound but the
  coverage incomplete, in one case seriously: `voyage-4`, the DEFAULT embedding model, had no
  rate entry, so on a default deployment every embedding priced to `null` and contributed
  **nothing** to any ceiling — a whole paid category invisible while the budget reported itself
  unbreached. Fixed by pricing every default provider, adding a conservative per-provider
  fallback (unknown model from a provider we definitely pay is over-stated, never invisible, and
  labelled), and a regression test that reads defaults from the repo's own config rather than
  hard-coding model names — which is exactly how the defect survived testing. Unpriced work now
  carries an explicit reason (`NO_RATE_FOR_MODEL` / `FREE_LOCAL` / `NOT_VENDOR_BILLED` /
  `NO_MEASURED_QUANTITY` / `COUNTER_ONLY`) so "free" and "unpriced" never collapse into a silent
  zero. Both embedding paths are now guarded — knowledge search before the provider call, and
  re-embed before enqueue _and_ on every batch, since a corpus backfill spends continuously.
  Added per-operation monthly limits (the only bound that works when price is unknown), an
  optional organization ceiling where the stricter of the two scopes wins, a publishing
  pre-flight seam so future paid publishers cannot bypass enforcement, and idempotency-keyed
  reservations so simultaneous pre-flights cannot both pass against the same allowance
  (ADR-0028).
- ✅ **Increment E.2 — transactional budget reservations.** 5E.1 left one hole and named it: two
  pre-flights that read before either writes could both pass. The cause was structural — the
  decision and the hold were separate statements, and a hold is worthless if acquiring it is not
  atomic with the decision to allow it. Both now run in one transaction serialized by a
  PostgreSQL transaction-scoped advisory lock keyed on `organizationId`: advisory because a budget
  row may legitimately not exist while per-kind limits still apply, organization-scoped because
  the org ceiling aggregates across that org's workspaces, and exactly one lock per transaction so
  deadlock is impossible by construction. A blocked decision throws inside the transaction, so no
  orphaned hold is written. The API layer was reproducing the same race one level up
  (`assertPreflight` then a separate `reserve`) and was fixed to reserve-first against a
  pre-minted row id. Settlement is now tenant-scoped and covers success, failure before spend,
  failure after spend, retry, cancellation and crash-then-expiry. Proven against real PostgreSQL:
  10 concurrent reserves against room for one yield exactly one winner — and the test fails
  (7 winners) with the lock removed (ADR-0029).
- ✅ **Increment F — research quality hardening.** The pipeline could ingest broadly but could not
  distinguish well-sourced from thinly-sourced. Now: **robots.txt is consulted before every
  discovered-page fetch** (a disallowed page is never fetched, kept snippet-only with the site's
  own rule as the reason, no override; a robots.txt we cannot retrieve is recorded `UNAVAILABLE`,
  never `ALLOWED`, because proceeding under convention is not the same as having permission).
  **Snippet-only evidence is now visibly weaker**: down-weighted in trend scoring (weighted
  averages plus a discounted effective source count, so snippets alone cannot verify a trend),
  ranked below fully-retrieved sources in generation evidence selection, and badged in the UI —
  but still eligible, because a snippet is real evidence of a source's gist. **Freshness decay is
  configurable and labelled** (`FRESH`/`AGING`/`STALE`/`EVERGREEN`/`UNKNOWN`), with evergreen
  domains held steady and undated sources reported as uncertain rather than old. **Domain
  credibility is layered** (workspace policy with numeric overrides → vertical lists → neutral),
  BLOCKED beats TRUSTED, and blocked domains are counted and reported rather than silently
  dropped. **Syndication no longer inflates diversity** — clusters count once, and URL
  canonicalization was broadened so one article from three channels is one source. Fetching is
  bounded and per-host polite. Runs report what they could NOT do (ADR-0030).
- ✅ **Increment G — document extraction.** PDFs, DOCX, TXT and Markdown discovered by search are
  extracted into real text **with citation anchors** — page for PDF, section for DOCX/Markdown,
  line range for text — behind a new `DocumentExtractionProvider` port. MIME and size limits are
  enforced before any parser sees the bytes; extracted text is prompt-injection scanned exactly
  like scraped web content, because a PDF is not more trustworthy than a web page. Failures are
  returned as typed codes and shown in the UI, so a document source is never silently thin. Scanned
  PDFs fail `NO_TEXT_LAYER` — OCR is deliberately not attempted rather than guessing at image text
  (ADR-0031).
- ✅ **Increment H — claim verification.** Corroboration now counts INDEPENDENT sources: syndicated
  copies of one story collapse to one, so republication cannot manufacture confidence (the same
  correction 5F made for trends, finally applied to claims). Claims cluster by asserted content;
  contradictions — numeric beyond a rounding tolerance, negation, opposite direction — are detected
  and SURFACED for a human decision rather than auto-resolved, because picking a winner
  automatically is how a tool launders a disagreement into a fact. Time-sensitive claims decay from
  their newest support; factual ones do not. Every claim carries an explicit eligibility decision
  with a reason, packs carry only usable claims, generation re-filters on load and tells the model
  how strong each claim is so weak evidence is qualified rather than dropped. Human review is
  append-only with mandatory notes (ADR-0032).
- Next: anchor-aware citation selection (attach 5G document anchors per claim so citations read
  "p. 12" rather than naming a whole document); hybrid retrieval tuning + reranking; a DomainPolicy
  management UI; uploaded-document ingestion; review-queue prioritisation and bulk actions.

## Phase 6 — Product completeness

- ✅ **Increment A — UI gaps and frontend test foundation.** Removed the three stale placeholder
  pages that claimed already-shipped capabilities were future work (Brands had a five-route CRUD
  API since Phase 2 while its page said "arrives in Phase 2"), and deleted the `PlaceholderPage`
  component so the pattern cannot return. Brands is now full CRUD against the real API; Settings
  edits exactly the fields the backend persists — and says plainly why there is no organization
  timezone rather than offering a control that does nothing; Templates reports the one real
  versioned prompt template instead of implying a template store exists. Fixed a standing violation
  of the project's own rule: the UI branched on ROLE NAMES, so `/auth/me` now returns
  server-resolved `effectivePermissions` and the UI checks permissions. Added the missing web unit
  test framework (Vitest + RTL, 16 tests) and expanded Playwright from 5 unauthenticated smoke
  tests to 18 covering login, dashboard, brands, settings, templates, research, usage/budgets,
  publication status, permission-restricted controls and accessibility.
- Next: anchor-aware citation selection (5G anchors per claim); review-queue prioritisation;
  a DomainPolicy management UI; uploaded-document ingestion.
