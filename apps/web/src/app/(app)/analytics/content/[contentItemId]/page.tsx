'use client';

import {
  Badge,
  Button,
  Card,
  buttonVariants,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Skeleton,
} from '@spectra/ui';
import { ArrowLeft, BarChart3, ExternalLink, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import * as React from 'react';

import { FreshnessBadge, MetricTable, SourceBadge } from '@/components/analytics';
import { PageHeader } from '@/components/page-header';
import { usePermissions, useWorkspace } from '@/lib/auth';
import { formatMetricValue, useContentAnalytics, useStartAnalyticsSync } from '@/lib/analytics';

/**
 * Per-post analytics for one content item (ADR-0039): every placement, its
 * latest platform snapshot as a table (value or reason, quality, the
 * platform's own field name), and earlier retrievals as a plain list. No trend
 * line is drawn — a handful of retrievals is not a trend.
 */
export default function ContentAnalyticsPage() {
  const params = useParams<{ contentItemId: string }>();
  const contentItemId = params.contentItemId;
  const { activeWorkspace } = useWorkspace();
  const { can } = usePermissions();
  const analytics = useContentAnalytics(activeWorkspace.id, contentItemId);
  const sync = useStartAnalyticsSync(activeWorkspace.id);

  return (
    <>
      <PageHeader
        title={analytics.data ? analytics.data.item.title : 'Post analytics'}
        description="What each platform reported for this content, retrieved by Spectra. Unavailable metrics say why."
        actions={
          <Link href="/analytics" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
            <ArrowLeft aria-hidden="true" className="size-4" />
            Analytics
          </Link>
        }
      />
      {analytics.isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : analytics.isError ? (
        <EmptyState
          icon={<BarChart3 />}
          title="Could not load post analytics"
          description={analytics.error.message}
        />
      ) : analytics.data.entries.length === 0 ? (
        <EmptyState
          icon={<BarChart3 />}
          title="Not scheduled anywhere"
          description="This content has no calendar placements, so there are no platform analytics."
        />
      ) : (
        <div className="flex flex-col gap-4">
          {sync.isError ? (
            <p role="alert" className="text-xs text-destructive">
              {sync.error.message}
            </p>
          ) : null}
          {analytics.data.entries.map((entry) => (
            <Card key={entry.scheduleEntryId}>
              <CardHeader className="gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    {entry.platform}
                    <Badge variant="secondary">{entry.status}</Badge>
                    {entry.latest ? (
                      <Badge variant="outline">{entry.latest.completeness.toLowerCase()}</Badge>
                    ) : null}
                  </CardTitle>
                  <div className="flex flex-wrap items-center gap-2">
                    <SourceBadge source={entry.latest ? 'EXTERNAL_MEASURED' : 'UNAVAILABLE'} />
                    <FreshnessBadge freshness={entry.freshness} />
                    {can('analytics:sync') && entry.status === 'PUBLISHED' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={sync.isPending}
                        onClick={() =>
                          sync.mutate({
                            target: 'SCHEDULE_ENTRY',
                            scheduleEntryId: entry.scheduleEntryId,
                          })
                        }
                      >
                        <RefreshCw aria-hidden="true" className="size-3.5" />
                        Sync this post
                      </Button>
                    ) : null}
                  </div>
                </div>
                <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                  {entry.publishedAt ? (
                    <span>Published {new Date(entry.publishedAt).toLocaleString()}</span>
                  ) : null}
                  {entry.externalUrl ? (
                    <a
                      href={entry.externalUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 underline underline-offset-2"
                    >
                      View post <ExternalLink aria-hidden="true" className="size-3" />
                    </a>
                  ) : null}
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {entry.latest ? (
                  <>
                    {entry.latest.completeness !== 'COMPLETE' ? (
                      <p className="text-xs text-amber-700 dark:text-amber-400">
                        Partial: some metrics could have been read but were not (see reasons below).
                      </p>
                    ) : null}
                    <MetricTable metrics={entry.latest.metrics} />
                    {entry.latest.notes.length > 0 ? (
                      <ul className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
                        {entry.latest.notes.map((note) => (
                          <li key={note}>{note}</li>
                        ))}
                      </ul>
                    ) : null}
                    {entry.history.length > 0 ? (
                      <details className="text-xs">
                        <summary className="cursor-pointer text-muted-foreground">
                          Earlier retrievals ({entry.history.length})
                        </summary>
                        <ul className="mt-2 flex flex-col gap-1">
                          {entry.history.map((row) => (
                            <li key={row.snapshotId} className="text-muted-foreground">
                              {new Date(row.retrievedAt).toLocaleString()}:{' '}
                              {row.metrics
                                .map((metric) => `${metric.key} ${formatMetricValue(metric)}`)
                                .join(' · ') || 'no values'}
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No platform analytics. {entry.unavailableReason}
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
