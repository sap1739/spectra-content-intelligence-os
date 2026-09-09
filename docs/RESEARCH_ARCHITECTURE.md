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

## Research quality controls (Phase 5F, ADR-0030)

**robots.txt is consulted before every discovered-page fetch.** `RobotsGateway` fetches, parses
and caches rules per origin. A disallowed page is never fetched — it is kept as snippet-only with
the site's own rule as the reason, and there is no override. When robots.txt cannot be retrieved
the decision is recorded as `UNAVAILABLE`, never `ALLOWED`: we proceed under convention but did
not verify permission. Feed items are `NOT_CHECKED` because the publisher supplied that content
through their own feed.

**Snippet-only sources are weaker evidence, everywhere.** `snippetOnly` is a first-class column
and is applied in trend scoring (weighted component averages plus a discounted effective source
count), in evidence selection for generation (fully-retrieved sources rank first), and in the
API/UI (explicit badge plus the specific reason the page was not retrieved). They remain
_eligible_ — a snippet is real evidence of a source's gist, just not of its full contents.

**Freshness decay is configurable and labelled.** `evaluateFreshness` returns a score and a
`StalenessStatus`. Evergreen domains (standards, legislation, docs) hold a steady score rather
than decaying into invisibility. An undated source is `UNKNOWN` — uncertain, not certainly old.

**Domain credibility is layered:** workspace `DomainPolicy` (with an explicit numeric override and
evergreen flag) beats the vertical's trusted/blocked lists, which beat a neutral default. BLOCKED
beats TRUSTED. Blocked domains are counted and reported rather than silently skipped, and can
never become evidence.

**Fetching is bounded and polite.** `FetchScheduler` caps total in-flight fetches and spaces
requests per host, honouring `Crawl-delay`. Per-run fetch budgets and pre-flight budget
enforcement (ADR-0026/0028/0029) are unchanged and still run before any paid operation.

**Runs report what they could not do**: `robotsBlocked`, `snippetOnly`, `blockedDomainRejected`,
`evidenceEligible` and `duplicateClusters`, plus `GET …/runs/:id/quality` for per-source detail.

## Document extraction (Phase 5G, ADR-0031)

Discovered sources are not always web pages. PDFs, DOCX, TXT and Markdown are extracted into real
text through the `DocumentExtractionProvider` port rather than falling back to a search snippet.

The provider is selected by the served `Content-Type`, falling back to the filename extension —
never by sniffing bytes, which would mean parsing something the source never claimed it was. MIME
and per-type size limits are enforced **before** any parser touches the data.

Extraction runs inside the same discovery path as web pages, so it inherits the SSRF guard,
robots.txt compliance (ADR-0030), per-run fetch budget, per-host throttling and metering
(`DOCUMENT_EXTRACTION`, counter-only). A successfully extracted document is no longer
`snippetOnly`; a failed one keeps the snippet and records a typed failure code.

**No OCR.** A scanned PDF with no text layer fails `NO_TEXT_LAYER` and says OCR was not attempted.
Guessing at image text would manufacture evidence.
