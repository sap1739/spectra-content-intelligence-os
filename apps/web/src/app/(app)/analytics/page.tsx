'use client';

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Skeleton,
} from '@spectra/ui';
import { BarChart3, Lock, RefreshCw, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { AggregateTile, FreshnessBadge, SourceBadge, SyncRunSummary } from '@/components/analytics';
import { PageHeader } from '@/components/page-header';
import { usePermissions, useWorkspace } from '@/lib/auth';
import {
  AVAILABILITY_LABEL,
  UNAVAILABLE_REASON_LABEL,
  availabilityVariant,
  isSyncActive,
  useAnalyticsAvailability,
  useAnalyticsOverview,
  useAnalyticsProviders,
  useAnalyticsSummary,
  useStartAnalyticsSync,
  useSyncRuns,
  useUnavailableMetrics,
  type AnalyticsOverview,
  type AnalyticsSummary,
} from '@/lib/analytics';
import { useCampaigns } from '@/lib/strategy';

// Funnel order (only states that carry counts are shown).
const FUNNEL_ORDER = [
  'IDEA',
  'RESEARCH_READY',
  'DRAFT',
  'GENERATED',
  'REVIEW',
  'CHANGES_REQUESTED',
  'APPROVED',
  'SCHEDULED',
  'PUBLISHED',
  'ARCHIVED',
];

const PUB_STATUS_VARIANT: Record<string, 'success' | 'warning' | 'muted' | 'destructive'> = {
  PUBLISHED: 'success',
  QUEUED: 'warning',
  PUBLISHING: 'warning',
  SCHEDULED: 'warning',
  FAILED: 'destructive',
  UNSUPPORTED: 'muted',
  CANCELLED: 'muted',
};

/** The tiles shown first; everything else is in the per-metric list. */
const HEADLINE_METRICS: Array<[string, string]> = [
  ['views', 'Views'],
  ['impressions', 'Impressions'],
  ['likes', 'Likes'],
  ['comments', 'Comments'],
  ['shares', 'Shares'],
  ['engagementRate', 'Engagement rate'],
];

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="py-4">
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </CardContent>
    </Card>
  );
}

function FunnelBar({ label, count, max }: { label: string; count: number; max: number }) {
  const width = max > 0 ? Math.round((count / max) * 100) : 0;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-36 shrink-0 truncate text-muted-foreground">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-primary/80" style={{ width: `${width}%` }} />
      </div>
      <span className="w-8 shrink-0 text-right tabular-nums">{count}</span>
    </div>
  );
}

