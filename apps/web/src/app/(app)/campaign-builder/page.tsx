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
import { Info, Lock, Workflow } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { usePermissions, useWorkspace } from '@/lib/auth';
import {
  DEFAULT_PLATFORMS,
  RUN_STATUS_VARIANT,
  useOrchestrationCapabilities,
  useOrchestrationRuns,
  useStartOrchestration,
} from '@/lib/orchestration';
import { useTrends } from '@/lib/research';
import { useVerticals } from '@/lib/verticals';

/**
 * The campaign wizard (Phase 7D, ADR-0043). Three honest things it must say
 * before a user starts: where the strategy comes from (derived, not invented),
 * whether drafts can be written at all, and that nothing it builds is
 * published without a person approving it.
 */
export default function CampaignBuilderPage() {
  const router = useRouter();
  const { activeWorkspace } = useWorkspace();
  const workspaceId = activeWorkspace.id;
  const { can } = usePermissions();
  const canOrchestrate = can('campaign:orchestrate');

  const capabilities = useOrchestrationCapabilities(workspaceId);
  const runs = useOrchestrationRuns(workspaceId);
  const trends = useTrends(workspaceId);
  const verticals = useVerticals(workspaceId);
  const start = useStartOrchestration(workspaceId);

  const [name, setName] = React.useState('');
  const [verticalId, setVerticalId] = React.useState('');
  const [selectedTrends, setSelectedTrends] = React.useState<string[]>([]);
  const [platforms, setPlatforms] = React.useState<string[]>(['LINKEDIN']);
  const [itemsPerTrend, setItemsPerTrend] = React.useState(2);
  const [durationDays, setDurationDays] = React.useState(14);

  const scored = (trends.data ?? [])
    .filter((trend) => typeof trend.normalizedScore === 'number')
    .sort((a, b) => (b.normalizedScore ?? 0) - (a.normalizedScore ?? 0));

  const plannedItems = Math.max(selectedTrends.length, 1) * itemsPerTrend;
  const ready = Boolean(name.trim() && verticalId && platforms.length > 0);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!ready) return;
    const created = await start.mutateAsync({
      name: name.trim(),
      verticalId,
      trendCandidateIds: selectedTrends,
      platforms: platforms as never,
      startAt: new Date(Date.now() + 86_400_000).toISOString(),
      durationDays,
      itemsPerTrend,
      minTrendScore: 0.5,
      maxTrends: 5,
      timezone: 'UTC',
      generateDrafts: true,
      scheduleApproved: false,
    } as never);
    router.push(`/campaign-builder/${created.run.id}`);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Campaign builder"
        description="Turn scored research into a campaign — strategy, calendar and content, each linked to the evidence behind it."
      />

      <Card>
        <CardContent className="flex flex-col gap-3 pt-6 text-sm sm:flex-row sm:items-start">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="space-y-2">
            <p className="font-medium">Derived from research, not invented</p>
            <p className="text-muted-foreground" data-testid="engine-note">
              {capabilities.data?.strategyEngine.note ??
                'Objectives, pillars, topics and CTAs are derived from your vertical, the scored trends and the evidence behind them.'}
            </p>
            {capabilities.isLoading ? (
              <Skeleton className="h-4 w-80" />
            ) : capabilities.data?.generation.available ? (
              <p className="text-muted-foreground" data-testid="generation-state">
                {capabilities.data.generation.reason}
              </p>
            ) : (
              <p
                className="text-amber-700 dark:text-amber-400"
                data-testid="generation-unavailable"
              >
                {capabilities.data?.generation.reason}
              </p>
            )}
            <p className="text-muted-foreground">
              Nothing is published automatically. Generated items go to review, and a person
              approves and schedules them.
            </p>
          </div>
        </CardContent>
      </Card>

      {canOrchestrate ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">New campaign</CardTitle>
          </CardHeader>
          <CardContent>
            <form className="space-y-5" onSubmit={submit}>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="campaign-name">Name</Label>
                  <Input
                    id="campaign-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Q4 storage push"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="campaign-vertical">Start from</Label>
                  <select
                    id="campaign-vertical"
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                    value={verticalId}
                    onChange={(event) => setVerticalId(event.target.value)}
                    required
                  >
                    <option value="">Choose a vertical…</option>
                    {(verticals.data ?? []).map((vertical) => (
                      <option key={vertical.id} value={vertical.id}>
                        {vertical.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Trends</legend>
                {trends.isLoading ? (
                  <Skeleton className="h-20 w-full" />
                ) : scored.length === 0 ? (
                  <p className="text-sm text-muted-foreground" data-testid="no-trends">
                    No scored trends yet. Run research and trend scoring first — a campaign is built
                    on evidence, so there is nothing to build from until then.
                  </p>
                ) : (
                  <ul className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border p-2">
                    {scored.map((trend) => (
                      <li key={trend.id}>
                        <label className="flex items-start gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted">
                          <input
                            type="checkbox"
                            className="mt-1"
                            checked={selectedTrends.includes(trend.id)}
                            onChange={(event) =>
                              setSelectedTrends((previous) =>
                                event.target.checked
                                  ? [...previous, trend.id]
                                  : previous.filter((id) => id !== trend.id),
                              )
                            }
                          />
                          <span className="min-w-0">
                            <span className="font-medium">{trend.title}</span>{' '}
                            <Badge variant="muted">
                              {((trend.normalizedScore ?? 0) * 100).toFixed(0)}
                            </Badge>
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-muted-foreground">
                  Leave all unselected to let Spectra pick the highest-scoring trends.
                </p>
              </fieldset>

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Platforms</legend>
                <div className="flex flex-wrap gap-3">
                  {DEFAULT_PLATFORMS.map((platform) => (
                    <label key={platform} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={platforms.includes(platform)}
                        onChange={(event) =>
                          setPlatforms((previous) =>
                            event.target.checked
                              ? [...previous, platform]
                              : previous.filter((value) => value !== platform),
                          )
                        }
                      />
                      {platform}
                    </label>
                  ))}
                </div>
              </fieldset>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="items-per-trend">Items per trend ({itemsPerTrend})</Label>
                  <input
                    id="items-per-trend"
                    type="range"
                    min={1}
                    max={5}
                    value={itemsPerTrend}
                    onChange={(event) => setItemsPerTrend(Number(event.target.value))}
                    className="w-full"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="duration-days">Campaign length ({durationDays} days)</Label>
                  <input
                    id="duration-days"
                    type="range"
                    min={3}
                    max={60}
                    value={durationDays}
                    onChange={(event) => setDurationDays(Number(event.target.value))}
                    className="w-full"
                  />
                </div>
              </div>

              <p className="text-sm text-muted-foreground" data-testid="plan-preview">
                About {plannedItems} item{plannedItems === 1 ? '' : 's'} across {platforms.length}{' '}
                platform{platforms.length === 1 ? '' : 's'} over {durationDays} days. Topics without
                usable evidence are blocked and listed, not written.
              </p>

              {start.isError ? (
                <p role="alert" className="text-sm text-destructive">
                  {start.error.message}
                </p>
              ) : null}
              <Button type="submit" disabled={!ready || start.isPending}>
                Build campaign
              </Button>
            </form>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="flex items-start gap-3 pt-6 text-sm text-muted-foreground">
            <Lock aria-hidden className="mt-0.5 size-4 shrink-0" />
            <p>
              Building a campaign needs the{' '}
              <code className="rounded bg-muted px-1">campaign:orchestrate</code> permission.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Runs</CardTitle>
        </CardHeader>
        <CardContent>
          {runs.isLoading ? (
            <Skeleton className="h-20 w-full" />
          ) : (runs.data?.runs.length ?? 0) === 0 ? (
            <EmptyState
              icon={<Workflow aria-hidden className="size-6" />}
              title="No campaigns built yet"
              description="A run walks research → trends → strategy → plan → calendar → content, and records every step."
            />
          ) : (
            <ul className="divide-y divide-border">
              {runs.data?.runs.map((run) => (
                <li key={run.id} className="flex items-center justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <Link
                      href={`/campaign-builder/${run.id}`}
                      className="font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {run.name}
                    </Link>
                    <p className="text-sm text-muted-foreground">
                      {run.itemsCreated} created · {run.itemsDrafted} drafted · {run.itemsBlocked}{' '}
                      blocked
                    </p>
                  </div>
                  <Badge variant={RUN_STATUS_VARIANT[run.status]}>{run.status}</Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
