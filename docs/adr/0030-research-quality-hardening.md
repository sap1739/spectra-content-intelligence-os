# ADR-0030: Research quality hardening — robots compliance, weaker-evidence honesty, decay and syndication

**Status:** Accepted · **Date:** 2026-09-09 · **Relates to:** ADR-0015, ADR-0025, ADR-0012, ADR-0011

## Context

The pipeline could ingest broadly but could not distinguish _well-sourced_ from _thinly-sourced_.
Four specific problems:

1. **It crawled without asking.** Discovered pages were fetched with no robots.txt check. That is
   impolite at best, and it makes every provenance claim downstream harder to defend.
2. **Snippet-only sources looked identical to fully-retrieved ones.** ADR-0025 recorded
   `snippetOnly` in provenance JSON and explicitly deferred acting on it. A trend supported
   entirely by search snippets scored the same as one supported by articles we actually read.
3. **Age eroded nothing beyond a fixed half-life**, with no notion of evergreen reference
   material and no staleness label.
4. **Syndication inflated confidence.** One wire story republished by ten outlets counted as ten
   distinct publishers, which is precisely the signal `sourceDiversity` is supposed to measure.

## Decision

### 1. robots.txt is consulted before every discovered-page fetch

A `RobotsGateway` fetches, parses and caches robots.txt per origin (shared across tenants — it
describes the remote site, not any workspace, and contains no tenant data). Two rules:

- **A disallowed page is never fetched.** It is kept as snippet-only, with the site's own rule as
  the recorded reason. There is no override: bypassing robots would make the provenance chain
  untrustworthy, which is the one thing this product cannot trade away.
- **"Unavailable" is not "allowed."** When robots.txt cannot be retrieved we proceed under the
  usual convention, but record `UNAVAILABLE`, never `ALLOWED` — we did not verify permission and
  must not claim we did.

Feed items are `NOT_CHECKED`: the publisher supplied that content through their own feed, so no
crawl occurred.

### 2. Snippet-only evidence is weaker everywhere, and visibly so

`snippetOnly` is promoted from provenance JSON to an indexed column, and applied in three places:

- **Trend scoring** — component averages are weighted, snippet-only findings at
  `SNIPPET_ONLY_CONFIDENCE_FACTOR` (0.4). The _effective_ source count is discounted too, so a
  trend supported only by snippets does not reach the verification threshold on volume alone.
- **Evidence selection for generation** — findings are ranked with fully-retrieved sources first;
  snippets fill remaining slots rather than displacing an article we read.
- **API + UI** — an explicit `snippet-only` badge, alongside the specific reason the page was not
  retrieved.

Snippet-only sources stay **eligible**. A snippet is real, attributable evidence of a source's
existence and gist — just weaker. Excluding it would discard genuine findings; treating it as
equal would overstate them.

### 3. Configurable freshness decay with an explicit staleness label

`evaluateFreshness` returns a score _and_ a `StalenessStatus` (`FRESH` / `AGING` / `STALE` /
`EVERGREEN` / `UNKNOWN`), with a configurable half-life, boundaries and floor. Two judgements:

- **Evergreen domains hold a steady score.** Standards, legislation and documentation do not decay,
  and decaying them buries the most authoritative material in a vertical.
- **An undated source scores `UNKNOWN`, not old.** It is uncertain, not certainly stale — so it
  sits below FRESH, above the floor, and carries a label that says why.

### 4. Layered domain credibility

Precedence is workspace `DomainPolicy` → vertical trusted/blocked lists → neutral default. Within
the vertical lists **BLOCKED beats TRUSTED**: a domain an operator explicitly excluded stays
excluded. Policies add an explicit numeric credibility override and an evergreen flag, so an
operator can say "this regulator is 0.95" rather than only "trusted".

**Blocked domains are counted and reported, not silently skipped** — an operator must be able to
see that their own block list is what removed those sources — and they can never be evidence.

### 5. Syndication-aware diversity and stronger canonicalization

Diversity now counts _clusters_, not rows: cluster members collapse to one unit before publishers
are counted. URL canonicalization was broadened (http/https, `www`/`m`/`amp` hosts, AMP and index
paths, default ports, duplicate slashes, a much larger tracking-parameter set), because the same
article arriving from a newsletter, a social share and a search result was producing three
"distinct" sources.

### 6. Bounded, polite fetching

`FetchScheduler` caps total in-flight fetches and enforces a minimum gap **per host**, honouring
`Crawl-delay` when robots.txt states one. Parallelism is across hosts; politeness is per host. The
per-run fetch budget and pre-flight budget enforcement from ADR-0026/0028/0029 are unchanged and
still run before any paid operation.

### 7. Runs report what they could NOT do

Stats gained `robotsBlocked`, `snippetOnly`, `blockedDomainRejected`, `evidenceEligible` and
`duplicateClusters`, and a `GET …/runs/:id/quality` endpoint returns per-source robots decision,
staleness, credibility, duplicate cluster and eligibility reason. A run that was mostly
robots-blocked must not read like a thorough run.

## Consequences

- Trend scores for snippet-heavy or syndicated topics will drop relative to before. That is the
  correction, not a regression — those scores were overstated.
- Robots checking adds one cached request per origin per day and can leave genuinely useful pages
  unfetched. Accepted: the alternative is crawling sites that asked us not to.
- The UI shows dashes rather than numbers where a score is absent; no placeholder quality values.
- Non-HTML documents (PDFs) still fall back to snippet-only with a stated reason — a document
  extractor remains the obvious next gap.
- `Crawl-delay` is honoured but sitemap directives and `noindex`/`nofollow` page-level meta are
  not yet read.
- The robots cache is global and unauthenticated by design; it stores only public crawl rules.
- Freshness decay is applied at ingest, so changing the config does not retroactively rescore
  existing sources until they are re-ingested or re-scored.
