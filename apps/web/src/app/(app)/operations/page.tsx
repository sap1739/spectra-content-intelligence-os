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
import { Activity, CircleCheck, Lock, TriangleAlert } from 'lucide-react';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { usePermissions, useWorkspace } from '@/lib/auth';
import { useCapabilities } from '@/lib/knowledge';
import { useFailedJobs, useQueueStatus, useRetryJob, type FailedJob } from '@/lib/ops';

/**
 * Operations dashboard (ADR-0033).
 *
 * The distinction this page exists to preserve: an empty failure list and an
 * unreachable queue look identical if you only render counts. Every panel here
 * reports which of the two it is.
 */

function CountTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'warn' | 'bad';
}) {
  return (
    <Card>
      <CardContent className="py-4">
        <p
          className={
            tone === 'bad' && value > 0
              ? 'text-2xl font-semibold tabular-nums text-destructive'
              : tone === 'warn' && value > 0
                ? 'text-2xl font-semibold tabular-nums text-amber-600'
                : 'text-2xl font-semibold tabular-nums'
          }
        >
          {value}
        </p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </CardContent>
    </Card>
  );
}

function JobRow({
  job,
  canRetry,
  onRetry,
  retrying,
}: {
  job: FailedJob;
  canRetry: boolean;
  onRetry: (id: string) => void;
  retrying: boolean;
}) {
  return (
    <li className="rounded-md border border-border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <span className="text-sm font-medium">{job.category}</span>
          <span className="ml-2 font-mono text-xs text-muted-foreground">{job.name}</span>
        </div>
        <span className="flex shrink-0 items-center gap-2">
          <Badge variant="muted">
            attempt {job.attemptsMade}
            {job.maxAttempts > 0 ? ` / ${job.maxAttempts}` : ''}
          </Badge>
          {canRetry ? (
            <Button size="sm" variant="outline" disabled={retrying} onClick={() => onRetry(job.id)}>
              {retrying ? 'Retrying…' : 'Retry'}
            </Button>
          ) : null}
        </span>
      </div>
      <p className="mt-1 text-xs text-destructive">{job.reason}</p>
      <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {job.resourceId ? (
          <div className="flex gap-1">
            <dt>Resource</dt>
            <dd className="font-mono">{job.resourceId}</dd>
          </div>
        ) : null}
        {job.correlationId ? (
          <div className="flex gap-1">
            {/* The id a customer quotes in a support request. */}
            <dt>Correlation</dt>
            <dd className="font-mono">{job.correlationId}</dd>
          </div>
        ) : null}
        <div className="flex gap-1">
          <dt>Failed</dt>
          <dd>{job.failedAt ? job.failedAt.replace('T', ' ').slice(0, 19) : '—'}</dd>
        </div>
      </dl>
    </li>
  );
}

