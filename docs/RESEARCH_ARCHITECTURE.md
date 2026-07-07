# Research Architecture

Research is the core product capability: everything downstream (trends, strategy, content)
consumes its output. Phase 1 shipped the contracts, ports and pipeline model; **Phase 2
Increment B made the pipeline real** with first-party RSS + extraction providers, queue-
executed runs, snapshots, dedup and live trend scoring (see ADR-0015). Paid/web-search
providers remain unintegrated.

## 1. Provider ports (`@spectra/research-core`)

| Port                         | Purpose                                                |
| ---------------------------- | ------------------------------------------------------ |
| `WebSearchProvider`          | General web discovery                                  |
| `NewsSearchProvider`         | News-specific discovery with recency semantics         |
| `TrendSignalProvider`        | Quantitative signals (search volume, mentions, views)  |
| `RSSProvider`                | Feed ingestion for trusted publications                |
| `CommunityResearchProvider`  | Forums/communities discussion discovery                |
| `VideoResearchProvider`      | Video platform research                                |
| `CompetitorResearchProvider` | Competitor activity monitoring                         |
| `DocumentResearchProvider`   | Academic/report/document discovery                     |
| `InternalKnowledgeProvider`  | Tenant-scoped retrieval from uploaded knowledge        |
| `ContentExtractionProvider`  | Raw capture → clean text + metadata (+ injection scan) |
| `FactVerificationProvider`   | Claim verification against gathered evidence           |

Every adapter exposes `ProviderIdentity` (`id`, `kind`, `displayName`, `isFixture`). Fixture
providers are test-only and must be rejected by production wiring. Adapters are resolved
through `ResearchProviderRegistry` — pipelines never import vendors.

## 2. Pipeline (22 stages, `RESEARCH_PIPELINE_STAGES`)

```
REQUEST_CREATED → QUERY_PLANNING → QUERY_EXPANSION → SOURCE_DISCOVERY → SOURCE_RETRIEVAL
→ CONTENT_EXTRACTION → METADATA_EXTRACTION → LANGUAGE_DETECTION → GEOGRAPHIC_CLASSIFICATION
→ PUBLICATION_DATE_DETECTION → DUPLICATE_DETECTION → NEAR_DUPLICATE_DETECTION
→ TOPIC_CLUSTERING → ENTITY_EXTRACTION → CLAIM_EXTRACTION → CITATION_CAPTURE
→ CREDIBILITY_ASSESSMENT → FRESHNESS_ASSESSMENT → TREND_SCORING → HUMAN_REVIEW
→ EVIDENCE_PACK_GENERATION → KNOWLEDGE_BASE_STORAGE
```

Execution model (Phase 2): each stage is a `PipelineStageHandler` executed as a queued job
(`workflow-core`), advancing `ResearchRun.currentStage` under the forward-only rule
(`canAdvanceStage`). Stages are idempotent and re-enterable; failures mark the run
`FAILED`/`PARTIALLY_SUCCEEDED` with `failureReason`, and stats accumulate in `ResearchRun.stats`.

Stage notes:

- **Query planning/expansion** uses the vertical (keywords, excluded keywords, geographies,
  languages, trusted/blocked domains) and the research objective; every generated
  `ResearchQuery` records its `expansionOfQueryId` lineage.
- **Discovery/retrieval** respects vertical domain lists; retrieval snapshots raw content to
  tenant-scoped object storage (`SourceSnapshot`, immutable, hash-addressed).
- **Duplicate detection**: exact via `urlHash` (unique per workspace) and `contentHash`;
  near-duplicates share `duplicateClusterKey`.
- **Extraction** runs the prompt-injection scanner on all external text (see
  [PROMPT_INJECTION_DEFENCE.md](PROMPT_INJECTION_DEFENCE.md)).
- **Credibility/freshness** produce [0,1] scores stored on sources and findings, with the
  scoring inputs kept for explanation.
- **Human review** gates `PENDING_REVIEW → VALIDATED/REJECTED`; only validated findings feed
  evidence packs by default.

## 3. Data retention per finding

Each `ResearchFinding` retains: source URL/title/publisher/author, publication + retrieval
dates, excerpt + `excerptLocation`, supported claim, confidence, credibility, freshness,
language, geography, duplicate cluster, source category, copyright metadata, provenance
(provider, request ref, pipeline version) and processing status — satisfying the traceability
questions in [CITATION_AND_PROVENANCE.md](CITATION_AND_PROVENANCE.md).

## 4. Scheduling

Recurring research (e.g. "scan this vertical daily") uses `JobQueuePort.schedule` with cron
expressions evaluated in UTC; each occurrence creates a `ResearchRun` with
`trigger: SCHEDULED`.

## 5. Compliance posture

Providers must be used within their terms of service; per-source copyright metadata is
retained; snapshots are stored for verification, not republication. Trusted/blocked domain
lists are user-controlled per vertical. See [RESEARCH_PROVIDER_STRATEGY.md](RESEARCH_PROVIDER_STRATEGY.md).
