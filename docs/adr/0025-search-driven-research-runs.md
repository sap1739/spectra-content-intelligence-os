# ADR-0025: Search-driven research runs — one ingest path for feeds and search

**Status:** Accepted · **Date:** 2026-08-31 · **Relates to:** ADR-0015, ADR-0024, ADR-0011

## Context

ADR-0024 added real web/news discovery adapters, but nothing consumed them: a research run
still read only the RSS feeds an operator named. The capability existed and was invisible.

The ingest loop was written around RSS. Its body was already generic — SSRF guard, URL and
content de-duplication, prompt-injection scanning, snapshotting, credibility/freshness scoring,
claim extraction, embedding — but it was reached only through `rss.fetchFeedWithMeta()`, and a
few fields (`publisher`, `category`, provenance) were hard-wired to feed semantics. The obvious
shortcut, a second parallel loop for search results, would have been the wrong move: two ingest
paths drift, and the one that drifts is the one that quietly stops scanning for injection or
stops de-duplicating.

## Decision

Normalize both discovery sources into one shape and keep exactly one ingest path.

1. **`CandidateItem` is the single ingest unit.** `discovery.ts` converts RSS items
   (`candidatesFromFeed`) and search results (`candidatesFromSearch`) into the same record: url,
   title, author, publishedAt, language, publisher, category, the content in hand, provenance,
   and `snippetOnly`. The executor loops over candidates; every guard and every scoring step
   applies identically regardless of origin.

2. **Discovered pages are fetched for real text.** A search result carries only a snippet, which
   is thin evidence. Each discovered URL goes through the existing `safeFetch` — the same SSRF
   defence that already protected feed items (DNS resolution checks, redirect limits, byte caps,
   timeouts). Non-HTML responses are left alone until a document extractor exists.

3. **A failed fetch downgrades, it does not drop.** When the page cannot be retrieved the
   snippet is kept and `snippetOnly: true` is written into the source's provenance, so a finding
   built from a snippet can never be mistaken for one built from the full article. Discarding
   the candidate would lose a real result; silently storing the snippet as though it were the
   article would overstate the evidence.

4. **Provenance records the query.** For search-discovered sources `requestRef` is the query text
   and `providerKind` is `web-search`/`news-search` — the citation chain answers "how did we find
   this?", not just "where is it?".

5. **A search-only plan without a provider fails loudly.** If a run plans queries and no
   discovery provider is registered, and there are no feeds to fall back on, the run fails with
   an actionable message rather than completing with zero sources — which would look like a
   thorough search that found nothing.

6. **Search failures are recorded, never swallowed.** A provider error joins the run's failure
   reasons. A run whose only query errored and ingested nothing reports `FAILED`, not `SUCCEEDED`.

7. **The API takes either or both.** `startResearchRunInput` accepts `feedUrls` and/or
   `searchQueries` (at least one required, enforced by the schema). The research UI takes queries
   alongside feeds and, when live search is unconfigured, shows the capability endpoint's own
   note instead of inviting the user to type a query that cannot run.

## Rationale

- **One path cannot drift** — the alternative duplicates the injection scan, the dedup and the
  scoring, and guarantees they diverge.
- **Snippets are evidence of a source, not evidence for a claim** — labelling them keeps the
  distinction visible downstream instead of burying it.
- **Reusing `safeFetch`** means arbitrary discovered URLs inherit the SSRF posture that was
  already reviewed for feeds, rather than a second, weaker fetch.
- **Loud failure over empty success** — for a research tool the most dangerous outcome is a run
  that looks thorough and returned nothing because a query silently errored.

## Consequences

- Runs can now discover sources the operator never named — the point of "research-first".
- Every discovered URL costs a fetch. Concurrency is currently sequential and there is no
  per-run page budget; both matter once query volume rises, alongside the search-cost metering
  already flagged in ADR-0024.
- `snippetOnly` findings are weaker evidence and are not yet down-weighted in trend scoring or
  excluded from evidence packs — a deliberate follow-up, not an oversight.
- `robots.txt` is not consulted before fetching a discovered page. Acceptable for
  operator-directed research at low volume; revisit before any high-volume crawling.
