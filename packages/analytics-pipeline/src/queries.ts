import { aggregateMetrics, freshnessOf, metricKeysFor } from '@spectra/analytics-core';
import {
  ANALYTICS_METRIC_DEFINITIONS,
  ANALYTICS_METRIC_KEYS,
  analyticsTargetResultSchema,
  type AnalyticsAggregateMetric,
  type AnalyticsAvailability,
  type AnalyticsErrorCode,
  type AnalyticsMetric,
  type AnalyticsMetricKey,
  type AnalyticsProviderCapability,
  type AnalyticsSnapshot,
  type AnalyticsSyncRun,
  type AnalyticsTargetResult,
  type AnalyticsUnavailableReason,
  type NormalizedCampaignAnalytics,
  type SocialPlatform,
} from '@spectra/contracts';
import type { Prisma, SpectraPrismaClient } from '@spectra/database';

import { describeAnalyticsCapability, hasAnalyticsAdapter } from './resolver';

/**
 * Read models for the analytics API (ADR-0039). Every query is scoped by
 * organization AND workspace; a foreign id simply finds nothing.
 *
 * "Latest" is per target: the newest snapshot of each account and each
 * published entry. Summaries aggregate those — with contributing and
 * unavailable counts — and never fill a gap with zero.
 */

export interface TenantScope {
  organizationId: string;
  workspaceId: string;
}

const SNAPSHOT_LIMIT = 2000;

type SnapshotRow = Prisma.AnalyticsSnapshotGetPayload<{ include: { metrics: true } }>;

export function toMetric(row: SnapshotRow['metrics'][number]): AnalyticsMetric {
  return {
    key: row.metricKey as AnalyticsMetricKey,
    sourceMetricName: row.sourceMetricName,
    value: row.value,
    unit: row.unit as AnalyticsMetric['unit'],
    completeness: row.completeness,
    unavailableReason: row.unavailableReason,
    detail: row.detail,
  };
}

const KEY_ORDER = new Map<string, number>(ANALYTICS_METRIC_KEYS.map((key, index) => [key, index]));

export function toSnapshot(row: SnapshotRow, now: Date): AnalyticsSnapshot {
  return {
    id: row.id,
    level: row.level,
    providerId: row.providerId,
    attribution: {
      platform: row.platform as SocialPlatform,
      socialAccountId: row.socialAccountId,
      externalAccountId: row.externalAccountId,
      scheduleEntryId: row.scheduleEntryId,
      contentItemId: row.contentItemId,
      campaignId: row.campaignId,
      externalContentId: row.externalContentId,
      publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    },
    completeness: row.completeness,
    retrievedAt: row.retrievedAt.toISOString(),
    freshness: freshnessOf(
      row,
      now,
      row.notes.find((note) => /delay|lag|up to the last day|once every/i.test(note)) ?? null,
    ),
    metrics: row.metrics
      .map(toMetric)
      .sort((a, b) => (KEY_ORDER.get(a.key) ?? 0) - (KEY_ORDER.get(b.key) ?? 0)),
    notes: row.notes,
    syncRunId: row.syncRunId,
  };
}

