'use client';

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Label,
  Skeleton,
} from '@spectra/ui';
import { Eye, TrendingUp, X } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { useWorkspace } from '@/lib/auth';
import { useTrends, type TrendRow } from '@/lib/research';
import { useCreateWatchlist, useDeleteWatchlist, useWatchlists } from '@/lib/team';

function WatchlistsPanel({ workspaceId }: { workspaceId: string }) {
  const watchlists = useWatchlists(workspaceId);
  const create = useCreateWatchlist(workspaceId);
  const remove = useDeleteWatchlist(workspaceId);
  const [name, setName] = React.useState('');
  const [keywords, setKeywords] = React.useState('');
  const [threshold, setThreshold] = React.useState('70');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const parsedKeywords = keywords
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    if (!name.trim() || parsedKeywords.length === 0) return;
    await create.mutateAsync({
      name: name.trim(),
      keywords: parsedKeywords,
      threshold: Math.min(1, Math.max(0.1, Number(threshold) / 100)),
    });
    setName('');
    setKeywords('');
  };

  return (
    <Card className="mb-6">
      <CardHeader className="flex-row items-center gap-2 space-y-0">
        <Eye aria-hidden="true" className="size-4 text-muted-foreground" />
        <CardTitle>Watchlists</CardTitle>
        <p className="ml-2 text-xs text-muted-foreground">
          Get an alert when a watched topic first crosses its score threshold.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[1fr_1.5fr_6rem_auto]">
          <div className="flex flex-col gap-1">
            <Label htmlFor="wl-name">Name</Label>
            <Input
              id="wl-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Competitive AI"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="wl-keywords">Keywords (comma-separated)</Label>
            <Input
              id="wl-keywords"
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              placeholder="AI, security"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="wl-threshold">Threshold</Label>
            <Input
              id="wl-threshold"
              type="number"
              min={10}
              max={100}
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
            />
          </div>
          <div className="flex items-end">
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Saving…' : 'Watch'}
            </Button>
          </div>
        </form>
        {create.isError ? (
          <p role="alert" className="text-xs text-destructive">
            {create.error.message}
          </p>
        ) : null}
        {(watchlists.data ?? []).length > 0 ? (
          <ul className="flex flex-wrap gap-2">
            {(watchlists.data ?? []).map((wl) => (
              <li
                key={wl.id}
                className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs"
              >
                <span className="font-medium">{wl.name}</span>
                <span className="text-muted-foreground">
                  {wl.keywords.join(', ')} ≥ {(wl.threshold * 100).toFixed(0)}
                </span>
                <button
                  type="button"
                  aria-label={`Delete watchlist ${wl.name}`}
                  className="text-muted-foreground hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-full"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(wl.id)}
                >
                  <X aria-hidden="true" className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

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

      <WatchlistsPanel workspaceId={activeWorkspace.id} />

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
