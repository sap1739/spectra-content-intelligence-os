# Analytics Architecture

How Spectra reports what content did — and, just as carefully, what it cannot know. Decision record:
[ADR-0021](adr/0021-analytics-first-party-reporting.md) (first-party reporting) and
[ADR-0039](adr/0039-external-analytics-provider-architecture.md) (external analytics).

## 1. Two kinds of numbers, never mixed

| Source                   | Label in API and UI                           | What it is                                                                                          | Where                        |
| ------------------------ | --------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------- |
| **First-party measured** | `FIRST_PARTY_MEASURED` — "counted by Spectra" | Spectra's own records: content by lifecycle state, drafts, publications by status, research, trends | `GET …/analytics/overview`   |
| **External measured**    | `EXTERNAL_MEASURED` — "reported by platforms" | What a platform's analytics API returned for a connected account or a published post                | the external routes below    |
| **Estimated**            | `ESTIMATED`                                   | Inferred from research (e.g. a trend's `engagementPotential`); never shown as a measurement         | trend score components       |
| **Unavailable**          | `UNAVAILABLE` + a reason                      | There is no number, and the reason says why                                                         | everywhere a number could be |

## 2. The metric model

16 normalized keys (`ANALYTICS_METRIC_KEYS`): `impressions`, `reach`, `views`, `videoViews`,
`watchTimeMinutes`, `averageViewDurationSeconds`, `likes`, `reactions`, `comments`, `shares`,
`saves`, `clicks`, `linkClicks`, `engagementRate`, `followers` (account level only),
`profileVisits`. Each has a unit (`COUNT`, `MINUTES`, `SECONDS`, `RATIO`) and is marked additive or
not (`ANALYTICS_METRIC_DEFINITIONS`).

One metric value:

```ts
{
  key: 'views',
  sourceMetricName: 'statistics.viewCount', // the platform's own field
  value: 4200,                              // or null
  unit: 'COUNT',
  completeness: 'EXACT',                    // EXACT | APPROXIMATE | DERIVED | UNAVAILABLE
  unavailableReason: null,                  // set exactly when value is null
  detail: 'YouTube counts views its own way; …',
}
```

### How a missing metric is represented

- `value: null` **always** comes with an `unavailableReason` and `completeness: 'UNAVAILABLE'`.
  Enforced by the contract schema, by `finalizeMetrics` in every adapter, and by two database
  `CHECK` constraints on `analytics_metric_values`.
- Every adapter lists every key for every level it supports. A key a platform does not offer is
  `NOT_EXPOSED_BY_PLATFORM` with a sentence saying so — never omitted.
- The 20 reasons (`ANALYTICS_UNAVAILABLE_REASONS`) distinguish what nobody can fix
  (`NOT_EXPOSED_BY_PLATFORM`, `DEPRECATED_BY_PLATFORM`, `CONTENT_TYPE_UNSUPPORTED`, `NOT_REPORTED`)
  from what an operator can (`MISSING_SCOPE`, `APPROVAL_REQUIRED`, `REAUTH_REQUIRED`,
  `PROVIDER_UNCONFIGURED`), what time fixes (`NOT_YET_AVAILABLE`, `RATE_LIMITED`, `QUOTA_EXCEEDED`)
  and what Spectra refuses to compute (`DENOMINATOR_UNKNOWN`, `NOT_ADDITIVE`).
- A **documented** zero is stored as 0 with the platform's words in `detail` (LinkedIn: posts with
  no activity are omitted and "can be assumed to have counts of 0"). A field a platform simply left
  out is `NOT_REPORTED`. A reported 0 is 0.

### Completeness

- Value level: `APPROXIMATE` when the platform says so (YouTube's rounded subscriber counts,
  LinkedIn's "best-effort" member analytics, Meta's "estimated"/"in development" metrics);
  `DERIVED` for Spectra's engagement rate.
- Snapshot level: `COMPLETE` (nothing missing except what the platform never offers or left out),
  `PARTIAL` (something readable was not read — a scope, an approval, a rate limit, a delay),
  `UNAVAILABLE` (no values at all).

