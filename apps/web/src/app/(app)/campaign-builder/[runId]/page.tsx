'use client';

import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Skeleton } from '@spectra/ui';
import { AlertTriangle, ArrowLeft, Ban, Calendar, Link2, X } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';

import { PageHeader } from '@/components/page-header';
import { usePermissions, useWorkspace } from '@/lib/auth';
import {
  RUN_STATUS_VARIANT,
  VERDICT_VARIANT,
  useCancelOrchestration,
  useOrchestrationCapabilities,
  useOrchestrationRun,
} from '@/lib/orchestration';

/**
 * One orchestration run: its stages, the strategy it derived, the calendar it
 * planned, and every item with the evidence verdict that decided whether it was
 * written. Blocked topics are shown, not hidden — that is the whole point.
 */
export default function RunPage() {
  const params = useParams<{ runId: string }>();
  const runId = params.runId;
  const { activeWorkspace } = useWorkspace();
  const workspaceId = activeWorkspace.id;
  const { can } = usePermissions();
  const canOrchestrate = can('campaign:orchestrate');

  const detail = useOrchestrationRun(workspaceId, runId);
  const capabilities = useOrchestrationCapabilities(workspaceId);
  const cancel = useCancelOrchestration(workspaceId);

  if (detail.isLoading) return <Skeleton className="h-64 w-full" />;
  if (detail.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {detail.error.message}
      </p>
    );
  }

  const { run, failureText } = detail.data!;
  const strategy = run.strategy;
  const plan = run.plan;
  const active = run.status === 'QUEUED' || run.status === 'RUNNING';

  return (
    <div className="space-y-6">
      <Link
        href="/campaign-builder"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowLeft aria-hidden className="size-4" /> Back to campaign builder
      </Link>
      <PageHeader title={run.name} />

      <Card>
        <CardContent className="space-y-3 pt-6">
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant={RUN_STATUS_VARIANT[run.status]}>{run.status}</Badge>
            <span className="text-sm text-muted-foreground">
              {run.itemsCreated} created · {run.itemsDrafted} drafted · {run.itemsBlocked} blocked
              {run.itemsFailed > 0 ? ` · ${run.itemsFailed} failed` : ''}
            </span>
            {run.campaignId ? (
              <Link
                href={`/campaigns/${run.campaignId}`}
                className="text-sm underline-offset-2 hover:underline"
              >
                Open campaign
              </Link>
            ) : null}
            {canOrchestrate && active ? (
              <Button
                size="sm"
                variant="outline"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate(run.id)}
              >
                <X aria-hidden className="size-4" /> Cancel
              </Button>
            ) : null}
          </div>

          {active ? (
            <div
              role="progressbar"
              aria-valuenow={run.progressPercent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Run progress"
              className="h-2 w-full overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${run.progressPercent}%` }}
              />
            </div>
          ) : null}

          {failureText ? (
            <div role="alert" className="space-y-1 text-sm text-destructive">
              <p>{failureText}</p>
              {run.failureDetail ? (
                <p className="text-xs text-muted-foreground">{run.failureDetail}</p>
              ) : null}
            </div>
          ) : null}

          <ol className="space-y-1 text-sm" data-testid="stages">
            {run.stages.map((stage) => (
              <li key={stage.stage} className="flex flex-wrap items-center gap-2">
                <Badge
                  variant={
                    stage.status === 'SUCCEEDED'
                      ? 'success'
                      : stage.status === 'FAILED'
                        ? 'destructive'
                        : stage.status === 'RUNNING'
                          ? 'warning'
                          : 'muted'
                  }
                >
                  {stage.status}
                </Badge>
                <span className="font-medium">{stage.stage.replace(/_/g, ' ').toLowerCase()}</span>
                {stage.note ? <span className="text-muted-foreground">{stage.note}</span> : null}
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      {strategy ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Strategy</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <p className="text-xs text-muted-foreground">
              Derived by {strategy.engineVersion}. Every element traces to a trend, a keyword or the
              platform capability matrix.
            </p>
            {strategy.warnings.length > 0 ? (
              <div className="space-y-1" data-testid="strategy-warnings">
                <p className="flex items-center gap-2 font-medium">
                  <AlertTriangle aria-hidden className="size-4" /> Worth knowing
                </p>
                <ul className="list-inside list-disc text-muted-foreground">
                  {strategy.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="font-medium">Objectives</p>
                <ul className="list-inside list-disc text-muted-foreground">
                  {strategy.objectives.map((objective) => (
                    <li key={objective.key}>{objective.name}</li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="font-medium">Pillars</p>
                <ul className="list-inside list-disc text-muted-foreground">
                  {strategy.pillars.map((pillar) => (
                    <li key={pillar.key}>{pillar.name}</li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="font-medium">Audience</p>
                <ul className="list-inside list-disc text-muted-foreground">
                  {strategy.personas.map((persona) => (
                    <li key={persona.key}>
                      {persona.name} <Badge variant="muted">{persona.source}</Badge>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="font-medium">Calls to action</p>
                <ul className="list-inside list-disc text-muted-foreground">
                  {strategy.ctaSuggestions.map((cta) => (
                    <li key={cta.funnelStage}>
                      {cta.funnelStage}: “{cta.text}”
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <div>
              <p className="font-medium">Platforms</p>
              <ul className="space-y-1 text-muted-foreground" data-testid="platform-strategy">
                {strategy.platforms.map((platform) => (
                  <li key={platform.platform}>
                    <span className="font-medium">{platform.platform}</span> —{' '}
                    {platform.plannedItems} item(s).{' '}
                    {platform.publishingAvailable ? null : (
                      <span className="text-amber-700 dark:text-amber-400">
                        {platform.publishingNote}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {plan ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Calendar</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              {new Date(plan.startAt).toLocaleDateString()} →{' '}
              {new Date(plan.endAt).toLocaleDateString()} · {plan.items.length} slot(s)
            </p>
            <ul className="divide-y divide-border" data-testid="calendar">
              {plan.items.map((item) => (
                <li
                  key={item.key}
                  className="flex flex-wrap items-center justify-between gap-2 py-2"
                >
                  <span className="min-w-0">
                    <Calendar aria-hidden className="mr-1 inline size-3.5 text-muted-foreground" />
                    <span className="font-medium">{item.title}</span>{' '}
                    <span className="text-muted-foreground">
                      {item.platform} · {new Date(item.scheduledAt).toLocaleString()}
                    </span>
                  </span>
                  <Badge variant={VERDICT_VARIANT[item.evidence.verdict]}>
                    {item.evidence.verdict.replace(/_/g, ' ')}
                  </Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Items</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <ul className="divide-y divide-border" data-testid="items">
            {run.items.map((item, index) => (
              <li key={`${item.key}-${index}`} className="space-y-1 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  {item.outcome === 'BLOCKED' ? (
                    <Ban aria-hidden className="size-4 text-destructive" />
                  ) : null}
                  <span className="font-medium">{item.title}</span>
                  <Badge
                    variant={
                      item.outcome === 'DRAFTED'
                        ? 'success'
                        : item.outcome === 'BLOCKED'
                          ? 'destructive'
                          : 'muted'
                    }
                  >
                    {item.outcome.replace(/_/g, ' ')}
                  </Badge>
                  <Badge variant={VERDICT_VARIANT[item.evidence.verdict]}>
                    {item.evidence.verdict.replace(/_/g, ' ')}
                  </Badge>
                </div>
                <p className="text-muted-foreground">
                  {capabilities.data?.evidenceVerdicts[item.evidence.verdict] ??
                    item.evidence.reason}
                </p>
                {item.note ? <p className="text-muted-foreground">{item.note}</p> : null}
                {item.evidence.findingIds.length > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    <Link2 aria-hidden className="mr-1 inline size-3" />
                    {item.evidence.findingIds.length} finding(s)
                    {item.evidence.citationIds.length > 0
                      ? `, ${item.evidence.citationIds.length} citation(s)`
                      : ''}
                    {item.evidence.evidencePackId ? ', from an evidence pack' : ''}
                  </p>
                ) : null}
                {item.contentItemId ? (
                  <Link
                    href={`/content/${item.contentItemId}`}
                    className="text-xs underline-offset-2 hover:underline"
                  >
                    Open content item
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Drafted items are routed for review. Nothing is scheduled or published until a person
            approves it.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