/** Newest snapshot per (level, account, entry). */
async function latestSnapshots(
  prisma: SpectraPrismaClient,
  scope: TenantScope,
  where: Prisma.AnalyticsSnapshotWhereInput,
): Promise<SnapshotRow[]> {
  const rows = await prisma.analyticsSnapshot.findMany({
    where: { ...scope, ...where },
    include: { metrics: true },
    orderBy: { retrievedAt: 'desc' },
    take: SNAPSHOT_LIMIT,
  });
  const seen = new Set<string>();
  const latest: SnapshotRow[] = [];
  for (const row of rows) {
    const key = `${row.level}:${row.socialAccountId ?? '-'}:${row.scheduleEntryId ?? '-'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    latest.push(row);
  }
  return latest;
}

// ---------------------------------------------------------------------------
// Providers and availability
// ---------------------------------------------------------------------------

export function analyticsProviderCatalog(
  configured: Partial<Record<SocialPlatform, boolean>>,
  platforms: readonly SocialPlatform[],
): AnalyticsProviderCapability[] {
  return platforms.map((platform) =>
    describeAnalyticsCapability({
      platform,
      grantedScopes: null,
      configured: configured[platform] ?? true,
    }),
  );
}

export interface AccountAvailability {
  socialAccountId: string;
  platform: SocialPlatform;
  kind: string;
  displayName: string;
  availability: AnalyticsAvailability;
  reason: string;
  capability: AnalyticsProviderCapability;
  freshness: ReturnType<typeof freshnessOf>;
}

/**
 * Per connected account: what analytics it can give now, from its grant and
 * connection state — no token is opened. The live sync may still find less
 * (a platform refusal), and says so in its run.
 */
export async function accountAvailability(
  prisma: SpectraPrismaClient,
  scope: TenantScope,
  configured: Partial<Record<SocialPlatform, boolean>>,
  now: Date,
): Promise<AccountAvailability[]> {
  const accounts = await prisma.socialAccount.findMany({
    where: { ...scope, deletedAt: null },
    select: {
      id: true,
      platform: true,
      kind: true,
      displayName: true,
      connectionId: true,
      encryptedToken: true,
      connection: {
        select: {
          status: true,
          disconnectedAt: true,
          grantedScopes: true,
          grantedScopesReported: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });
  const latest = await prisma.analyticsSnapshot.findMany({
    where: { ...scope, socialAccountId: { in: accounts.map((account) => account.id) } },
    orderBy: { retrievedAt: 'desc' },
    select: { socialAccountId: true, retrievedAt: true, staleAfter: true, dataAsOf: true },
    take: SNAPSHOT_LIMIT,
  });

  return accounts.map((account) => {
    const platform = account.platform as SocialPlatform;
    const grant = account.connection?.grantedScopesReported
      ? account.connection.grantedScopes
      : null;
    const capability = describeAnalyticsCapability({
      platform,
      kind: account.kind,
      grantedScopes: grant,
      configured: configured[platform] ?? true,
    });
    let availability = capability.availability;
    let reason = capability.summary;
    if (hasAnalyticsAdapter(platform)) {
      if (platform === 'WORDPRESS') {
        if (!account.encryptedToken) {
          availability = 'NOT_CONNECTED';
          reason = 'No application password is stored for this site.';
        }
      } else if (
        !account.connectionId ||
        !account.connection ||
        account.connection.disconnectedAt
      ) {
        availability = 'NOT_CONNECTED';
        reason =
          'This account was not connected through the platform (or the connection was removed), so its analytics cannot be read.';
      } else if (
        account.connection.status === 'REAUTH_REQUIRED' ||
        account.connection.status === 'REVOKED'
      ) {
        availability = 'REAUTH_REQUIRED';
        reason = 'The platform rejected this authorization. Reconnect to read analytics.';
      } else if (availability === 'PARTIAL' || availability === 'MISSING_SCOPE') {
        const missing = [
          ...new Set(
            capability.metrics
              .filter((metric) => metric.availability === 'MISSING_SCOPE')
              .flatMap((metric) =>
                metric.requiredScopes.filter((scope) => !(grant ?? []).includes(scope)),
              ),
          ),
        ];
        reason = `${availability === 'PARTIAL' ? 'Some metrics are readable.' : 'No metrics are readable yet.'} Missing: ${missing.join(', ')}.${capability.approval.required ? ' The platform reviews these permissions.' : ''}`;
      }
    }
    const snapshot = latest.find((row) => row.socialAccountId === account.id) ?? null;
    return {
      socialAccountId: account.id,
      platform,
      kind: account.kind,
      displayName: account.displayName,
      availability,
      reason,
      capability,
      freshness: freshnessOf(snapshot, now),
    };
  });
}

// ---------------------------------------------------------------------------
// Sync runs
// ---------------------------------------------------------------------------

type RunRow = Prisma.AnalyticsSyncRunGetPayload<object>;

export function toSyncRun(row: RunRow): AnalyticsSyncRun {
  const results = Array.isArray(row.results)
    ? (row.results as unknown[])
        .map((item) => analyticsTargetResultSchema.safeParse(item))
        .filter((parsed) => parsed.success)
        .map((parsed) => parsed.data as AnalyticsTargetResult)
    : [];
  const limited = row.errorCode === 'RATE_LIMITED' || row.errorCode === 'QUOTA_EXCEEDED';
  return {
    id: row.id,
    trigger: row.trigger,
    target: row.target,
    socialAccountId: row.socialAccountId,
    scheduleEntryId: row.scheduleEntryId,
    status: row.status,
    attempt: row.attempt,
    maxAttempts: row.maxAttempts,
    counts: {
      succeeded: row.succeededCount,
      partial: row.partialCount,
      failed: row.failedCount,
      unavailable: row.unavailableCount,
    },
    error: row.errorCode
      ? {
          code: row.errorCode as AnalyticsErrorCode,
          message: row.errorMessage ?? '',
          retryable: row.nextAttemptAt !== null,
          retryAfterSeconds: row.retryAfterSeconds,
        }
      : null,
    rateLimit: limited
      ? {
          limited: true,
          retryAfterSeconds: row.retryAfterSeconds,
          nextAttemptAt: row.nextAttemptAt ? row.nextAttemptAt.toISOString() : null,
          note:
            row.nextAttemptAt !== null
              ? 'The platform limited requests; Spectra will retry with backoff.'
              : 'The platform limited requests and no attempts remain. Start a new sync later.',
        }
      : null,
    results,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  };
}

export async function getSyncRun(prisma: SpectraPrismaClient, scope: TenantScope, runId: string) {
  const row = await prisma.analyticsSyncRun.findFirst({ where: { id: runId, ...scope } });
  return row ? toSyncRun(row) : null;
}

export async function listSyncRuns(prisma: SpectraPrismaClient, scope: TenantScope, limit = 20) {
  const rows = await prisma.analyticsSyncRun.findMany({
    where: scope,
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 100),
  });
  return rows.map(toSyncRun);
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

const CONTENT_KEYS = metricKeysFor('CONTENT');

function oldestFreshness(rows: SnapshotRow[], now: Date) {
  if (rows.length === 0)
    return freshnessOf(null, now, 'No external analytics have been retrieved yet.');
  const stale = rows.filter((row) => row.staleAfter.getTime() <= now.getTime()).length;
  const newest = rows.reduce((a, b) => (a.retrievedAt > b.retrievedAt ? a : b));
  const oldest = rows.reduce((a, b) => (a.retrievedAt < b.retrievedAt ? a : b));
  const freshness = freshnessOf(oldest, now);
  return {
    ...freshness,
    note:
      stale > 0
        ? `${stale} of ${rows.length} snapshot(s) are stale. Newest retrieved ${newest.retrievedAt.toISOString()}.`
        : `All ${rows.length} snapshot(s) are fresh. Newest retrieved ${newest.retrievedAt.toISOString()}.`,
  };
}

export async function workspaceSummary(prisma: SpectraPrismaClient, scope: TenantScope, now: Date) {
  const [content, accounts, publishedPosts, lastRun] = await Promise.all([
    latestSnapshots(prisma, scope, { level: 'CONTENT' }),
    latestSnapshots(prisma, scope, { level: 'ACCOUNT' }),
    prisma.contentScheduleEntry.count({
      where: { ...scope, status: 'PUBLISHED', externalPostId: { not: null } },
    }),
    prisma.analyticsSyncRun.findFirst({ where: scope, orderBy: { createdAt: 'desc' } }),
  ]);
  const contentSnapshots = content.map((row) => ({ metrics: row.metrics.map(toMetric) }));
  const accountSnapshots = accounts.map((row) => ({ metrics: row.metrics.map(toMetric) }));
  const withValues = content.filter((row) => row.metrics.some((metric) => metric.value !== null));
  const platforms = [...new Set(content.map((row) => row.platform as SocialPlatform))].sort();

  return {
    source: 'EXTERNAL_MEASURED' as const,
    externalAvailable:
      withValues.length > 0 || accounts.some((row) => row.metrics.some((m) => m.value !== null)),
    publishedPosts,
    postsWithSnapshots: content.length,
    postsWithMeasuredValues: withValues.length,
    postsWithoutAnalytics: Math.max(0, publishedPosts - content.length),
    accountsWithSnapshots: accounts.length,
    content: aggregateMetrics(contentSnapshots, CONTENT_KEYS),
    followers: aggregateMetrics(accountSnapshots, ['followers'])[0] as AnalyticsAggregateMetric,
    byPlatform: platforms.map((platform) => {
      const rows = content.filter((row) => row.platform === platform);
      return {
        platform,
        posts: rows.length,
        metrics: aggregateMetrics(
          rows.map((row) => ({ metrics: row.metrics.map(toMetric) })),
          CONTENT_KEYS,
        ).filter((metric) => metric.contributing > 0),
      };
    }),
    freshness: oldestFreshness([...content, ...accounts], now),
    lastRun: lastRun ? toSyncRun(lastRun) : null,
    note:
      content.length === 0
        ? 'No external analytics yet. Connect a platform with an analytics adapter and run a sync — nothing is estimated in their place.'
        : 'Totals add up only what platforms reported. A metric a post did not report is counted as unavailable, never as zero.',
  };
}

export async function campaignAnalytics(
  prisma: SpectraPrismaClient,
  scope: TenantScope,
  campaignId: string,
  now: Date,
) {
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, ...scope, deletedAt: null },
    select: { id: true, name: true, status: true },
  });
  if (!campaign) return null;
  const entries = await prisma.contentScheduleEntry.findMany({
    where: {
      ...scope,
      contentItem: { campaignId },
      status: 'PUBLISHED',
      externalPostId: { not: null },
    },
    select: {
      id: true,
      platform: true,
      publishedAt: true,
      externalUrl: true,
      contentItem: { select: { id: true, title: true } },
    },
    orderBy: { publishedAt: 'desc' },
    take: 500,
  });
  const snapshots = entries.length
    ? await latestSnapshots(prisma, scope, {
        level: 'CONTENT',
        scheduleEntryId: { in: entries.map((entry) => entry.id) },
      })
    : [];
  const byEntry = new Map(snapshots.map((row) => [row.scheduleEntryId, row]));
  const analytics: NormalizedCampaignAnalytics = {
    source: 'EXTERNAL_MEASURED',
    campaignId: campaign.id,
    aggregation: 'SUM_OF_POST_SNAPSHOTS',
    publishedPosts: entries.length,
    postsWithAnalytics: snapshots.length,
    postsWithoutAnalytics: entries.length - snapshots.length,
    metrics: aggregateMetrics(
      snapshots.map((row) => ({ metrics: row.metrics.map(toMetric) })),
      CONTENT_KEYS,
    ),
    freshness: oldestFreshness(snapshots, now),
  };
  return {
    campaign: { id: campaign.id, name: campaign.name, status: campaign.status as string },
    analytics,
    note: 'Organic platform APIs have no campaign object, so these are Spectra’s sums of the campaign’s published posts. Posts with no analytics are listed, not counted as zero.',
    posts: entries.map((entry) => {
      const row = byEntry.get(entry.id);
      return {
        scheduleEntryId: entry.id,
        contentItemId: entry.contentItem.id,
        title: entry.contentItem.title,
        platform: entry.platform,
        publishedAt: entry.publishedAt ? entry.publishedAt.toISOString() : null,
        externalUrl: entry.externalUrl,
        snapshot: row ? toSnapshot(row, now) : null,
      };
    }),
  };
}

export async function contentAnalytics(
  prisma: SpectraPrismaClient,
  scope: TenantScope,
  contentItemId: string,
  now: Date,
) {
  const item = await prisma.contentItem.findFirst({
    where: { id: contentItemId, ...scope, deletedAt: null },
    select: { id: true, title: true, lifecycleState: true, campaignId: true, topicKey: true },
  });
  if (!item) return null;
  const entries = await prisma.contentScheduleEntry.findMany({
    where: { ...scope, contentItemId },
    select: {
      id: true,
      platform: true,
      status: true,
      socialAccountId: true,
      externalPostId: true,
      externalUrl: true,
      publishedAt: true,
    },
    orderBy: { scheduledAt: 'desc' },
  });
  const snapshots = await prisma.analyticsSnapshot.findMany({
    where: { ...scope, level: 'CONTENT', contentItemId },
    include: { metrics: true },
    orderBy: { retrievedAt: 'desc' },
    take: 200,
  });
  return {
    item: {
      id: item.id,
      title: item.title,
      lifecycleState: item.lifecycleState as string,
      campaignId: item.campaignId,
      topicKey: item.topicKey,
    },
    source: 'EXTERNAL_MEASURED' as const,
    entries: entries.map((entry) => {
      const history = snapshots.filter((row) => row.scheduleEntryId === entry.id);
      const latest = history[0];
      let reason: string | null = null;
      if (!latest) {
        if (entry.status !== 'PUBLISHED' || !entry.externalPostId) {
          reason = `Not published (${entry.status}), so there is nothing to measure yet.`;
        } else if (!hasAnalyticsAdapter(entry.platform as SocialPlatform)) {
          reason = describeAnalyticsCapability({
            platform: entry.platform as SocialPlatform,
            grantedScopes: null,
            configured: true,
          }).summary;
        } else {
          reason = 'Published, but no analytics sync has retrieved this post yet.';
        }
      }
      return {
        scheduleEntryId: entry.id,
        platform: entry.platform,
        status: entry.status as string,
        externalUrl: entry.externalUrl,
        publishedAt: entry.publishedAt ? entry.publishedAt.toISOString() : null,
        latest: latest ? toSnapshot(latest, now) : null,
        /** Earlier retrievals of the same post, newest first — real history only. */
        history: history.slice(1, 20).map((row) => ({
          snapshotId: row.id,
          retrievedAt: row.retrievedAt.toISOString(),
          metrics: row.metrics.filter((metric) => metric.value !== null).map(toMetric),
        })),
        freshness: freshnessOf(latest ?? null, now),
        unavailableReason: reason,
      };
    }),
  };
}

export async function unavailableMetrics(prisma: SpectraPrismaClient, scope: TenantScope) {
  const [content, accounts] = await Promise.all([
    latestSnapshots(prisma, scope, { level: 'CONTENT' }),
    latestSnapshots(prisma, scope, { level: 'ACCOUNT' }),
  ]);
  const groups = new Map<
    string,
    {
      platform: SocialPlatform;
      level: 'ACCOUNT' | 'CONTENT';
      metric: AnalyticsMetricKey;
      label: string;
      reason: AnalyticsUnavailableReason;
      detail: string | null;
      snapshots: number;
    }
  >();
  for (const row of [...content, ...accounts]) {
    for (const metric of row.metrics) {
      if (metric.value !== null || !metric.unavailableReason) continue;
      const key = `${row.platform}:${row.level}:${metric.metricKey}:${metric.unavailableReason}`;
      const existing = groups.get(key);
      if (existing) {
        existing.snapshots += 1;
      } else {
        groups.set(key, {
          platform: row.platform as SocialPlatform,
          level: row.level,
          metric: metric.metricKey as AnalyticsMetricKey,
          label:
            ANALYTICS_METRIC_DEFINITIONS[metric.metricKey as AnalyticsMetricKey]?.label ??
            metric.metricKey,
          reason: metric.unavailableReason,
          detail: metric.detail,
          snapshots: 1,
        });
      }
    }
  }
  return [...groups.values()].sort(
    (a, b) =>
      a.platform.localeCompare(b.platform) ||
      a.level.localeCompare(b.level) ||
      a.metric.localeCompare(b.metric),
  );
}

export async function freshnessStatus(prisma: SpectraPrismaClient, scope: TenantScope, now: Date) {
  const [content, accounts] = await Promise.all([
    latestSnapshots(prisma, scope, { level: 'CONTENT' }),
    latestSnapshots(prisma, scope, { level: 'ACCOUNT' }),
  ]);
  const describe = (row: SnapshotRow) => ({
    snapshotId: row.id,
    level: row.level as 'ACCOUNT' | 'CONTENT',
    platform: row.platform as SocialPlatform,
    socialAccountId: row.socialAccountId,
    scheduleEntryId: row.scheduleEntryId,
    freshness: freshnessOf(row, now),
  });
  const all = [...accounts, ...content].map(describe);
  return {
    counts: {
      fresh: all.filter((item) => item.freshness.state === 'FRESH').length,
      stale: all.filter((item) => item.freshness.state === 'STALE').length,
    },
    overall: oldestFreshness([...content, ...accounts], now),
    items: all,
  };
}

export async function providerStatus(prisma: SpectraPrismaClient, scope: TenantScope) {
  const runs = await prisma.analyticsSyncRun.findMany({
    where: { ...scope },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  const byPlatform = new Map<
    string,
    {
      platform: string;
      lastErrorCode: AnalyticsErrorCode;
      lastMessage: string | null;
      at: string;
      occurrences: number;
    }
  >();
  for (const run of runs.map(toSyncRun)) {
    for (const item of run.results) {
      if (!item.errorCode || (item.outcome !== 'FAILED' && item.outcome !== 'UNAVAILABLE'))
        continue;
      const existing = byPlatform.get(item.platform);
      if (existing) existing.occurrences += 1;
      else
        byPlatform.set(item.platform, {
          platform: item.platform,
          lastErrorCode: item.errorCode,
          lastMessage: item.message,
          at: run.finishedAt ?? run.createdAt,
          occurrences: 1,
        });
    }
  }
  const rateLimited = runs.map(toSyncRun).filter((run) => run.rateLimit !== null);
  return {
    providers: [...byPlatform.values()],
    rateLimits: rateLimited.map((run) => ({ runId: run.id, status: run.status, ...run.rateLimit })),
    recentRuns: runs.length,
  };
}
