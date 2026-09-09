'use client';

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Label,
  Skeleton,
  Spinner,
  cn,
} from '@spectra/ui';
import { ArrowLeft, Check, ExternalLink, FlaskConical, Play, X } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { useWorkspace } from '@/lib/auth';
import { useCapabilities, useClaims, useEvidencePacks, type ClaimRow } from '@/lib/knowledge';
import { useClearSchedule, useSetSchedule } from '@/lib/team';
import {
  isRunActive,
  useFindings,
  useResearchProject,
  useReviewFinding,
  useRunQuality,
  useRuns,
  useStartRun,
  type FindingRow,
  type RunRow,
} from '@/lib/research';

const CLAIM_BADGE: Record<string, 'success' | 'secondary' | 'muted' | 'warning'> = {
  CORROBORATED: 'success',
  VERIFIED: 'success',
  UNVERIFIED: 'muted',
  DISPUTED: 'warning',
};

function EvidencePacksSection({
  workspaceId,
  projectId,
}: {
  workspaceId: string;
  projectId: string;
}) {
  const packs = useEvidencePacks(workspaceId, projectId);
  const claims = useClaims(workspaceId, projectId);
  const [openPackId, setOpenPackId] = React.useState<string | null>(null);
  const claimById = new Map((claims.data ?? []).map((c) => [c.id, c]));

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>Evidence packs</CardTitle>
        <p className="text-xs text-muted-foreground">
          One living bundle per trend topic — findings, extracted claims and citations, ready for
          content generation in Phase 3.
        </p>
      </CardHeader>
      <CardContent>
        {packs.isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : (packs.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No evidence packs yet — they are generated when research runs detect topics from your
            vertical keywords.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {(packs.data ?? []).map((pack) => {
              const open = openPackId === pack.id;
              const packClaims = pack.claimIds
                .map((id) => claimById.get(id))
                .filter((c): c is ClaimRow => Boolean(c));
              return (
                <li key={pack.id} className="rounded-md border border-border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium">{pack.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {pack.findingIds.length} findings · {pack.claimIds.length} claims ·{' '}
                        {pack.citationIds.length} citations · updated{' '}
                        {new Date(pack.updatedAt).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={pack.status === 'READY' ? 'success' : 'muted'}>
                        {pack.status}
                      </Badge>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-expanded={open}
                        onClick={() => setOpenPackId(open ? null : pack.id)}
                      >
                        {open ? 'Hide claims' : 'View claims'}
                      </Button>
                    </div>
                  </div>
                  {open ? (
                    packClaims.length === 0 ? (
                      <p className="mt-2 text-xs text-muted-foreground">
                        No extracted claims in this pack yet.
                      </p>
                    ) : (
                      <ul className="mt-3 flex flex-col gap-2 border-t border-border pt-3">
                        {packClaims.map((claim) => (
                          <li key={claim.id} className="flex items-start justify-between gap-2">
                            <p className="text-xs leading-snug">{claim.text}</p>
                            <span className="flex shrink-0 gap-1">
                              <Badge variant="outline">{claim.claimType}</Badge>
                              <Badge variant={CLAIM_BADGE[claim.verificationStatus] ?? 'muted'}>
                                {claim.verificationStatus}
                                {claim.sourceCount > 1 ? ` ×${claim.sourceCount}` : ''}
                              </Badge>
                            </span>
                          </li>
                        ))}
                      </ul>
                    )
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

const RUN_BADGE: Record<
  RunRow['status'],
  'success' | 'secondary' | 'warning' | 'destructive' | 'muted'
> = {
  PENDING: 'secondary',
  QUEUED: 'secondary',
  RUNNING: 'warning',
  SUCCEEDED: 'success',
  PARTIALLY_SUCCEEDED: 'warning',
  FAILED: 'destructive',
  CANCELLED: 'muted',
};

const REVIEW_TABS = [
  { key: 'PENDING_REVIEW', label: 'Pending review' },
  { key: 'VALIDATED', label: 'Validated' },
  { key: 'REJECTED', label: 'Rejected' },
] as const;

function parseFeedUrls(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

const ROBOTS_LABEL: Record<
  string,
  { text: string; variant: 'success' | 'destructive' | 'warning' | 'muted' }
> = {
  ALLOWED: { text: 'robots: allowed', variant: 'success' },
  DISALLOWED: { text: 'robots: blocked', variant: 'destructive' },
  UNAVAILABLE: { text: 'robots: unverified', variant: 'warning' },
  NOT_CHECKED: { text: 'robots: n/a', variant: 'muted' },
};

const STALENESS_VARIANT: Record<string, 'success' | 'warning' | 'destructive' | 'muted'> = {
  FRESH: 'success',
  AGING: 'warning',
  STALE: 'destructive',
  EVERGREEN: 'success',
  UNKNOWN: 'muted',
};

/** Per-source quality for one run. Never invents a score it does not have. */
function RunQualityPanel({
  workspaceId,
  projectId,
  runId,
}: {
  workspaceId: string;
  projectId: string;
  runId: string;
}) {
  const quality = useRunQuality(workspaceId, projectId, runId);
  if (quality.isPending) return <Skeleton className="mt-2 h-24 w-full" />;
  if (quality.isError) {
    return <p className="mt-2 text-xs text-destructive">{quality.error.message}</p>;
  }

  return (
    <div className="mt-2 flex flex-col gap-2 rounded-md bg-muted/40 p-2">
      <p className="text-xs text-muted-foreground">{quality.data.note}</p>

      {quality.data.duplicateClusters.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {quality.data.duplicateClusters.length} near-duplicate cluster(s) — syndicated copies
          count once toward source diversity, not once each.
        </p>
      ) : null}

      {quality.data.sources.length === 0 ? (
        <p className="text-xs text-muted-foreground">No sources recorded for this run.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {quality.data.sources.slice(0, 25).map((s) => {
            const robots = ROBOTS_LABEL[s.robotsDecision] ?? ROBOTS_LABEL['NOT_CHECKED'];
            const note =
              typeof s.metadata?.['fetchNote'] === 'string' ? s.metadata['fetchNote'] : null;
            return (
              <li key={s.id} className="rounded border border-border bg-background p-2">
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 flex-1 truncate text-xs font-medium">{s.title ?? s.url}</p>
                  <Badge variant={s.evidenceEligible ? 'success' : 'muted'}>
                    {s.evidenceEligible ? 'evidence-eligible' : 'not evidence'}
                  </Badge>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  <Badge variant={robots!.variant}>{robots!.text}</Badge>
                  {s.snippetOnly ? <Badge variant="warning">snippet-only</Badge> : null}
                  <Badge variant={STALENESS_VARIANT[s.stalenessStatus] ?? 'muted'}>
                    {s.stalenessStatus.toLowerCase()}
                  </Badge>
                  {s.duplicateClusterKey || s.duplicateOfSourceId ? (
                    <Badge variant="muted">duplicate cluster</Badge>
                  ) : null}
                  <span className="text-xs text-muted-foreground">
                    {/* Dash, not a fabricated number, when a score is absent. */}
                    credibility {s.credibilityScore === null ? '—' : s.credibilityScore.toFixed(2)}
                    {' · '}
                    freshness {s.freshnessScore === null ? '—' : s.freshnessScore.toFixed(2)}
                  </span>
                </div>
                {s.evidenceExclusionReason ? (
                  <p className="mt-1 text-xs text-muted-foreground">{s.evidenceExclusionReason}</p>
                ) : null}
                {note ? <p className="mt-1 text-xs text-muted-foreground">{note}</p> : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default function ResearchProjectPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const { activeWorkspace } = useWorkspace();
  const workspaceId = activeWorkspace.id;

  const project = useResearchProject(workspaceId, projectId);
  const runs = useRuns(workspaceId, projectId);
  const startRun = useStartRun(workspaceId, projectId);
  const review = useReviewFinding(workspaceId, projectId);

  const [tab, setTab] = React.useState<(typeof REVIEW_TABS)[number]['key']>('PENDING_REVIEW');
  const findings = useFindings(workspaceId, projectId, tab);

  const setSchedule = useSetSchedule(workspaceId, projectId);
  const clearSchedule = useClearSchedule(workspaceId, projectId);
  const [cadence, setCadence] = React.useState('1440');

  const [feedsRaw, setFeedsRaw] = React.useState('');
  const feedUrls = parseFeedUrls(feedsRaw);
  const feedsValid = feedUrls.length > 0 && feedUrls.every((u) => /^https?:\/\/.+/i.test(u));

  const capabilities = useCapabilities();
  const [qualityRunId, setQualityRunId] = React.useState<string | null>(null);
  const [queriesRaw, setQueriesRaw] = React.useState('');
  const searchQueries = queriesRaw
    .split('\n')
    .map((q) => q.trim())
    .filter((q) => q.length >= 2)
    .slice(0, 10);
  // Either discovery path is enough to start a run.
  const canRun = feedsValid || searchQueries.length > 0;

  const anyRunActive = (runs.data ?? []).some(isRunActive);

  // Refresh findings when an active run finishes.
  const prevActive = React.useRef(anyRunActive);
  React.useEffect(() => {
    if (prevActive.current && !anyRunActive) void findings.refetch();
    prevActive.current = anyRunActive;
  }, [anyRunActive, findings]);

  if (project.isPending) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (project.isError) {
    return (
      <EmptyState
        icon={<FlaskConical />}
        title="Project not found"
        description="It may belong to another workspace, or it was archived."
        action={
          <Link href="/research" className="text-sm font-medium text-primary hover:underline">
            Back to Research
          </Link>
        }
      />
    );
  }

  return (
    <>
      <Link
        href="/research"
        className="mb-3 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft aria-hidden="true" className="size-3.5" /> All research projects
      </Link>
      <PageHeader
        title={project.data.name}
        description={project.data.objective ?? 'No objective recorded.'}
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_1.2fr]">
        <div className="flex flex-col gap-6">
          {/* Run starter */}
          <Card>
            <CardHeader>
              <CardTitle>Start a research run</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="feeds">RSS/Atom feed URLs (one per line, up to 25)</Label>
                <textarea
                  id="feeds"
                  rows={4}
                  value={feedsRaw}
                  onChange={(e) => setFeedsRaw(e.target.value)}
                  placeholder={'https://example.com/feed.xml\nhttps://blog.example.org/rss'}
                  className={cn(
                    'w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm',
                    'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  )}
                />
                <p className="text-xs text-muted-foreground">
                  The pipeline snapshots every item, extracts and scans content, removes duplicates,
                  tags topics from your vertical keywords, and rescores trends.
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="queries">Search queries (one per line, up to 10)</Label>
                <textarea
                  id="queries"
                  rows={3}
                  value={queriesRaw}
                  onChange={(e) => setQueriesRaw(e.target.value)}
                  placeholder={'enterprise AI testing adoption\nLLM evaluation benchmarks 2026'}
                  className={cn(
                    'w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm',
                    'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  )}
                />
                <p className="text-xs text-muted-foreground">
                  {capabilities.data && !capabilities.data.discovery.liveSearchConfigured
                    ? capabilities.data.discovery.note
                    : 'Discovers sources beyond your feeds. Each result page is fetched and extracted; when a page cannot be fetched the search snippet is kept and marked as snippet-only.'}
                </p>
              </div>
              {startRun.isError ? (
                <p role="alert" className="text-xs text-destructive">
                  {startRun.error.message}
                </p>
              ) : null}
              <div>
                <Button
                  disabled={!canRun || startRun.isPending}
                  onClick={() =>
                    startRun.mutate({ feedUrls: feedUrls.slice(0, 25), searchQueries })
                  }
                >
                  <Play aria-hidden="true" />
                  {startRun.isPending ? 'Queueing…' : 'Run research'}
                </Button>
              </div>

              <div className="mt-1 border-t border-border pt-3">
                {project.data.scheduleEveryMinutes ? (
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">Recurring:</span> every{' '}
                      {project.data.scheduleEveryMinutes >= 60
                        ? `${project.data.scheduleEveryMinutes / 60} hour(s)`
                        : `${project.data.scheduleEveryMinutes} min`}{' '}
                      over {project.data.scheduleFeedUrls.length} feed(s)
                    </p>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={clearSchedule.isPending}
                      onClick={() => clearSchedule.mutate()}
                    >
                      Remove schedule
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="schedule-cadence">Run automatically</Label>
                      <select
                        id="schedule-cadence"
                        value={cadence}
                        onChange={(e) => setCadence(e.target.value)}
                        className="h-8 rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <option value="60">Every hour</option>
                        <option value="360">Every 6 hours</option>
                        <option value="1440">Daily</option>
                      </select>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!feedsValid || setSchedule.isPending}
                      title={feedsValid ? undefined : 'Enter feed URLs above first'}
                      onClick={() =>
                        setSchedule.mutate({
                          everyMinutes: Number(cadence),
                          feedUrls: feedUrls.slice(0, 25),
                        })
                      }
                    >
                      {setSchedule.isPending ? 'Enabling…' : 'Enable recurring runs'}
                    </Button>
                  </div>
                )}
                {setSchedule.isError || clearSchedule.isError ? (
                  <p role="alert" className="mt-2 text-xs text-destructive">
                    {setSchedule.error?.message ?? clearSchedule.error?.message}
                  </p>
                ) : null}
              </div>
            </CardContent>
          </Card>

          {/* Runs */}
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle>Runs</CardTitle>
              {anyRunActive ? <Spinner label="A run is in progress" /> : null}
            </CardHeader>
            <CardContent>
              {runs.isPending ? (
                <Skeleton className="h-20 w-full" />
              ) : (runs.data ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No runs yet — add feed URLs above and start one.
                </p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {(runs.data ?? []).slice(0, 8).map((run) => (
                    <li key={run.id} className="rounded-md border border-border p-3">
                      <div className="flex items-center justify-between gap-2">
                        <Badge variant={RUN_BADGE[run.status]}>{run.status}</Badge>
                        <span className="text-xs text-muted-foreground">
                          {new Date(run.createdAt).toLocaleString()}
                        </span>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        {isRunActive(run) && run.currentStage ? (
                          <span className="font-medium text-foreground">
                            Stage: {run.currentStage}
                          </span>
                        ) : null}
                        <span>{run.stats?.sourcesDiscovered ?? 0} discovered</span>
                        <span>{run.stats?.sourcesFetched ?? 0} fetched</span>
                        <span>{run.stats?.findingsExtracted ?? 0} findings</span>
                        <span>{run.stats?.duplicatesRemoved ?? 0} duplicates</span>
                      </div>
                      {/* What the run could NOT do, shown as prominently as
                          what it could — a partial run must not read as thorough. */}
                      {(run.stats?.robotsBlocked ?? 0) > 0 ||
                      (run.stats?.snippetOnly ?? 0) > 0 ||
                      (run.stats?.blockedDomainRejected ?? 0) > 0 ? (
                        <div className="mt-1 flex flex-wrap gap-2">
                          {(run.stats?.robotsBlocked ?? 0) > 0 ? (
                            <Badge variant="warning">
                              {run.stats?.robotsBlocked} robots-blocked
                            </Badge>
                          ) : null}
                          {(run.stats?.snippetOnly ?? 0) > 0 ? (
                            <Badge variant="warning">{run.stats?.snippetOnly} snippet-only</Badge>
                          ) : null}
                          {(run.stats?.blockedDomainRejected ?? 0) > 0 ? (
                            <Badge variant="muted">
                              {run.stats?.blockedDomainRejected} blocked-domain
                            </Badge>
                          ) : null}
                          {(run.stats?.evidenceEligible ?? 0) > 0 ? (
                            <Badge variant="success">
                              {run.stats?.evidenceEligible} evidence-eligible
                            </Badge>
                          ) : null}
                        </div>
                      ) : null}
                      {run.failureReason ? (
                        <p className="mt-2 line-clamp-2 text-xs text-destructive">
                          {run.failureReason}
                        </p>
                      ) : null}
                      <button
                        type="button"
                        className="mt-2 text-xs font-medium text-primary underline-offset-2 hover:underline"
                        onClick={() => setQualityRunId(qualityRunId === run.id ? null : run.id)}
                      >
                        {qualityRunId === run.id ? 'Hide source quality' : 'Source quality'}
                      </button>
                      {qualityRunId === run.id ? (
                        <RunQualityPanel
                          workspaceId={workspaceId}
                          projectId={projectId}
                          runId={run.id}
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Findings review queue */}
        <Card>
          <CardHeader>
            <CardTitle>Findings</CardTitle>
            <div role="tablist" aria-label="Review status" className="mt-2 flex gap-1">
              {REVIEW_TABS.map((t) => (
                <button
                  key={t.key}
                  role="tab"
                  aria-selected={tab === t.key}
                  onClick={() => setTab(t.key)}
                  className={cn(
                    'rounded-full px-3 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    tab === t.key
                      ? 'bg-accent font-medium text-accent-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </CardHeader>
          <CardContent>
            {findings.isPending ? (
              <Skeleton className="h-32 w-full" />
            ) : (findings.data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {tab === 'PENDING_REVIEW'
                  ? 'Nothing awaiting review. Run research to gather findings.'
                  : `No ${tab.toLowerCase().replace('_', ' ')} findings yet.`}
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
                {(findings.data ?? []).map((finding: FindingRow) => (
                  <li key={finding.id} className="rounded-md border border-border p-3">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium leading-snug">{finding.summary}</p>
                      {tab === 'PENDING_REVIEW' ? (
                        <div className="flex shrink-0 gap-1">
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label="Validate finding"
                            disabled={review.isPending}
                            onClick={() =>
                              review.mutate({ findingId: finding.id, status: 'VALIDATED' })
                            }
                          >
                            <Check aria-hidden="true" /> Validate
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label="Reject finding"
                            disabled={review.isPending}
                            onClick={() =>
                              review.mutate({ findingId: finding.id, status: 'REJECTED' })
                            }
                          >
                            <X aria-hidden="true" /> Reject
                          </Button>
                        </div>
                      ) : null}
                    </div>
                    {finding.excerpt ? (
                      <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">
                        {finding.excerpt}
                      </p>
                    ) : null}
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <a
                        href={finding.source.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                      >
                        {finding.source.publisher ?? 'Source'}{' '}
                        <ExternalLink aria-hidden="true" className="size-3" />
                      </a>
                      {finding.source.publishedAt ? (
                        <span>
                          published {new Date(finding.source.publishedAt).toLocaleDateString()}
                        </span>
                      ) : null}
                      <span>
                        retrieved {new Date(finding.source.retrievedAt).toLocaleDateString()}
                      </span>
                      {typeof finding.credibilityScore === 'number' ? (
                        <Badge variant="outline">
                          credibility {(finding.credibilityScore * 100).toFixed(0)}%
                        </Badge>
                      ) : null}
                      {finding.topics.map((topic) => (
                        <Badge key={topic} variant="secondary">
                          {topic}
                        </Badge>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <EvidencePacksSection workspaceId={workspaceId} projectId={projectId} />
    </>
  );
}