### Engagement rate

`(reactions or likes) + comments + shares + saves` over `impressions`, or `views` where no
impressions were reported. Calculated only when the denominator was reported and is above zero; the
detail names any interaction count that was missing. A platform's own ratio (LinkedIn's
`engagement`) is kept as reported.

## 3. Components

```
@spectra/contracts            analytics.ts — vocabulary, schemas, metric definitions
@spectra/analytics-core       AnalyticsProvider port, MetricSpec, metric builders, engagement rate,
                              aggregation, freshness, redaction, backoff, unimplemented-platform catalog
@spectra/social-wordpress     WordPressAnalyticsProvider      (analytics.ts beside the publisher)
@spectra/social-youtube       YouTubeAnalyticsProvider
@spectra/social-linkedin      LinkedInAnalyticsProvider
@spectra/social-meta          MetaAnalyticsProvider (Facebook Pages, Instagram)
@spectra/analytics-pipeline   provider resolver, requestAnalyticsSync, executeAnalyticsSync,
                              claimDueAnalyticsSyncs, read models, measuredEngagementForTopic
@spectra/trend-core           measuredEngagementSignal, withMeasuredEngagement
apps/worker                   analytics.sync.execute, analytics.sync.dispatch
apps/api                      ExternalAnalyticsService + AnalyticsController
apps/web                      /analytics, /analytics/content/[id], /analytics/campaigns/[id]
```

### The provider port

```ts
interface AnalyticsProvider {
  platform: SocialPlatform;
  providerId: string;
  capability(): AnalyticsProviderCapability; // per metric: availability + reason + scopes
  fetchAccountAnalytics(): Promise<AnalyticsFetchResult>;
  fetchContentAnalytics(target: { externalContentId; publishedAt }): Promise<AnalyticsFetchResult>;
}
```

A provider is built per account at sync time from that account's own opened token (the same
`openConnection` publishing uses: live connection, correct platform and kind, decrypt, refresh when
the platform issues refresh tokens). A whole-request failure throws `AnalyticsProviderError` with an
`AnalyticsErrorCode` (`RATE_LIMITED`, `QUOTA_EXCEEDED`, `REAUTH_REQUIRED`, `APPROVAL_REQUIRED`,
`NOT_FOUND`, `TRANSIENT`, …) and `retryable`; a per-metric gap is an unavailable metric in a
successful result. Campaigns are not a provider call — see §6.

## 4. Sync runs

```
POST analytics/sync ─► requestAnalyticsSync ─► AnalyticsSyncRun (QUEUED) ─► queue analytics.sync.execute
                                                                                   │
worker ─► executeAnalyticsSync ─► guarded claim (QUEUED & due, or RUNNING past a 15-min lease)
            │  budget pre-flight: ANALYTICS_SYNC (per-kind limit; BUDGET refusal = FAILED, nothing called)
            │  targets: WORKSPACE (accounts + posts published in the last 90 days, ≤100)
            │           SOCIAL_ACCOUNT (one account + its posts) · SCHEDULE_ENTRY (one published post)
            │  per account: resolve provider ─► UNAVAILABLE with reason, or
            │               account snapshot (if the provider has account metrics) + one snapshot per post
            │  rate limit / quota / rejected token ─► stop calling that account this attempt
            ▼
         SUCCEEDED · PARTIAL · FAILED · UNAVAILABLE    or    QUEUED + nextAttemptAt (retry with backoff)
```

- **Idempotency:** a client `Idempotency-Key` (namespaced by workspace) or an unfinished run for the
  same target returns the existing run; snapshots are keyed by run + level + account + entry, so a
  retried attempt rewrites its own snapshot.
- **Backoff:** `analyticsRetryDelayMs(attempt, retryAfterSeconds)` — 1 min × 2^(attempt−1), capped at
  6 h, never sooner than the platform asked. `ANALYTICS_SYNC_MAX_ATTEMPTS` (default 3).
