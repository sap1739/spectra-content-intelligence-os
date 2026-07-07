# ADR-0015: Research pipeline v1 — first-party RSS, staged executor, deferred RAG

**Status:** Accepted · **Date:** 2026-07-07 · **Relates to:** ADR-0006, ADR-0010, ADR-0012

## Context

Phase 2's goal is a signed-in user running real research end-to-end without paid providers.
The 22-stage pipeline model, provider ports and scoring engine existed from Phase 1; this
increment had to choose what to make real first and where the executor lives.

## Decision

1. **First real providers are first-party and free**: an RSS/Atom fetcher
   (`FirstPartyRssProvider`, fast-xml-parser) and an HTML extraction provider that always
   runs the prompt-injection scanner. Feed URLs are user-supplied per run; vertical
   trusted/blocked domain lists and keywords steer credibility, filtering and topic tagging.
2. **The executor is a dedicated package** (`@spectra/research-pipeline`), not worker code:
   domain logic stays framework-free and integration-testable in-process (fixture HTTP
   feeds + real Postgres/MinIO), while the worker registers a thin
   `research.run.execute` handler (queue contract in `@spectra/workflow-core` JOB_NAMES).
3. **SSRF containment for user-supplied URLs**: http(s)-only, blocked hostname suffixes,
   private/link-local/metadata IP ranges rejected for both literals and DNS resolutions,
   manual redirect re-validation, timeouts and byte caps. `allowPrivateHosts` exists solely
   for fixture servers in tests. Known limitation: single-resolution TOCTOU rebinding
   window; a pinned-IP dialer is the planned hardening.
4. **Dedup levels**: exact by per-workspace normalized-URL hash (tracking params stripped);
   near-dup by extracted-content hash workspace-wide and normalized-title within a run.
   Duplicate sources are still recorded (provenance) but produce no findings.
5. **Trend scoring goes live** on real signals only: freshness (exponential decay),
   velocity (recent share of a 30-day window), source diversity and credibility feed the
   Phase 1 weighted engine; results (components + explanation, config id/version) persist on
   `trend_candidates` (`topicKey` identity per project). Candidates leave UNVERIFIED only
   with enough distinct sources.
6. **Deferred to the next increment** (they require embeddings/LLM providers): claim
   extraction, citations as rows, evidence packs, topic clustering beyond keywords,
   internal-knowledge retrieval (pgvector adapter), watchlists/alerts, scheduled runs.

## Consequences

- Research quality is bounded by feed content quality — honest and visible in the UI
  (findings show provenance; trends show "why this score").
- Re-delivered jobs are idempotent via the urlHash constraint; runs re-enter safely.
- CI integration tests now require a MinIO service alongside Postgres/Redis.