function FirstParty({ data }: { data: AnalyticsOverview }) {
  const funnelRows = FUNNEL_ORDER.map((state) => ({
    state,
    count: data.content.byLifecycleState[state] ?? 0,
  })).filter((r) => r.count > 0);
  const funnelMax = Math.max(1, ...funnelRows.map((r) => r.count));
  const pubStatuses = Object.entries(data.publications.byStatus);

  return (
    <section aria-labelledby="first-party-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="first-party-heading" className="text-base font-semibold">
          Your pipeline
        </h2>
        <SourceBadge source="FIRST_PARTY_MEASURED" />
      </div>
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Content items" value={data.content.total} />
        <StatTile label="Published" value={data.content.published} />
        <StatTile label="Drafts generated" value={data.drafts.total} />
        <StatTile label="Research runs" value={data.research.runs} />
        <StatTile label="Findings" value={data.research.findings} />
        <StatTile label="Evidence packs" value={data.research.evidencePacksReady} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Content funnel</CardTitle>
            <p className="text-xs text-muted-foreground">
              Items by lifecycle state — real counts, no projections.
            </p>
          </CardHeader>
          <CardContent>
            {funnelRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">No content items yet.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {funnelRows.map((r) => (
                  <FunnelBar key={r.state} label={r.state} count={r.count} max={funnelMax} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Publications</CardTitle>
            <p className="text-xs text-muted-foreground">
              Scheduled placements by dispatch status.
            </p>
          </CardHeader>
          <CardContent>
            {pubStatuses.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing scheduled to publish yet.</p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {pubStatuses.map(([status, count]) => (
                  <li key={status}>
                    <Badge variant={PUB_STATUS_VARIANT[status] ?? 'secondary'}>
                      {status}: {count}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
            {data.publications.unsupported > 0 ? (
              <p className="mt-3 text-xs text-muted-foreground">
                {data.publications.unsupported} publish attempt(s) resolved to UNSUPPORTED — nothing
                was posted for them.
              </p>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

function SyncPanel({ workspaceId }: { workspaceId: string }) {
  const { can } = usePermissions();
  const canSync = can('analytics:sync');
  const runs = useSyncRuns(workspaceId);
  const start = useStartAnalyticsSync(workspaceId);
  const active = runs.data?.find(isSyncActive);
  const latest = runs.data?.[0];

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2 space-y-0">
        <div>
          <CardTitle>Sync</CardTitle>
          <p className="text-xs text-muted-foreground">
            Pulls the latest numbers from every connected platform that has an analytics adapter.
          </p>
        </div>
        {canSync ? (
          <Button
            size="sm"
            onClick={() => start.mutate({ target: 'WORKSPACE' })}
            disabled={start.isPending || Boolean(active)}
          >
            <RefreshCw aria-hidden="true" className="size-4" />
            {active ? 'Sync in progress' : 'Sync analytics now'}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!canSync ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Lock aria-hidden="true" className="size-3.5 shrink-0" />
            Starting a sync requires the{' '}
            <code className="rounded bg-muted px-1">analytics:sync</code> permission.
          </p>
        ) : null}
        {start.isError ? (
          <p role="alert" className="text-xs text-destructive">
            {start.error.message}
          </p>
        ) : null}
        {runs.isPending ? (
          <Skeleton className="h-10 w-full" />
        ) : latest ? (
          <SyncRunSummary run={latest} />
        ) : (
          <p className="text-xs text-muted-foreground">No sync has run in this workspace yet.</p>
        )}
      </CardContent>
    </Card>
  );
}

function External({ summary }: { summary: AnalyticsSummary }) {
  const byKey = new Map(summary.content.map((metric) => [metric.key, metric]));
  const partial = summary.content.some(
    (metric) => metric.contributing > 0 && metric.unavailable > 0,
  );

  if (!summary.externalAvailable) {
    return (
      <Card className="border-amber-500/40 bg-amber-500/5">
        <CardContent className="flex items-start gap-3 py-4">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-amber-600" />
          <div className="text-sm">
            <p className="font-medium">External analytics are unavailable</p>
            <p className="text-muted-foreground">{summary.note}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {summary.publishedPosts} published post(s); {summary.postsWithSnapshots} with platform
              analytics. Nothing is estimated in their place.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {partial || summary.postsWithoutAnalytics > 0 ? (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="flex items-start gap-3 py-3">
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <p className="text-xs text-muted-foreground">
              Partial analytics: {summary.postsWithSnapshots} of {summary.publishedPosts} published
              post(s) have platform analytics, and some metrics were not reported for every post.
              Totals below add up only what was reported — gaps are listed, not counted as zero.
            </p>
          </CardContent>
        </Card>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {HEADLINE_METRICS.map(([metricKey, label]) => {
          const metric = byKey.get(metricKey as never);
          return metric ? <AggregateTile key={metricKey} label={label} metric={metric} /> : null;
        })}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <AggregateTile label="Followers (latest per account)" metric={summary.followers} />
      </div>
      {summary.byPlatform.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>By platform</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-2 text-xs">
              {summary.byPlatform.map((row) => (
                <li key={row.platform} className="flex flex-wrap gap-x-3 gap-y-1">
                  <span className="w-24 font-medium">{row.platform}</span>
                  <span className="text-muted-foreground">{row.posts} post(s)</span>
                  {row.metrics.map((metric) => (
                    <span key={metric.key} className="text-muted-foreground">
                      {metric.key}:{' '}
                      <span className="tabular-nums text-foreground">
                        {metric.value === null
                          ? 'unavailable'
                          : metric.value.toLocaleString('en-US')}
                      </span>
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function PlatformStatus({ workspaceId }: { workspaceId: string }) {
  const availability = useAnalyticsAvailability(workspaceId);
  const providers = useAnalyticsProviders(workspaceId);
  const unconnected = (providers.data?.providers ?? []).filter(
    (provider) =>
      !(availability.data?.accounts ?? []).some(
        (account) => account.platform === provider.platform,
      ),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Platform analytics status</CardTitle>
        <p className="text-xs text-muted-foreground">
          What each connected account can report, and why when it cannot.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {availability.isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : availability.data && availability.data.accounts.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {availability.data.accounts.map((account) => (
              <li
                key={account.socialAccountId}
                className="rounded-md border border-border p-3 text-xs"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{account.displayName}</span>
                  <span className="text-muted-foreground">
                    {account.platform} · {account.kind.toLowerCase().replace('_', ' ')}
                  </span>
                  <Badge variant={availabilityVariant(account.availability)}>
                    {AVAILABILITY_LABEL[account.availability]}
                  </Badge>
                  <FreshnessBadge freshness={account.freshness} />
                </div>
                <p className="mt-1 text-muted-foreground">{account.reason}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            {availability.data?.note ?? 'No social accounts are connected in this workspace.'}
          </p>
        )}
        {unconnected.length > 0 ? (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              Other platforms ({unconnected.length})
            </summary>
            <ul className="mt-2 flex flex-col gap-2">
              {unconnected.map((provider) => (
                <li key={provider.platform} className="flex flex-col gap-0.5">
                  <span className="flex items-center gap-2">
                    <span className="font-medium">{provider.platform}</span>
                    <Badge variant={availabilityVariant(provider.availability)}>
                      {AVAILABILITY_LABEL[provider.availability]}
                    </Badge>
                    {provider.paidApi ? <Badge variant="warning">Paid API</Badge> : null}
                  </span>
                  <span className="text-muted-foreground">{provider.summary}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}

function UnavailableList({ workspaceId }: { workspaceId: string }) {
  const unavailable = useUnavailableMetrics(workspaceId);
  const rows = (unavailable.data?.metrics ?? []).filter(
    (row) => row.reason !== 'NOT_EXPOSED_BY_PLATFORM' && row.reason !== 'NOT_IMPLEMENTED',
  );
  const structural = (unavailable.data?.metrics ?? []).length - rows.length;
  if (unavailable.isPending || (unavailable.data?.metrics ?? []).length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Unavailable metrics</CardTitle>
        <p className="text-xs text-muted-foreground">
          Metrics platforms did not report in the latest sync, and why.{' '}
          {structural > 0
            ? `${structural} more are simply not offered by those platforms or not read by Spectra.`
            : ''}
        </p>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing fixable is missing.</p>
        ) : (
          <ul className="flex flex-col gap-1.5 text-xs">
            {rows.map((row) => (
              <li key={`${row.platform}-${row.level}-${row.metric}-${row.reason}`}>
                <span className="font-medium">{row.platform}</span>{' '}
                <span className="font-mono">{row.metric}</span>{' '}
                <Badge variant="muted">{UNAVAILABLE_REASON_LABEL[row.reason]}</Badge>{' '}
                <span className="text-muted-foreground">{row.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function CampaignLinks({ workspaceId }: { workspaceId: string }) {
  const { can } = usePermissions();
  const campaigns = useCampaigns(workspaceId);
  if (!can('campaign:read') || !campaigns.data || campaigns.data.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Campaign analytics</CardTitle>
        <p className="text-xs text-muted-foreground">
          Sums over each campaign’s published posts. Platforms have no campaign object for organic
          posts.
        </p>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-wrap gap-2 text-sm">
          {campaigns.data.map((campaign) => (
            <li key={campaign.id}>
              <Link
                className="underline underline-offset-2"
                href={`/analytics/campaigns/${campaign.id}`}
              >
                {campaign.name}
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export default function AnalyticsPage() {
  const { activeWorkspace } = useWorkspace();
  const workspaceId = activeWorkspace.id;
  const overview = useAnalyticsOverview(workspaceId);
  const summary = useAnalyticsSummary(workspaceId);

  return (
    <>
      <PageHeader
        title="Analytics"
        description="Your own pipeline counts, and the engagement platforms actually reported for your published posts. Unavailable metrics are shown as unavailable, with the reason — never as zero, never estimated."
      />
      {overview.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : overview.isError ? (
        <EmptyState
          icon={<BarChart3 />}
          title="Could not load analytics"
          description={overview.error.message}
        />
      ) : (
        <div className="flex flex-col gap-8">
          <FirstParty data={overview.data} />

          <section aria-labelledby="external-heading" className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="external-heading" className="text-base font-semibold">
                Platform engagement
              </h2>
              <SourceBadge source="EXTERNAL_MEASURED" />
              {summary.data ? <FreshnessBadge freshness={summary.data.freshness} /> : null}
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <SyncPanel workspaceId={workspaceId} />
              <PlatformStatus workspaceId={workspaceId} />
            </div>
            {summary.isPending ? (
              <Skeleton className="h-32 w-full" />
            ) : summary.isError ? (
              <p className="text-sm text-destructive">{summary.error.message}</p>
            ) : (
              <External summary={summary.data} />
            )}
            <UnavailableList workspaceId={workspaceId} />
            <CampaignLinks workspaceId={workspaceId} />
          </section>
        </div>
      )}
    </>
  );
}
