'use client';

import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState, Skeleton } from '@spectra/ui';
import { BadgeIndianRupee, Info } from 'lucide-react';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { useWorkspace } from '@/lib/auth';
import { formatMicros, useUsageSummary, type UsageSummary } from '@/lib/usage';

const KIND_LABEL: Record<string, string> = {
  AI_GENERATION: 'AI generation',
  AI_EMBEDDING: 'Embeddings',
  WEB_SEARCH: 'Web search',
  NEWS_SEARCH: 'News search',
  PAGE_FETCH: 'Page fetches',
};

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="py-4">
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
        {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

function Report({ data }: { data: UsageSummary }) {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          label={`Estimated spend (${data.windowDays}d)`}
          value={formatMicros(data.totals.estimatedCostMicros)}
        />
        <Tile label="Metered events" value={String(data.totals.events)} />
        <Tile label="Provider requests" value={String(data.totals.requests)} />
        <Tile
          label="Events with no known rate"
          value={String(data.totals.unpricedEvents)}
          hint={data.totals.unpricedEvents > 0 ? 'Excluded from the estimate' : undefined}
        />
      </div>

      <Card className="border-amber-500/40 bg-amber-500/5">
        <CardContent className="flex items-start gap-3 py-4">
          <Info aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-amber-600" />
          <div className="text-sm">
            <p className="font-medium">These are estimates, not invoices</p>
            <p className="text-muted-foreground">{data.note}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>By operation</CardTitle>
          <p className="text-xs text-muted-foreground">
            Measured from what each provider actually reported. A dash means the provider did not
            report that figure — not that it was zero.
          </p>
        </CardHeader>
        <CardContent>
          {data.byKind.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No metered activity in this window. Usage appears here once research runs, generation
              or search actually call a provider.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">Operation</th>
                    <th className="py-2 pr-4 text-right font-medium">Events</th>
                    <th className="py-2 pr-4 text-right font-medium">Requests</th>
                    <th className="py-2 pr-4 text-right font-medium">In tokens</th>
                    <th className="py-2 pr-4 text-right font-medium">Out tokens</th>
                    <th className="py-2 text-right font-medium">Est. cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byKind.map((row) => (
                    <tr key={row.kind} className="border-b border-border/50">
                      <td className="py-2 pr-4">{KIND_LABEL[row.kind] ?? row.kind}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{row.events}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{row.requests}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {row.inputTokens ?? row.totalTokens ?? '—'}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {row.outputTokens ?? '—'}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {formatMicros(row.estimatedCostMicros)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
          <p className="text-xs text-muted-foreground">
            The 25 most recent metered calls, rate table {data.rateVersion}.
          </p>
        </CardHeader>
        <CardContent>
          {data.recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing metered yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {data.recent.map((event) => (
                <li key={event.id} className="flex items-center justify-between gap-3 text-sm">
                  <div className="min-w-0">
                    <span className="font-medium">{KIND_LABEL[event.kind] ?? event.kind}</span>
                    <span className="text-muted-foreground">
                      {' '}
                      · {event.provider}
                      {event.model ? `/${event.model}` : ''}
                    </span>
                    {event.resourceType ? (
                      <Badge variant="secondary" className="ml-2">
                        {event.resourceType}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="shrink-0 text-right">
                    <span className="tabular-nums">{formatMicros(event.estimatedCostMicros)}</span>
                    <p className="text-xs text-muted-foreground">
                      {new Date(event.occurredAt).toISOString().replace('T', ' ').slice(0, 16)} UTC
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Plans and invoicing</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No payment provider is connected, so there are no plans, invoices or charges. This page
            reports measured provider usage only — it does not bill anyone.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

export default function BillingPage() {
  const { activeWorkspace } = useWorkspace();
  const usage = useUsageSummary(activeWorkspace.id);

  return (
    <>
      <PageHeader
        title="Usage"
        description="What this workspace actually spent with external providers — measured from their own reported figures, priced with a local rate table. Estimates, never invoices."
      />
      {usage.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : usage.isError ? (
        <EmptyState
          icon={<BadgeIndianRupee />}
          title="Could not load usage"
          description={usage.error.message}
        />
      ) : (
        <Report data={usage.data} />
      )}
    </>
  );
}
