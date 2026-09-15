'use client';

import type {
  AnalyticsAggregateMetric,
  AnalyticsFreshness,
  AnalyticsMetric,
  AnalyticsSignalSource,
  AnalyticsSyncRun,
} from '@spectra/contracts';
import { Badge, Card, CardContent } from '@spectra/ui';
import { Clock, TriangleAlert } from 'lucide-react';
import * as React from 'react';

import { UNAVAILABLE_REASON_LABEL, formatMetricValue, freshnessLabel } from '@/lib/analytics';

/**
 * Shared analytics display pieces (ADR-0039). Every one of them keeps three
 * things visible: where a number came from, how fresh it is, and — when there
 * is no number — why, in words. None of them draws a chart.
 */

const SOURCE_LABEL: Record<AnalyticsSignalSource, string> = {
  ESTIMATED: 'Estimated',
  FIRST_PARTY_MEASURED: 'First-party · counted by Spectra',
  EXTERNAL_MEASURED: 'External · reported by platforms',
  UNAVAILABLE: 'Unavailable',
};

export function SourceBadge({ source }: { source: AnalyticsSignalSource }) {
  return (
    <Badge
      variant={
        source === 'EXTERNAL_MEASURED'
          ? 'secondary'
          : source === 'UNAVAILABLE'
            ? 'muted'
            : 'outline'
      }
    >
      {SOURCE_LABEL[source]}
    </Badge>
  );
}

export function FreshnessBadge({ freshness }: { freshness: AnalyticsFreshness }) {
  return (
    <Badge
      variant={
        freshness.state === 'FRESH' ? 'success' : freshness.state === 'STALE' ? 'warning' : 'muted'
      }
      title={freshness.note ?? undefined}
    >
      <Clock aria-hidden="true" className="size-3" />
      {freshnessLabel(freshness)}
    </Badge>
  );
}

/** One aggregate tile: the sum and how many posts it covers, or unavailable with the reason. */
export function AggregateTile({
  label,
  metric,
}: {
  label: string;
  metric: AnalyticsAggregateMetric;
}) {
  const missing = metric.value === null;
  return (
    <Card>
      <CardContent className="py-4">
        <p
          className={
            missing
              ? 'text-sm font-medium text-muted-foreground'
              : 'text-2xl font-semibold tabular-nums'
          }
        >
          {formatMetricValue(metric)}
        </p>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="mt-1 text-[11px] text-muted-foreground">
          {missing
            ? (metric.detail ?? 'No post reported it.')
            : metric.unavailable > 0
              ? `${metric.contributing} reported · ${metric.unavailable} unavailable (not counted as 0)`
              : `${metric.contributing} reported`}
        </p>
      </CardContent>
    </Card>
  );
}

/** A metric table for one snapshot: value or reason, completeness, and the platform's own name. */
export function MetricTable({ metrics }: { metrics: AnalyticsMetric[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="text-muted-foreground">
          <tr>
            <th className="py-1 pr-3 font-medium">Metric</th>
            <th className="py-1 pr-3 font-medium">Value</th>
            <th className="py-1 pr-3 font-medium">Quality</th>
            <th className="py-1 font-medium">Platform field / reason</th>
          </tr>
        </thead>
        <tbody>
          {metrics.map((metric) => (
            <tr key={metric.key} className="border-t border-border align-top">
              <td className="py-1.5 pr-3 font-mono">{metric.key}</td>
              <td
                className={
                  metric.value === null
                    ? 'py-1.5 pr-3 text-muted-foreground'
                    : 'py-1.5 pr-3 tabular-nums'
                }
              >
                {formatMetricValue(metric)}
              </td>
              <td className="py-1.5 pr-3">
                <Badge
                  variant={
                    metric.completeness === 'UNAVAILABLE'
                      ? 'muted'
                      : metric.completeness === 'APPROXIMATE'
                        ? 'warning'
                        : 'outline'
                  }
                >
                  {metric.completeness.toLowerCase()}
                </Badge>
              </td>
              <td className="py-1.5 text-muted-foreground">
                {metric.sourceMetricName ? (
                  <span className="font-mono">{metric.sourceMetricName}</span>
                ) : null}
                {metric.sourceMetricName && metric.detail ? ' — ' : null}
                {metric.detail}
                {metric.unavailableReason && !metric.detail
                  ? UNAVAILABLE_REASON_LABEL[metric.unavailableReason]
                  : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const RUN_VARIANT: Record<string, 'success' | 'warning' | 'destructive' | 'muted'> = {
  SUCCEEDED: 'success',
  PARTIAL: 'warning',
  QUEUED: 'muted',
  RUNNING: 'muted',
  FAILED: 'destructive',
  UNAVAILABLE: 'muted',
};

export function SyncRunSummary({ run }: { run: AnalyticsSyncRun }) {
  return (
    <div className="flex flex-col gap-1 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={RUN_VARIANT[run.status] ?? 'muted'}>{run.status}</Badge>
        <span className="text-muted-foreground">
          {run.target.toLowerCase().replace('_', ' ')} · {run.trigger.toLowerCase()} · attempt{' '}
          {run.attempt}/{run.maxAttempts} · {new Date(run.createdAt).toLocaleString()}
        </span>
      </div>
      <span className="text-muted-foreground">
        {run.counts.succeeded} succeeded · {run.counts.partial} partial · {run.counts.failed} failed
        · {run.counts.unavailable} unavailable
      </span>
      {run.rateLimit ? (
        <span className="flex items-center gap-1 text-amber-700 dark:text-amber-400">
          <TriangleAlert aria-hidden="true" className="size-3" />
          Rate limited by the platform.{' '}
          {run.rateLimit.nextAttemptAt
            ? `Retrying at ${new Date(run.rateLimit.nextAttemptAt).toLocaleTimeString()}.`
            : 'No attempts remain; start a new sync later.'}
        </span>
      ) : run.error ? (
        <span className="text-muted-foreground">
          <span className="font-mono">{run.error.code}</span>: {run.error.message}
        </span>
      ) : null}
    </div>
  );
}
