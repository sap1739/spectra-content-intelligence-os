# ADR-0016: Evidence layer v1 — lexical embeddings, heuristic claims, living evidence packs

**Status:** Accepted · **Date:** 2026-07-07 · **Relates to:** ADR-0005, ADR-0011, ADR-0015

## Context

The product promise is defensible content: claims traced to sources, corroboration visible,
knowledge searchable. Doing this "properly" needs neural embeddings and LLM extraction —
both deferred until paid providers arrive (Phase 3). Waiting would leave the entire evidence
plumbing (tables, ports, lineage, UI) unbuilt and unvalidated.

## Decision

Ship the full evidence pipeline now on **deterministic first-party engines**, explicitly
labelled as v1 stand-ins behind the Phase 1 ports:

1. **Embeddings — `HashingEmbeddingProvider`** (knowledge-core): feature-hashing of words +
   character trigrams into 256 dimensions, L2-normalized (FNV-1a). Implements the ai-core
   `EmbeddingProvider` port with a versioned `ModelRef` (`spectra-local/lexical-hash@1.0.0`).
   _Limit (stated in the UI):_ lexical only — no synonymy/semantics. Collections are named
   per model (`lexical-hash-256-v1`), so a neural provider lands as a new collection +
   re-embedding job, never a breaking change (per ADR-0005 §embedding replacement).
2. **Vector store — `PgVectorStore`** (database): pgvector over a `vector(256)` column with
   an HNSW cosine index; hybrid rank = semanticWeight × cosine + keywordWeight × ILIKE hit.
   Tenant scope is compiled into every SQL statement; chunks are deliberately FK-free (raw
   vector table) with explicit tenant deletion (`deleteByTenant`).
3. **Claims — heuristic extraction** (research-pipeline): marker-based sentence selection
   (statistics > predictions > announcements), normalized-key dedupe per project,
   **corroboration = ≥2 distinct sources**, stored as `extracted_claims` rows. LLM
   extraction/verification replaces the heuristics in Phase 3 on the same data model.
4. **Citations** are written per finding at ingest (URL, publisher, dates, excerpt + byte
   locator, snapshot link, optional claim link) — ADR-0011 made operational.
5. **Evidence packs** are living per-topic bundles (`unique(projectId, topicKey)`) refreshed
   by every run, carrying finding/claim/citation ids and forward lineage
   (`usedByContentItemIds`) for Phase 3 generation.
6. **Trend alerts** fire on lifecycle transitions (STATE_CHANGE) and surface in the app's
   notification bell; acknowledge is auditable (who/when).

## Rationale

Every downstream consumer (search API, review UI, pack lineage, Phase 3 generation) codes
against ports and rows that will not change when the engines get smarter. The deterministic
engines are also a testing asset: the full evidence chain is asserted in integration tests
with zero network or model variance.

## Consequences

- Search quality is honest-but-basic (the Intelligence page says so). Recall improves
  strictly by swapping the embedder.
- Heuristic claims can misclassify sentence types; corroboration only asserts "same
  normalized sentence from ≥2 sources", not truth — reviewers keep the final say.
- `document_chunks` cleanup rides tenant-deletion routines, not FK cascades (documented in
  DATABASE_DESIGN.md).
