# ADR-0039: External analytics — provider-neutral ingestion where unavailable is never zero

**Status:** Accepted · **Date:** 2026-09-14 · **Relates to:** ADR-0021, ADR-0026, ADR-0028,
ADR-0034, ADR-0035, ADR-0036, ADR-0037, ADR-0038

## Context

ADR-0021 shipped first-party reporting and said external engagement was unavailable "until a
platform adapter lands". Nine publishing targets now publish for real (ADR-0022, 0035–0038), so the
question is no longer whether analytics can be read, but how to read them without breaking the
rules the rest of the platform keeps:

- Platforms expose very different things, gated differently. YouTube's Data API returns view, like
  and comment counts with the scope Spectra already requests, while watch time needs a separate,
  sensitive scope. LinkedIn page statistics need an administrator and a reviewed product. Meta's
  insights need App Review, and Meta has deprecated impressions for both Pages (above Graph v25) and
  Instagram (media after 2 July 2024). WordPress core records no views at all. TikTok, X, Threads
  and Pinterest have analytics APIs Spectra has not integrated, and X bills every call.
- Platforms qualify their numbers: YouTube rounds subscriber counts "down to three significant
  figures"; LinkedIn calls member analytics "best-effort accurate"; Meta labels reach "estimated"
  and views "in development"; LinkedIn documents that a share with no activity is omitted and "can
  be assumed to have counts of 0".
- The existing contract (`analyticsMetricSchema` in `social.ts`) required `value: number` — the
  exact shape that turns a missing metric into zero.

## Decision

### 1. A metric is a value or a reason — enforced three times

`@spectra/contracts/analytics.ts` replaces the old contract. `AnalyticsMetric.value` is
`number | null`, and `null` always travels with an `AnalyticsUnavailableReason` (20 reasons, from
`NOT_EXPOSED_BY_PLATFORM` and `MISSING_SCOPE` to `DEPRECATED_BY_PLATFORM`,
`OUTSIDE_RETENTION_WINDOW`, `RATE_LIMITED` and `NOT_ADDITIVE`). The rule holds in the Zod schema
(`superRefine`), in the adapters (`finalizeMetrics` refuses an incomplete or ambiguous set), and in
Postgres: two `CHECK` constraints on `analytics_metric_values` make it impossible to store a null
without a reason, a value with one, or a value marked `UNAVAILABLE`.

Each value also carries its completeness — `EXACT`, `APPROXIMATE` (the platform says so),
`DERIVED` (computed by Spectra) — and the platform's own field name (`statistics.viewCount`,
`totalShareStatistics.impressionCount`, `post_media_view`) beside the normalized key.

### 2. Adapters declare every metric, including the ones they cannot read

`@spectra/analytics-core` defines the `AnalyticsProvider` port (`capability`,
`fetchAccountAnalytics`, `fetchContentAnalytics`) and a declarative `MetricSpec`: for each of the 16
normalized keys at each level, an adapter states the source field and required scopes — or why it
is unavailable. "Missing scope" is decided from the grant **before** any call is made, so a metric
that would be refused is never requested. Adapters live in the platform packages beside their
publishers and reuse their clients:

| Platform                      | Reads                                                                                                             | Needs beyond Spectra's defaults                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| WordPress                     | approved comment count (`X-WP-Total`) per post                                                                    | nothing (application password)                       |
| YouTube                       | per video: views, likes, comments; watch time, average view duration, shares; per channel: views, subscribers (≈) | `yt-analytics.readonly` for the three report metrics |
| LinkedIn (page)               | organic impressions, unique impressions, clicks, likes, comments, shares, LinkedIn's engagement ratio             | `rw_organization_admin` (Community Management API)   |
| LinkedIn (member)             | impressions, reach, reactions, comments, reshares, saves, link clicks, profile views (all ≈)                      | `r_member_postAnalytics` (Community Management API)  |
| Facebook Page                 | followers; per post: views, unique viewers (≈), clicks, reactions, likes                                          | `read_insights` for post insights                    |
| Instagram (pro)               | followers; per post: likes, comments, shares, saves, profile visits, reach (≈), views (≈)                         | `instagram_manage_insights` for media insights       |
| TikTok, X, Threads, Pinterest | nothing — `NOT_IMPLEMENTED`, with what the platform offers and what it would take                                 | —                                                    |
| Email                         | nothing — `UNSUPPORTED` (no sending provider is integrated)                                                       | —                                                    |

Analytics scopes are **not** added to any default scope list: each is sensitive or reviewed, and
asking for one an app has not been approved for can make the whole authorization fail on some
platforms, or add warnings to the consent screen on others. Operators add them with
`SOCIAL_OAUTH_<PLATFORM>_SCOPES` once approved; until then the metrics say `MISSING_SCOPE` and name
the scope.

### 3. Documented zeros are zeros; everything else is not

Where a platform documents that absence means zero (LinkedIn's omitted shares), Spectra stores 0
**with that quote in the detail**, and leaves the ratio undefined. Where a platform simply leaves a
field out (a hidden like count, a missing `X-WP-Total` header), the metric is `NOT_REPORTED`. A
reported zero stays zero.

### 4. Engagement rate only with a denominator

Spectra's rate is (reactions or likes) + comments + shares + saves over impressions, or views where
a platform reports no impressions. It is computed only when that denominator was reported and is
above zero; otherwise `DENOMINATOR_UNKNOWN`. When interaction counts are missing the detail names
them. A platform's own ratio (LinkedIn's `engagement`) is kept as reported, not recomputed.

