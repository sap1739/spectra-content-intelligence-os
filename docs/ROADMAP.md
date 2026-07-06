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
- Research pipeline v1 as worker jobs across the 22 stages with: RSS provider,
  content-extraction provider, internal-knowledge provider (pgvector adapter + embeddings
  port), dedup, clustering, claim extraction (structured generation port behind a feature
  flag), credibility/freshness scoring.
- New tables: research_questions, research_queries, source_snapshots, extracted_claims,
  citations, evidence_packs, topic_clusters, documents/chunks.
- Trend scoring in production: signal ingestion, scoring job, explainable trend UI,
  watchlists + alerts.
- Research/trends screens replace empty states with real data; review queues.

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
