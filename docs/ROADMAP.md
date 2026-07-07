# Roadmap

## Phase 1 — Foundation ✅ (this repository)

Monorepo, contracts, schema, API/worker/web foundations, tenancy + security + observability
standards, testing foundations, CI, documentation, ADRs. No external integrations.

## Phase 2 — Identity & Research (in progress)

**Goal: a signed-in user runs a real research project end-to-end with free/first-party
providers.**

- ✅ Authentication (ADR-0014): first-party sessions (scrypt + Redis), register/login/
  logout/me, org/workspace switching, permission + tenant guards live on every route.
  Remaining: invitations, per-identifier login throttling.
- Tenant hardening: per-tenant rate limits; evaluate enabling Postgres RLS.
- ✅ Vertical management UI + CRUD APIs for verticals, brands, workspaces and research
  projects (tenant-isolated, audit-logged). Remaining: brand/project management screens.
- ✅ Research pipeline v1 (ADR-0015): first-party RSS + extraction providers with SSRF
  containment, snapshots to object storage, injection quarantine, URL/content/title dedup,
  keyword topic tagging, credibility/freshness scoring, queue-executed runs with live
  stage/stats. Remaining: internal-knowledge provider (pgvector + embeddings), claim
  extraction, scheduled/recurring runs.
- New tables: ✅ source_snapshots. Remaining: research_questions/queries,
  extracted_claims, citations, evidence_packs, topic_clusters, documents/chunks.
- ✅ Trend scoring in production: real signals (freshness/velocity/diversity/credibility)
  feed the versioned engine; explainable trend UI with per-component breakdown.
  Remaining: watchlists + alerts, external trend-signal providers.
- ✅ Research/trends screens show real data: project detail with live run progress,
  findings review queue (validate/reject), scored trends.

## Phase 3 — Strategy, Generation & Media

- Strategy entities (personas, pillars, angles, campaigns, briefs, calendar) + UI.
- Text generation via ai-core adapters with evidence-pack grounding, citations rendered in
  drafts, moderation gate; prompt template registry (versioned).
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
