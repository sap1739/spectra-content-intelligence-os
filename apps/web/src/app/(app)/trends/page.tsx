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
import { TrendingUp } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { useWorkspace } from '@/lib/auth';
import { useTrends, type TrendRow } from '@/lib/research';

const STATE_VARIANT: Record<string, 'success' | 'secondary' | 'warning' | 'muted' | 'destructive'> =
  {
    EMERGING: 'success',
    ACCELERATING: 'success',
    PEAKING: 'warning',
    STABLE: 'secondary',
    DECLINING: 'muted',
    SEASONAL: 'secondary',
    EVERGREEN: 'secondary',
    UNVERIFIED: 'muted',
    REJECTED: 'destructive',
  };

function ScoreBar({ label, value }: { label: string; value: number }) {
  const width = Math.round(Math.min(1, Math.max(0, Math.abs(value))) * 100);
  const negative = value < 0;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-36 shrink-0 truncate text-muted-foreground">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className={negative ? 'h-full bg-destructive/70' : 'h-full bg-primary/80'}
          style={{ width: `${width}%` }}
        />
      </div>
      <span className="w-12 shrink-0 text-right tabular-nums text-muted-foreground">
        {value >= 0 ? '+' : ''}
        {value.toFixed(2)}
      </span>
    </div>
  );
}

function TrendCard({ trend }: { trend: TrendRow }) {
  const [expanded, setExpanded] = React.useState(false);
  const score = trend.latestScore;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="capitalize">{trend.title}</CardTitle>
          {trend.summary ? (
            <p className="mt-1 text-xs text-muted-foreground">{trend.summary}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="text-2xl font-semibold tabular-nums">
            {score ? score.displayScore.toFixed(1) : '—'}
          </span>
          <Badge variant={STATE_VARIANT[trend.state] ?? 'muted'}>{trend.state}</Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {score ? (
          <>
            <p className="text-xs text-muted-foreground">{score.explanation.headline}</p>
            {expanded ? (
              <div className="flex flex-col gap-1.5">
                {score.components.map((component) => (
                  <ScoreBar
                    key={component.key}
                    label={component.key}
                    value={component.weightedValue}
                  />
                ))}
                {score.explanation.riskFlags.length > 0 ? (
                  <ul className="mt-1 flex flex-col gap-1">
                    {score.explanation.riskFlags.map((flag) => (
                      <li key={flag} className="text-xs text-amber-600 dark:text-amber-400">
                        ⚠ {flag}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Scored with {score.configId}@{score.configVersion} at{' '}
                  {new Date(score.computedAt).toLocaleString()}
                </p>
              </div>
            ) : null}
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {trend.sourceIds.length} source(s) · {trend.findingIds.length} finding(s)
                {trend.lastSeenAt
                  ? ` · last seen ${new Date(trend.lastSeenAt).toLocaleDateString()}`
                  : ''}
              </span>
              <Button variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)}>
                {expanded ? 'Hide breakdown' : 'Why this score?'}
              </Button>
            </div>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">Not scored yet.</p>
        )}
      </CardContent>
    </Card>
  );
}

export default function TrendsPage() {
  const { activeWorkspace } = useWorkspace();
  const trends = useTrends(activeWorkspace.id);

  return (
    <>
      <PageHeader
        title="Trends"
        description="Trend candidates detected from your research, scored with a versioned formula — every score is explainable."
      />

      {trends.isPending ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-36 w-full" />
          <Skeleton className="h-36 w-full" />
        </div>
      ) : trends.isError ? (
        <EmptyState
          icon={<TrendingUp />}
          title="Could not load trends"
          description={trends.error.message}
          action={
            <Button variant="outline" onClick={() => trends.refetch()}>
              Retry
            </Button>
          }
        />
      ) : trends.data.length === 0 ? (
        <EmptyState
          icon={<TrendingUp />}
          title="No trends detected yet"
          description="Trends are derived from research findings matched against your vertical keywords. Create a vertical with keywords, then run research over your feeds — nothing here is ever fabricated."
          action={
            <Link
              href="/research"
              className="text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              Go to Research
            </Link>
          }
        />
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">
          {trends.data.map((trend) => (
            <li key={trend.id}>
              <TrendCard trend={trend} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
