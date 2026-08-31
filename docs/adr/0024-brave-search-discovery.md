# ADR-0024: Brave Search — live web and news discovery behind the research ports

**Status:** Accepted · **Date:** 2026-08-30 · **Relates to:** ADR-0010, ADR-0015, ADR-0023

## Context

`research-core` declares eleven discovery ports, but only one had an adapter: the first-party
RSS reader (ADR-0015). "Research-first" therefore meant "reads the feeds the operator already
knew about" — the platform could not discover a source the user had not already pointed it at.
That is the single largest gap between the product promise and what it does.

Three candidate vendors were weighed:

- **SerpAPI** scrapes Google/Bing, so coverage matches what users see — but it is the most
  expensive per query and the scraping-of-Google model carries real ToS/legal ambiguity for a
  commercial product.
- **Tavily** is purpose-built for RAG and returns pre-extracted page content, which would fold
  much of content extraction into discovery — but at higher per-query cost, and it means
  trusting a vendor's extraction rather than owning that step and its provenance.
- **Brave** runs its own independent index (not a reseller), exposes separate web and news
  endpoints, and prices transparently with a usable free tier.

## Decision

Add `@spectra/research-brave` implementing the existing `WebSearchProvider` and
`NewsSearchProvider` ports. Nothing in the pipeline learns the vendor's name.

1. **Two providers, one client.** `BraveWebSearchProvider` (`/res/v1/web/search`, count ≤ 20)
   and `BraveNewsSearchProvider` (`/res/v1/news/search`, count ≤ 50) share an HTTP client that
   sends the key as an `X-Subscription-Token` **header** — never a query parameter, which would
   leak it into logs, proxies and referrers.

2. **Env-gated, honestly.** Without `BRAVE_SEARCH_API_KEY` the providers report
   `isConfigured === false`, are **not registered at all**, and throw
   `SearchProviderUnavailableError` if called. A run then uses only the operator's configured
   feeds. A failed request raises `SearchRequestError` — never an empty result set posing as
   "nothing found", which would read as a successful, thorough search that found nothing.

3. **Defensive result mapping.** Brave's news response schema is not fully documented, so both
   the top-level `{results:[]}` and nested `{news:{results:[]}}` envelopes are accepted and
   every optional field is absent-until-proven-present. A result without a usable absolute
   http(s) URL is **dropped**, never repaired by guesswork — a fabricated source URL would
   poison the evidence chain that the whole product rests on.

4. **Timezone correctness.** Brave may return `page_age` without a timezone designator, which
   JavaScript parses as _server-local_ time — silently shifting every source date by the deploy
   region's offset. Bare timestamps are pinned to UTC (this codebase stores UTC everywhere), and
   an unparseable date is omitted rather than defaulted to "now", which would misdate a source.
   Regression-tested across UTC−8 to UTC+14.

5. **One honest capability surface.** `GET /v1/meta/capabilities` (authenticated) reports what
   is actually live in the deployment — generation, retrieval, discovery, credential storage —
   each with a plain-English note. Env var _names_ appear as actionable guidance; no value ever
   does.

## Rationale

- **Independence and legal clarity** — a first-party index avoids the scraping grey area, which
  matters for a product sold to regulated enterprises.
- **Ports, not vendors** — the pipeline resolves by `kind`; swapping or adding a provider is a
  registration change, and multiple providers can coexist per kind.
- **Absent beats inert** — not registering an unconfigured provider means `listByKind()` answers
  "what can run", not "what exists in principle".
- **Failures stay loud** — the alternative (returning `[]` on error) is the most dangerous
  possible behaviour for a research tool: indistinguishable from a thorough search finding nothing.

## Consequences

- Live discovery requires `BRAVE_SEARCH_API_KEY`; without it the platform behaves exactly as
  before and says so.
- Search costs money per query. Query budgeting and usage metering are **not** built yet — a run
  that plans many queries will spend accordingly. This is the main follow-up risk.
- Brave's coarse `freshness` buckets (pd/pw/pm/py) cannot express an arbitrary window; a
  `publishedAfter` is widened to the tightest containing bucket rather than narrowed, so results
  the caller asked for are never silently dropped.
- Discovered URLs are not yet fetched or extracted — wiring search results into the ingest
  pipeline (and the SSRF-guarded fetch that already protects RSS items) is the next increment.
