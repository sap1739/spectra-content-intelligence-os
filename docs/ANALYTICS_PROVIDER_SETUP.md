# Analytics provider setup

How to get real platform analytics into Spectra (ADR-0039), platform by platform. Analytics read
through the **same connections** publishing uses — there is nothing extra to connect — but most
platforms put their analytics behind an additional scope or a reviewed product. Spectra does **not**
request those by default; this guide says which to add, and until you do, the affected metrics are
shown as `MISSING_SCOPE` with the scope named.

Every endpoint, field and qualifier below comes from the platform's own documentation, checked
2026-09-14. None has been run against a real platform yet — see
`docs/ANALYTICS_LIVE_VERIFICATION.md`.

## Common to all

- The **worker** runs syncs, so it needs `SOCIAL_TOKEN_ENCRYPTION_KEY` (same key ring as the API)
  and, where tokens refresh, the platform's `SOCIAL_OAUTH_<PLATFORM>_CLIENT_ID/SECRET`.
- Add an analytics scope by overriding the whole scope list, keeping the defaults:
  `SOCIAL_OAUTH_<PLATFORM>_SCOPES="<defaults> <analytics scope>"`, then **reconnect** the account so
  the platform grants it. Existing connections keep their old grant until reconnected.
- Manual syncs work immediately (**Analytics → Sync analytics now**, or `POST …/analytics/sync`).
  Scheduled syncs are off by default:

```bash
# Optional: one workspace sync every 6 hours (each sync spends platform quota).
ANALYTICS_SCHEDULED_SYNC_ENABLED=true
ANALYTICS_SYNC_INTERVAL_MINUTES=360
# Snapshots older than this are labelled stale (hours).
ANALYTICS_STALE_AFTER_HOURS=24
# Attempts per run, including rate-limit retries with backoff.
ANALYTICS_SYNC_MAX_ATTEMPTS=3
```

- To cap syncs, set a per-operation limit for `ANALYTICS_SYNC` (`PUT …/budget/operations`; the
  Billing page lists it under per-operation limits). A refused run is `FAILED` with `BUDGET`, and no
  platform is called.

---

## WordPress — live with no extra setup

**Reads:** the approved comment count per published post (`GET /wp-json/wp/v2/comments?post=ID`,
`X-WP-Total`), after checking the post still exists.

**Does not read — and cannot:** WordPress core records no views, likes, shares or followers. Those
come from plugins such as Jetpack Stats (via WordPress.com), which Spectra does not integrate; every
one of those metrics says so.

**Needs:** the application password already stored for publishing. If a proxy or security plugin
strips `X-WP-Total`, the count is `NOT_REPORTED`, not zero.

## YouTube — partial by default, full with one scope

| With Spectra's default scopes (`youtube.upload youtube.readonly`)      | Adding `yt-analytics.readonly`                              |
| ---------------------------------------------------------------------- | ----------------------------------------------------------- |
| per video: views, likes, comments (`videos.list`, 1 quota unit)        | + watch time, average view duration, shares (Analytics API) |
| per channel: views, subscribers (≈ — rounded to 3 significant figures) |                                                             |

```bash
SOCIAL_OAUTH_YOUTUBE_SCOPES="https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly"
# Tests only: YOUTUBE_ANALYTICS_API_BASE_URL overrides https://youtubeanalytics.googleapis.com
```

Notes: `yt-analytics.readonly` is a sensitive scope (Google OAuth verification). Google says a report
"contains data up until the last day for which all metrics in the query are available", so recent
days can be missing; a report with no rows yet is `NOT_YET_AVAILABLE`. From 24 August 2026 YouTube
counts a view when playback starts, including autoplay. A like count the owner hid is
`NOT_REPORTED`. Dislikes are private to the owner and not read.

## LinkedIn — needs Community Management API access

