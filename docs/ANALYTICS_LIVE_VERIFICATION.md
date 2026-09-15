# Analytics live verification checklist

Every analytics adapter (ADR-0039) is tested against local stand-ins that follow each platform's
documentation (`apps/api/test/analytics-sync.spec.ts` and the per-package `analytics.test.ts`
files). **None has been run against a real platform** — there are no app credentials in this
environment. Run the relevant section with a real app and a real published post before relying on
the numbers, and record what you find.

## Common

- [ ] Worker and API share `SOCIAL_TOKEN_ENCRYPTION_KEY`; the worker logs whether scheduled
      analytics sync is enabled.
- [ ] A manual sync from **Analytics** creates one run; clicking twice joins the same run.
- [ ] The run finishes with a status that matches reality, and every target has an outcome.
- [ ] No access token, Page token, application password or signed URL appears in API or worker
      logs, in `analytics_sync_runs.results`/`errorMessage`, or in `analytics_snapshots.providerMetadata`.
- [ ] Every metric the platform did not return shows **Unavailable** with a reason — never 0.
- [ ] Freshness shows "Fresh · retrieved …" after a sync and turns "Stale" after
      `ANALYTICS_STALE_AFTER_HOURS`.
- [ ] With `ANALYTICS_SCHEDULED_SYNC_ENABLED=true`, one scheduled run per workspace per interval.
- [ ] An `ANALYTICS_SYNC` operation limit of 0 refuses the next run with `BUDGET` and no platform
      traffic.

## WordPress

- [ ] A published post's approved comment count matches the WordPress admin's approved count.
- [ ] A pending (unapproved) comment is **not** counted.
- [ ] A deleted post makes the post's result `FAILED` with `NOT_FOUND`, not "0 comments".
- [ ] **Record** whether your host or security plugin strips `X-WP-Total` (the count is then
      `NOT_REPORTED`).

## YouTube

- [ ] Default scopes: views, likes and comments match YouTube Studio for a public video; watch time,
      average view duration and shares show `MISSING_SCOPE` naming `yt-analytics.readonly`, and no
      `youtubeanalytics.googleapis.com` request is made.
- [ ] With `yt-analytics.readonly` granted (reconnect): watch time, average view duration and shares
      appear. **Record** how many days a new video takes before the report returns rows.
- [ ] Channel subscribers show ≈ and match Studio to three significant figures.
- [ ] A video whose owner hid likes: likes `NOT_REPORTED`.
- [ ] Quota exhaustion is `QUOTA_EXCEEDED` and retried; **record** the quota cost observed per sync.
- [ ] **Record** whether view counts reflect the 24 August 2026 definition change.

## LinkedIn

- [ ] Page (`rw_organization_admin`, ADMINISTRATOR role): impressions, clicks, likes, comments,
      shares and `engagement` match the page's analytics for a recent post.
- [ ] **Record** whether `uniqueImpressionsCount` is ever returned per share (the documented per-share
      samples omit it; Spectra shows `NOT_REPORTED`).
- [ ] A post with no activity comes back omitted and is stored as the documented zero.
- [ ] A post older than 12 months is `OUTSIDE_RETENTION_WINDOW` and not requested.
- [ ] A member without the ADMINISTRATOR role is refused, shown as `APPROVAL_REQUIRED`.
- [ ] Member (`r_member_postAnalytics`): the eight metrics match the member's post analytics
      (≈ best-effort). **Record** the responses' `metricType` shape for your `LINKEDIN_API_VERSION`.
- [ ] Without the scopes: every metric `MISSING_SCOPE`, no `/rest/…Statistics` or
      `memberCreatorPostAnalytics` request.

## Facebook Pages

- [ ] Default scopes: Page followers match; post metrics `MISSING_SCOPE` naming `read_insights`.
- [ ] With `read_insights` (App Review): `post_media_view`, `post_total_media_view_unique`,
      `post_clicks` and reactions match Meta Business Suite for a recent post.
- [ ] **Record** the exact keys inside `post_reactions_by_type_total` for a post with no likes
      (likes is `NOT_REPORTED` when `like` is absent).
- [ ] **Record** what Graph returns if `post_media_view` is requested on your pinned
      `META_GRAPH_API_VERSION`, and whether any requested metric is deprecated there.

## Instagram (professional accounts)

- [ ] Default scopes: followers match; post metrics `MISSING_SCOPE` naming `instagram_manage_insights`.
- [ ] With `instagram_manage_insights`: likes, comments, shares, saves, profile visits, reach and
      views match the app's insights for a feed image; reach and views show ≈.
- [ ] **Record** how long after publishing insights first return values (Meta: up to 48 hours).

## Trend scoring

- [ ] After a sync, a research run for a topic whose content was published and measured shows a
      `measuredEngagement` component labelled "platform measured" with its rationale.
- [ ] A topic with no measured posts shows "measuredEngagement · unavailable — not counted, not
      treated as zero" and the same score it had before.

## Record

| Date | Platform | Scopes / access | Result | Notes |
| ---- | -------- | --------------- | ------ | ----- |
|      |          |                 |        |       |
