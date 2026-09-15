'use client';

import {
  Badge,
  Card,
  buttonVariants,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Skeleton,
} from '@spectra/ui';
import { ArrowLeft, BarChart3 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import * as React from 'react';

import { AggregateTile, FreshnessBadge, SourceBadge } from '@/components/analytics';
import { PageHeader } from '@/components/page-header';
import { useWorkspace } from '@/lib/auth';
import { formatMetricValue, useCampaignAnalytics } from '@/lib/analytics';

const TILES: Array<[string, string]> = [
  ['views', 'Views'],
  ['impressions', 'Impressions'],
  ['likes', 'Likes'],
  ['reactions', 'Reactions'],
  ['comments', 'Comments'],
  ['shares', 'Shares'],
  ['clicks', 'Clicks'],
  ['engagementRate', 'Engagement rate'],
];

/** Campaign analytics: a labelled sum over the campaign's published posts (ADR-0039). */
export default function CampaignAnalyticsPage() {
  const params = useParams<{ campaignId: string }>();
  const { activeWorkspace } = useWorkspace();
  const result = useCampaignAnalytics(activeWorkspace.id, params.campaignId);

  return (
    <>
      <PageHeader
        title={result.data ? `${result.data.campaign.name} — analytics` : 'Campaign analytics'}
        description="Spectra’s sum over this campaign’s published posts. Organic platform APIs have no campaign object, and posts without analytics are listed rather than counted as zero."
        actions={
          <Link href="/analytics" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
            <ArrowLeft aria-hidden="true" className="size-4" />
            Analytics
          </Link>
        }
      />
      {result.isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : result.isError ? (
        <EmptyState
          icon={<BarChart3 />}
          title="Could not load campaign analytics"
          description={result.error.message}
        />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <SourceBadge source="EXTERNAL_MEASURED" />
            <FreshnessBadge freshness={result.data.analytics.freshness} />
            <span>
              {result.data.analytics.postsWithAnalytics} of {result.data.analytics.publishedPosts}{' '}
              published post(s) have platform analytics
            </span>
          </div>
          {result.data.analytics.publishedPosts === 0 ? (
            <EmptyState
              icon={<BarChart3 />}
              title="Nothing published yet"
              description="This campaign has no published posts, so there is nothing to measure."
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {TILES.map(([key, label]) => {
                const metric = result.data.analytics.metrics.find((m) => m.key === key);
                return metric ? <AggregateTile key={key} label={label} metric={metric} /> : null;
              })}
            </div>
          )}
          {result.data.posts.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Posts</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col gap-2 text-xs">
                  {result.data.posts.map((post) => (
                    <li key={post.scheduleEntryId} className="flex flex-wrap items-center gap-2">
                      <Link
                        className="font-medium underline underline-offset-2"
                        href={`/analytics/content/${post.contentItemId}`}
                      >
                        {post.title}
                      </Link>
                      <Badge variant="muted">{post.platform}</Badge>
                      {post.snapshot ? (
                        <span className="text-muted-foreground">
                          {post.snapshot.metrics
                            .filter((metric) => metric.value !== null)
                            .slice(0, 4)
                            .map((metric) => `${metric.key} ${formatMetricValue(metric)}`)
                            .join(' · ') || 'no values reported'}
                        </span>
                      ) : (
                        <Badge variant="warning">No analytics yet</Badge>
                      )}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}
        </div>
      )}
    </>
  );
}
