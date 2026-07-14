'use client';

import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState, Skeleton } from '@spectra/ui';
import { BarChart3, TriangleAlert } from 'lucide-react';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { useWorkspace } from '@/lib/auth';
import { useAnalyticsOverview, type AnalyticsOverview } from '@/lib/analytics';

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

function Overview({ data }: { data: AnalyticsOverview }) {
  const funnelRows = FUNNEL_ORDER.map((state) => ({
    state,
    count: data.content.byLifecycleState[state] ?? 0,
  })).filter((r) => r.count > 0);
  const funnelMax = Math.max(1, ...funnelRows.map((r) => r.count));
  const pubStatuses = Object.entries(data.publications.byStatus);

  return (
    <div className="flex flex-col gap-6">
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
                {data.publications.unsupported} publish attempt(s) resolved to UNSUPPORTED — no
                platform adapter is wired, so nothing was posted.
              </p>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <Card className="border-amber-500/40 bg-amber-500/5">
        <CardContent className="flex items-start gap-3 py-4">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-amber-600" />
          <div className="text-sm">
            <p className="font-medium">External engagement metrics are unavailable</p>
            <p className="text-muted-foreground">{data.engagement.note}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function AnalyticsPage() {
  const { activeWorkspace } = useWorkspace();
  const overview = useAnalyticsOverview(activeWorkspace.id);

  return (
    <>
      <PageHeader
        title="Analytics"
        description="Real reporting over your workspace — the content funnel, drafts, publications and research. External platform engagement appears once a platform is connected; no metrics are ever fabricated."
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
        <Overview data={overview.data} />
      )}
    </>
  );
}
