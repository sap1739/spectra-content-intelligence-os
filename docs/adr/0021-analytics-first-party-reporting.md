# ADR-0021: Analytics v1 — real first-party reporting, no fabricated engagement

**Status:** Accepted · **Date:** 2026-07-14 · **Relates to:** ADR-0019, ADR-0020, ADR-0012

## Context

Phase 4C is analytics. The obvious target — post/campaign engagement (impressions, clicks,
likes) — requires a connected platform, and none is wired (ADR-0019/0020). The ground rules
forbid fabricated metrics, and the analytics placeholder promised "this product never displays
fabricated metrics." We need analytics that deliver real value now without inventing platform
numbers.

## Decision

Ship **first-party workspace reporting**: aggregate the real data the platform already owns, and
report external engagement as explicitly unavailable.

1. **Real aggregates only (`AnalyticsService`).** `GET analytics/overview` (perm `analytics:read`)
   returns tenant-scoped counts computed with Prisma `groupBy`/`count` over the workspace's own
   rows: the content funnel (items by `lifecycleState`), drafts by status, publications by
   dispatch status (including `UNSUPPORTED`), research runs by status, finding and READY
   evidence-pack counts, and trend candidates by state. Every number is a real count of the
   user's own data.

2. **Honest engagement stub.** The response carries `engagement.externalAvailable: false` plus a
   note stating external metrics are unavailable until a platform is connected. No zeros are
   dressed up as engagement, and no synthetic impressions/clicks are ever emitted.

3. **Real UI.** The analytics placeholder becomes a live page: stat tiles, a content-funnel bar
   chart (CSS bars, no chart dependency), publications-by-status badges (surfacing `UNSUPPORTED`),
   and an explicit "external engagement metrics are unavailable" banner.

## Rationale

- **Value without fabrication** — a content operator sees their real pipeline health (how much is
  in review, approved, published; how many drafts, findings, packs) today, honestly.
- **Consistent honesty pattern** — mirrors the AI (503), social (not-wired), and publishing
  (UNSUPPORTED) states: the gap is shown plainly, never faked.
- **Tenant-scoped and cheap** — `groupBy` with an `organizationId`/`workspaceId` filter satisfies
  the tenant guard and runs as a handful of indexed aggregates.

## Consequences

- No engagement analytics until a platform adapter lands; the surface is ready to receive them
  (an `AnalyticsProvider` per platform, feeding the same overview) without changing the UI shape.
- The overview is computed on read (no rollup tables yet); if it grows expensive it moves to a
  materialized/rollup table in a later increment.
- `engagementPotential` trend-score calibration from real post performance (Phase 4 roadmap item)
  is unblocked once a live `AnalyticsProvider` exists.
