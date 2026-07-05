# Research Provider Strategy

**Phase 1 status: no research provider is implemented or called.** The eleven ports in
`@spectra/research-core` define the integration surface; this documents how adapters will be
chosen and governed from Phase 2.

## 1. Principles

1. **Terms-of-service first** — only official APIs and licensed feeds; no ToS-violating
   scraping. Per-source copyright metadata is retained and surfaced.
2. **Multi-provider by kind** — the registry supports several adapters per kind (e.g. two
   web-search vendors) for coverage, cross-checking and failover; provenance records which
   provider produced what.
3. **Tenant-aware quotas** — provider calls meter per tenant; vertical domain lists
   (trusted/blocked) filter at query and result level.
4. **Determinism where possible** — adapters normalize into `DiscoveredSource` /
   `TrendSignal` / `ExtractedContent` contracts immediately; raw responses snapshot to
   storage for reprocessing.

## 2. Candidate landscape (evaluate at Phase 2 start; APIs shift quickly)

| Kind                | Candidate directions                                                       |
| ------------------- | -------------------------------------------------------------------------- |
| web-search          | Brave Search API, Tavily, SerpAPI-class aggregators, Bing alternative APIs |
| news-search         | NewsAPI-class services, GDELT (open), publisher APIs                       |
| trend-signal        | Google Trends (via official surfaces), social listening APIs               |
| rss                 | First-party fetcher (open standard) — likely the first real adapter        |
| community-research  | Reddit API, HN Algolia API (open), Stack Exchange API                      |
| video-research      | YouTube Data API                                                           |
| competitor-research | Composed from web/news/rss + site-change detection                         |
| document-research   | arXiv/Crossref/Semantic Scholar (open APIs)                                |
| internal-knowledge  | First-party (knowledge-core + vector store)                                |
| content-extraction  | First-party: readability-style extraction + language/date detection        |
| fact-verification   | First-party composition (cross-source corroboration) + LLM-assisted checks |

**Build order recommendation:** RSS + content-extraction + internal-knowledge first (all
free/first-party, prove the full pipeline), then one web-search and one news vendor, then
signals.

## 3. Governance

- Every adapter ships: contract tests with recorded fixtures, rate-limit/backoff config,
  cost metering hooks, ToS notes in its README.
- SSRF containment: fetchers resolve against deny-lists (private ranges, cloud metadata
  endpoints), cap redirects and sizes.
- All extracted text passes the injection scanner before any downstream LLM use.
- Provider outages degrade runs to `PARTIALLY_SUCCEEDED` with per-stage stats — never
  silent gaps.