| Account | Scope to add             | Reads                                                                                                                            |
| ------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Page    | `rw_organization_admin`  | organic impressions, unique impressions, clicks, likes, comments, shares, LinkedIn's `engagement` ratio — per post and page-wide |
| Member  | `r_member_postAnalytics` | impressions, members reached, reactions, comments, reshares, saves, link clicks, profile views — per post, all ≈                 |

```bash
SOCIAL_OAUTH_LINKEDIN_SCOPES="openid profile w_member_social r_member_postAnalytics"
```

Notes: both scopes belong to LinkedIn's Community Management API, granted by application. Page
statistics need the member to be an **ADMINISTRATOR** of the page, cover organic activity only, and
only "within the past 12 months" — older posts are `OUTSIDE_RETENTION_WINDOW`. LinkedIn documents
that posts with no activity are omitted and "can be assumed to have counts of 0"; Spectra stores
that documented zero with the quote. Member analytics are "best-effort accurate" and cost one call
per metric. Keep `LINKEDIN_API_VERSION` current.

## Facebook Pages and Instagram — need App Review

| Account                  | With default Meta scopes | Scope to add                | Adds                                                                           |
| ------------------------ | ------------------------ | --------------------------- | ------------------------------------------------------------------------------ |
| Facebook Page            | followers                | `read_insights`             | per post: views, unique viewers (≈), clicks, reactions, likes                  |
| Instagram (professional) | followers                | `instagram_manage_insights` | per post: likes, comments, shares, saves, profile visits, reach (≈), views (≈) |

```bash
SOCIAL_OAUTH_FACEBOOK_SCOPES="pages_show_list,pages_read_engagement,pages_manage_posts,instagram_basic,instagram_content_publish,read_insights,instagram_manage_insights"
```

Notes: both scopes need Meta App Review (Advanced Access). Impressions are not read because Meta
deprecated them (`post_impressions` "above Graph API v25"; Instagram `impressions` for media created
after 2 July 2024). Meta labels Instagram reach "estimated" and views "in development", and marks
`_unique` Page metrics approximate — all shown with ≈. Meta updates most Page metrics once every 24
hours, Instagram data "can be delayed up to 48 hours", and insights go back two years.

## TikTok, X, Threads, Pinterest — not implemented

Each is listed with its reason on **Analytics → Platform analytics status**, and a sync marks their
accounts `UNAVAILABLE` without calling anything:

- **TikTok:** the Display API documents per-video view, like, comment and share counts behind a
  scope Spectra does not request.
- **X:** public and owner-only post metrics exist, but X API v2 is pay-per-usage — reading them
  would cost credits per call (a budget pre-flight would apply).
- **Threads:** the Insights API documents views, likes, replies, reposts, quotes and shares behind
  `threads_manage_insights` (Meta App Review).
- **Pinterest:** pin analytics exist; their metric list and access rules were not verified for this
  release.

## Email — unsupported

No sending provider is integrated (a deliberate placeholder, ADR-0038), so there are no opens,
clicks or deliveries to read.

## Troubleshooting

| You see                                        | Meaning                                                                                               |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `MISSING_SCOPE` naming a scope                 | Add it to `SOCIAL_OAUTH_<PLATFORM>_SCOPES`, get it approved, reconnect.                               |
| `APPROVAL_REQUIRED`                            | The platform refused the analytics endpoint itself (App Review, a page role).                         |
| Run `QUEUED` with "Rate limited … retrying at" | The platform limited requests; the worker retries with backoff.                                       |
| Run `FAILED` with `QUOTA_EXCEEDED` (YouTube)   | The project's daily quota is used up; it resets at midnight Pacific Time.                             |
| `REAUTH_REQUIRED`                              | The token expired without a refresh token, or the platform rejected it. Reconnect.                    |
| Run `UNAVAILABLE`                              | Nothing to read: no connected account on a platform with an analytics adapter, or no published posts. |
| `FAILED` with `BUDGET`                         | An `ANALYTICS_SYNC` operation limit was reached; nothing was called.                                  |