export default function OperationsPage() {
  const { activeWorkspace } = useWorkspace();
  const workspaceId = activeWorkspace.id;
  const { can } = usePermissions();
  const canRead = can('ops:read');
  const canRetry = can('ops:retry');

  const queue = useQueueStatus(workspaceId);
  const jobs = useFailedJobs(workspaceId);
  const capabilities = useCapabilities();
  const retry = useRetryJob(workspaceId);
  const [retryingId, setRetryingId] = React.useState<string | null>(null);

  const onRetry = async (jobId: string) => {
    setRetryingId(jobId);
    try {
      await retry.mutateAsync(jobId);
    } finally {
      setRetryingId(null);
    }
  };

  if (!canRead) {
    return (
      <>
        <PageHeader title="Operations" description="Queue health and failed background jobs." />
        <Card>
          <CardContent className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Lock aria-hidden="true" className="size-4 shrink-0" />
            Viewing operations requires the <code className="rounded bg-muted px-1">
              ops:read
            </code>{' '}
            permission.
          </CardContent>
        </Card>
      </>
    );
  }

  const counts = queue.data?.counts;

  return (
    <>
      <PageHeader
        title="Operations"
        description="Queue health, failed background jobs and safe retry. Retrying re-runs the original job, so its idempotency key and budget checks still apply."
      />

      {/* Queue reachability first: every count below is meaningless without it. */}
      {queue.isPending ? (
        <Skeleton className="mb-6 h-24 w-full" />
      ) : queue.data && !queue.data.reachable ? (
        <Card className="mb-6 border-destructive/40 bg-destructive/5">
          <CardContent className="flex items-start gap-3 py-4">
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-destructive" />
            <div className="text-sm">
              <p className="font-medium">The job queue is unreachable</p>
              <p className="text-muted-foreground">{queue.data.reason}</p>
            </div>
          </CardContent>
        </Card>
      ) : counts ? (
        <div className="mb-6 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <CountTile label="Waiting" value={counts.waiting} />
          <CountTile label="Active" value={counts.active} />
          <CountTile label="Delayed" value={counts.delayed} />
          <CountTile label="Completed" value={counts.completed} />
          <CountTile label="Failed" value={counts.failed} tone="warn" />
          <CountTile label="Dead-lettered" value={counts.deadLettered} tone="bad" />
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Failed jobs</CardTitle>
            <p className="text-xs text-muted-foreground">
              Research runs, content generation, publishing and embedding jobs for this workspace.
            </p>
          </CardHeader>
          <CardContent>
            {jobs.isPending ? (
              <Skeleton className="h-24 w-full" />
            ) : jobs.isError ? (
              <EmptyState
                icon={<Activity />}
                title="Could not load failed jobs"
                description={jobs.error.message}
              />
            ) : !jobs.data.reachable ? (
              // Never rendered as "no failures" — the queue simply cannot answer.
              <EmptyState
                icon={<TriangleAlert />}
                title="Failure list unavailable"
                description={jobs.data.note}
              />
            ) : jobs.data.failed.length === 0 && jobs.data.deadLettered.length === 0 ? (
              <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-emerald-600" />
                No failed or dead-lettered jobs in this workspace.
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {jobs.data.failed.length > 0 ? (
                  <div>
                    <h3 className="mb-2 text-sm font-medium">Retriable failures</h3>
                    <ul className="flex flex-col gap-2">
                      {jobs.data.failed.map((job) => (
                        <JobRow
                          key={job.id}
                          job={job}
                          canRetry={canRetry}
                          onRetry={onRetry}
                          retrying={retryingId === job.id}
                        />
                      ))}
                    </ul>
                  </div>
                ) : null}

                {jobs.data.deadLettered.length > 0 ? (
                  <div>
                    <h3 className="mb-2 text-sm font-medium">Dead-lettered</h3>
                    <p className="mb-2 text-xs text-muted-foreground">{jobs.data.note}</p>
                    <ul className="flex flex-col gap-2">
                      {jobs.data.deadLettered.map((job) => (
                        <JobRow
                          key={job.id}
                          job={job}
                          canRetry={canRetry}
                          onRetry={onRetry}
                          retrying={retryingId === job.id}
                        />
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            )}

            {!canRetry && (jobs.data?.failed.length ?? 0) > 0 ? (
              <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Lock aria-hidden="true" className="size-3.5 shrink-0" />
                Retrying requires the <code className="rounded bg-muted px-1">ops:retry</code>{' '}
                permission.
              </p>
            ) : null}
            {retry.isError ? (
              <p role="alert" className="mt-3 text-xs text-destructive">
                {retry.error.message}
              </p>
            ) : null}
            {retry.isSuccess ? (
              <p role="status" className="mt-3 text-xs text-emerald-600 dark:text-emerald-400">
                {retry.data.note}
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Provider health</CardTitle>
            <p className="text-xs text-muted-foreground">
              Which external integrations this deployment can actually use.
            </p>
          </CardHeader>
          <CardContent>
            {capabilities.isPending ? (
              <Skeleton className="h-24 w-full" />
            ) : capabilities.isError ? (
              <p className="text-sm text-muted-foreground">{capabilities.error.message}</p>
            ) : (
              <ul className="flex flex-col gap-3 text-sm">
                <li className="flex items-start justify-between gap-2">
                  <span>Generation</span>
                  <Badge variant={capabilities.data.generation.configured ? 'success' : 'muted'}>
                    {capabilities.data.generation.configured ? 'configured' : 'not configured'}
                  </Badge>
                </li>
                <li className="flex items-start justify-between gap-2">
                  <span>Retrieval</span>
                  <Badge variant={capabilities.data.retrieval.semantic ? 'success' : 'warning'}>
                    {capabilities.data.retrieval.semantic ? 'semantic' : 'lexical only'}
                  </Badge>
                </li>
                <li className="flex items-start justify-between gap-2">
                  <span>Discovery</span>
                  <Badge
                    variant={capabilities.data.discovery.liveSearchConfigured ? 'success' : 'muted'}
                  >
                    {capabilities.data.discovery.liveSearchConfigured
                      ? 'live search'
                      : 'feeds only'}
                  </Badge>
                </li>
                <li className="flex items-start justify-between gap-2">
                  <span>Credential storage</span>
                  <Badge
                    variant={capabilities.data.credentialStorage.configured ? 'success' : 'muted'}
                  >
                    {capabilities.data.credentialStorage.configured
                      ? 'configured'
                      : 'not configured'}
                  </Badge>
                </li>
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