### 5. Sync runs: idempotent, budgeted, rate-limit aware, honest when there is nothing to do

`@spectra/analytics-pipeline`:

- `requestAnalyticsSync` creates an `AnalyticsSyncRun` for a workspace, one account or one published
  schedule entry — or returns the existing one for the same `Idempotency-Key`, or the unfinished run
  for the same target. The target is checked against the tenant first.
- `executeAnalyticsSync` (the worker's handler and the tests' entry point) claims the run with a
  guarded update, runs a budget pre-flight on the new `ANALYTICS_SYNC` usage kind (a counter today —
  no wired provider bills per call — so a per-kind limit can cap it and a paid provider added later
  cannot bypass it), resolves a provider per account through the same sealed connections publishing
  uses (`openConnection`, now shared), and stores one snapshot per target.
- A rate limit, quota refusal or rejected token stops further calls to that account for the attempt.
  Retryable failures reschedule the run (`QUEUED` + `nextAttemptAt`, exponential backoff never
  sooner than the platform asked) until `maxAttempts`; the worker enqueues a delayed job, and a
  dispatcher every five minutes is the safety net.
- Snapshots are keyed by run + level + account + entry, so a redelivered or retried attempt rewrites
  its own snapshot instead of adding a second.
- A run finishes `SUCCEEDED`, `PARTIAL`, `FAILED`, or `UNAVAILABLE` — the honest no-op when no
  provider is implemented, configured or connected. Nothing is stored for an unavailable provider.
- Scheduled sync (`ANALYTICS_SCHEDULED_SYNC_ENABLED`) is **off by default**: every sync spends
  platform quota, so an operator turns it on deliberately. When on, one run per workspace per
  interval is created, idempotent per interval bucket.

### 6. Schema

`AnalyticsSyncRun`, `AnalyticsSnapshot` (tenant, platform, provider, level, account, entry, content
item, campaign, `retrievedAt`, `staleAfter`, `dataAsOf`, redacted `providerMetadata`, notes) and
`AnalyticsMetricValue` — all three tenant-guarded, with indexes for workspace dashboards and
content/campaign detail. Relations to accounts, entries, items and campaigns are `SET NULL`, so a
deletion never re-attributes history. Provider metadata is allow-listed primitives only, redacted
twice (adapter and store); comment text is never ingested.

### 7. Campaigns are Spectra's sum, and say so

Organic platform APIs have no campaign object (LinkedIn's and Meta's campaigns are ads). Campaign
analytics are `SUM_OF_POST_SNAPSHOTS` over the campaign's published posts, with how many posts had
analytics and how many did not. Sums add only reported values; non-additive metrics (reach, average
view duration) are refused as `NOT_ADDITIVE`; engagement rate is recomputed only over snapshots
with both parts.

### 8. Trend scoring: measured engagement joins, missing analytics never subtract

A new component, `measuredEngagement`, is separate from the estimated `engagementPotential`. Every
score component now carries a source label (`ESTIMATED`, `FIRST_PARTY_MEASURED`,
`EXTERNAL_MEASURED`). For a topic, the latest snapshot of each published post whose content item
carries the topic key is pooled into one engagement rate and scaled against a 5% reference rate (a
Spectra calibration constant, stated in every rationale). With no posts or no denominators the
signal is recorded under `unavailableSignals` and **does not participate** — the research-based
score is identical to what it would have been. `DEFAULT_TREND_SCORING_CONFIG` moves to 1.1.0.

### 9. API and UI

Eleven routes under `workspaces/:workspaceId/analytics` (`analytics:read`, plus the new
`analytics:sync` for starting a sync): providers, availability, sync, sync-runs, summary,
campaigns/:id, content/:id, unavailable-metrics, freshness, provider-status — beside the unchanged
first-party `overview`. The analytics page separates "your pipeline" (first-party) from "platform
engagement" (external), shows freshness on every surface, names missing scopes and unimplemented
platforms, warns on partial analytics, hides the sync button without `analytics:sync` and names the
permission, and draws no chart from analytics data.

## Consequences

- External analytics are real for WordPress, YouTube, LinkedIn, Facebook Pages and Instagram
  professional accounts — within what each grant allows — and explicitly not implemented for TikTok,
  X, Threads and Pinterest, and unsupported for email.
- **No adapter has been run against a real platform.** Every endpoint, field and qualifier comes from
  the platform's documentation (checked 2026-09-14) and is exercised against local stand-ins;
  `docs/ANALYTICS_LIVE_VERIFICATION.md` lists what to confirm.
- With Spectra's default scopes, YouTube reads counts but not watch time, and Facebook and Instagram
  read followers but no post insights. That is the honest default; the UI says which scope to add.
- Rate-limit handling relies on error kinds, not `Retry-After` headers, for YouTube, LinkedIn and
  Meta (their clients do not surface headers); WordPress honours `Retry-After`.
- Comment and reaction **counts** are read where permitted; comment text is not ingested.
- The trend-scoring reference rate is a calibration constant, not a measured norm; it should be
  revisited once real engagement distributions exist.