- **Scheduled sync foundation:** `analytics.sync.dispatch` runs every five minutes. It always picks
  up due retries; it creates scheduled workspace runs only when `ANALYTICS_SCHEDULED_SYNC_ENABLED` is
  true (default **false** — syncs spend platform quota), once per `ANALYTICS_SYNC_INTERVAL_MINUTES`
  per workspace with a connected analytics-capable account.
- **No-op honesty:** an account on a platform without an adapter, a disconnected account, a missing
  credential-storage key — each is a result with `UNAVAILABLE` and the reason; nothing is stored for
  it. A run with nothing to read is `UNAVAILABLE`.

## 5. Storage

Three tenant-guarded tables — see `docs/DATABASE_DESIGN.md` §12. Snapshots are append-only history;
"latest" is the newest snapshot per (level, account, entry). Relations to accounts, entries, items
and campaigns are `SET NULL`: history is never re-attributed, and every read filters by organization
and workspace.

## 6. Read models

| Route (under `workspaces/:workspaceId/analytics`) | Returns                                                                                        |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `GET providers`                                   | every platform's capability: implemented, availability, per-metric reason, scopes, paid API    |
| `GET availability`                                | per connected account: availability from grant + connection state, reason, freshness           |
| `POST sync`                                       | a run (202), `created` false when joined                                                       |
| `GET sync-runs`, `GET sync-runs/:runId`           | status, attempt, per-target outcomes, error, rate limit                                        |
| `GET summary`                                     | sums over the latest post snapshots with contributing/unavailable counts, followers, freshness |
| `GET campaigns/:campaignId`                       | `SUM_OF_POST_SNAPSHOTS` over the campaign's published posts, plus each post                    |
| `GET content/:contentItemId`                      | each placement's latest snapshot, earlier retrievals, or why there is none                     |
| `GET unavailable-metrics`                         | unavailable metrics grouped by platform, level, metric and reason                              |
| `GET freshness`                                   | fresh/stale counts and per-snapshot freshness                                                  |
| `GET provider-status`                             | recent provider errors and rate limits                                                         |

Aggregation (`aggregateMetrics`) adds only reported values, counts what did not report, refuses
non-additive metrics (`NOT_ADDITIVE`), and recomputes engagement rate over snapshots that reported
both parts.

## 7. Freshness

Every snapshot has `retrievedAt` and `staleAfter` (`retrievedAt` + `ANALYTICS_STALE_AFTER_HOURS`,
default 24). `freshnessOf` reports `FRESH`, `STALE` or `NEVER_SYNCED`; summaries report the oldest
latest snapshot and how many are stale. Platform delays are carried as notes and freshness notes:
YouTube Analytics reports "up until the last day for which all metrics … are available", Meta
updates most Page metrics "once every 24 hours" and Instagram data "can be delayed up to 48 hours".
The UI shows "Fresh · retrieved 20 min ago", "Stale · retrieved 3 d ago" or "Never synced" next to
every external number.

## 8. Trend scoring

`measuredEngagement` (EXTERNAL_MEASURED) is a separate component from `engagementPotential`
(ESTIMATED). For a topic, `measuredEngagementForTopic` pools the latest snapshot of each published
post whose content item carries the topic key; the rate is scaled against a 5% reference (a
calibration constant). With no posts or no denominators the signal goes into `unavailableSignals` and
does not participate, so the research score is unchanged — covered by unit tests in `trend-core` and
the analytics integration suite. See `docs/TREND_SCORING_ARCHITECTURE.md`.

## 9. What is not built

- TikTok, X, Threads and Pinterest analytics (`NOT_IMPLEMENTED`); email analytics (`UNSUPPORTED`).
- Comment text (only counts), demographics, daily breakdowns, video retention curves.
- Account-level follower counts for LinkedIn pages; account-wide totals for LinkedIn members.
- Facebook comment and share counts.
- Charts: there is no trend line until there is enough real history to draw one honestly.
- No adapter has been run against a real platform — `docs/ANALYTICS_LIVE_VERIFICATION.md`.
