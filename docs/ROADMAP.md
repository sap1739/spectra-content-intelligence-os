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
- Strategy entities (personas, pillars, angles, campaigns, briefs, calendar) + UI.
- Citation-placement validation (flag `[n]` markers with no backing source), moderation gate
  before publish, versioned prompt-template registry, async generation via worker + streaming.
- Media pipeline: sharp image ops → ffmpeg audio/video → sandboxed HTML-to-image →
  (license-permitting) Remotion.
- Full content lifecycle with review/approval flows and audit history.
- Data export + retention jobs.

## Phase 4 — Publishing & Analytics

- Social account connections (OAuth + encrypted vault), starting with the platforms with the
  most tractable APIs (WordPress, LinkedIn, YouTube) then expanding.
- Capability records captured per platform; variant validation; scheduling engine;
  idempotent publish jobs with DLQ + failed-publication surfacing.
- Analytics retrieval feeding trend scoring (`engagementPotential` calibration) and campaign
  reporting. Billing & usage metering.

## Phase 5 — Optimization & Scale

- Continuous optimization loop (performance → recommendation weights per vertical).
- Multi-region/read-replica posture, queue partitioning, cost dashboards.
- Enterprise: SSO/SCIM, advanced retention/compliance packs, client portals.

## Standing invariants across all phases

Honest UI states; provenance on every claim; explainable scores; permission-based authz;
tenant isolation everywhere; no unlicensed data usage; ADR for every significant decision.
