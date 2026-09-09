'use client';

import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState, Skeleton } from '@spectra/ui';
import { BadgeIndianRupee, Info } from 'lucide-react';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { useWorkspace } from '@/lib/auth';
import {
  formatMicros,
  useOperationLimits,
  useOrganizationBudget,
  useUnpricedReport,
  useUpdateBudget,
  useUsageSummary,
  type BudgetDecision,
  type UsageSummary,
} from '@/lib/usage';
import { Button, Input, Label } from '@spectra/ui';

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

const BUDGET_VARIANT: Record<string, 'success' | 'warning' | 'destructive' | 'muted'> = {
  OK: 'success',
  WARN: 'warning',
  EXCEEDED: 'destructive',
  NOT_CONFIGURED: 'muted',
};

function BudgetCard({ budget, workspaceId }: { budget: BudgetDecision; workspaceId: string }) {
  const update = useUpdateBudget(workspaceId);
  const [limit, setLimit] = React.useState(
    budget.limitMicros === null ? '' : String(budget.limitMicros / 1_000_000),
  );
  const [enforcement, setEnforcement] = React.useState<string>(budget.enforcement);
  const parsed = limit.trim() === '' ? null : Number(limit);
  const valid = parsed === null || (Number.isFinite(parsed) && parsed >= 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Monthly budget
          <Badge variant={BUDGET_VARIANT[budget.status] ?? 'secondary'}>{budget.status}</Badge>
        </CardTitle>
        <p className="text-xs text-muted-foreground">{budget.reason}</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {budget.limitMicros !== null ? (
          <div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={
                  budget.status === 'EXCEEDED'
                    ? 'h-full bg-destructive'
                    : budget.status === 'WARN'
                      ? 'h-full bg-amber-500'
                      : 'h-full bg-primary/80'
                }
                style={{ width: `${Math.min(100, budget.usedPercent ?? 0)}%` }}
              />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {formatMicros(budget.usedMicros)} of {formatMicros(budget.limitMicros)} used
              {budget.usedPercent !== null ? ` (${budget.usedPercent}%)` : ''}
            </p>
          </div>
        ) : null}

        {budget.unpricedEvents > 0 ? (
          <p className="text-xs text-muted-foreground">
            {budget.unpricedEvents} metered event(s) this period had no known rate and contributed
            nothing to this total — real spend is higher than shown.
          </p>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="budget-limit">Monthly limit ({budget.currency})</Label>
            <Input
              id="budget-limit"
              inputMode="decimal"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              placeholder="Leave empty for no limit"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="budget-enforcement">When the limit is reached</Label>
            <select
              id="budget-enforcement"
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm"
              value={enforcement}
              onChange={(e) => setEnforcement(e.target.value)}
            >
              <option value="OFF">OFF — record only</option>
              <option value="WARN">WARN — surface it, keep working</option>
              <option value="ENFORCE">ENFORCE — refuse new paid work</option>
            </select>
          </div>
        </div>

        {update.isError ? (
          <p role="alert" className="text-xs text-destructive">
            {update.error.message}
          </p>
        ) : null}

        <div>
          <Button
            disabled={!valid || update.isPending}
            onClick={() =>
              update.mutate({
                monthlyLimitMicros: parsed === null ? null : Math.round(parsed * 1_000_000),
                enforcement: enforcement as BudgetDecision['enforcement'],
                warnAtPercent: 80,
              })
            }
          >
            {update.isPending ? 'Saving…' : 'Save budget'}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Budgets are checked against estimated cost, so they are approximate. ENFORCE refuses new
          research runs and draft generation with a clear reason; it never silently drops work.
        </p>
      </CardContent>
    </Card>
  );
}

/** Kinds that are free/local or otherwise never vendor-billed. */
const NON_PAID_KINDS = new Set([
  'PAGE_FETCH',
  'MEDIA_RENDER',
  'PUBLISH_ATTEMPT',
  'RESEARCH_RUN',
  'CONTENT_DRAFT',
  'DOCUMENT_EXTRACTION',
]);

function OperationLimitsCard({ workspaceId }: { workspaceId: string }) {
  const limits = useOperationLimits(workspaceId);
  if (limits.isPending) return <Skeleton className="h-48 w-full" />;
  if (limits.isError) return null;
  const rows = limits.data.kinds.filter(
    (k) => k.requests > 0 || k.workspaceMaxRequests !== null || k.organizationMaxRequests !== null,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Per-operation limits</CardTitle>
        <p className="text-xs text-muted-foreground">{limits.data.note}</p>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No per-operation activity or limits this period.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">Operation</th>
                  <th className="py-2 pr-4 text-right font-medium">Used</th>
                  <th className="py-2 pr-4 text-right font-medium">Limit</th>
                  <th className="py-2 pr-4 text-right font-medium">Remaining</th>
                  <th className="py-2 pr-4 text-right font-medium">Tokens</th>
                  <th className="py-2 text-right font-medium">Unmeasured</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((k) => (
                  <tr key={k.kind} className="border-b border-border/50">
                    <td className="py-2 pr-4">
                      {KIND_LABEL[k.kind] ?? k.kind}
                      {NON_PAID_KINDS.has(k.kind) ? (
                        <Badge variant="muted" className="ml-2">
                          not vendor-billed
                        </Badge>
                      ) : null}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">{k.requests}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {k.workspaceMaxRequests ?? k.organizationMaxRequests ?? '—'}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {k.remainingRequests ?? '—'}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {k.measuredTokens > 0 ? k.measuredTokens : '—'}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {k.unknownQuantityEvents > 0 ? k.unknownQuantityEvents : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-muted-foreground">
              “Unmeasured” counts calls where the provider reported no token count. They are counted
              as operations but deliberately not as zero tokens.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function UnpricedCard({ workspaceId }: { workspaceId: string }) {
  const report = useUnpricedReport(workspaceId);
  if (report.isPending) return <Skeleton className="h-40 w-full" />;
  if (report.isError) return null;
  const gaps = report.data.operations.filter((o) => o.reason === 'NO_RATE_FOR_MODEL');

  return (
    <Card>
      <CardHeader>
        <CardTitle>What the cost estimate cannot see</CardTitle>
        <p className="text-xs text-muted-foreground">{report.data.note}</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {report.data.byReason.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Every metered operation this period carried a cost estimate.
          </p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {report.data.byReason.map((r) => (
              <li key={r.reason ?? 'unknown'} className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Badge variant={r.reason === 'NO_RATE_FOR_MODEL' ? 'destructive' : 'muted'}>
                    {r.reason ?? 'UNRECORDED'}
                  </Badge>
                  <p className="mt-1 text-xs text-muted-foreground">{r.explanation}</p>
                </div>
                <span className="shrink-0 tabular-nums">{r.events}</span>
              </li>
            ))}
          </ul>
        )}
        {gaps.length > 0 ? (
          <p className="text-xs text-destructive">
            {gaps.length} provider/model combination(s) have no configured rate — that spend is real
            but missing from every cost ceiling.
          </p>
        ) : null}
        {report.data.conservativelyPricedEvents > 0 ? (
          <p className="text-xs text-muted-foreground">
            {report.data.conservativelyPricedEvents} event(s) were priced with a conservative
            fallback rate, so their cost is over-stated rather than invisible.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function OrganizationBudgetCard({ organizationId }: { organizationId: string }) {
  const org = useOrganizationBudget(organizationId);
  // Absent or forbidden (non-admin): show nothing rather than a broken card.
  if (org.isPending || org.isError) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Organization budget
          <Badge variant={org.data.configured ? 'secondary' : 'muted'}>
            {org.data.configured ? org.data.enforcement : 'NOT CONFIGURED'}
          </Badge>
        </CardTitle>
        <p className="text-xs text-muted-foreground">{org.data.note}</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <p className="text-xl font-semibold tabular-nums">
              {formatMicros(org.data.usedMicros)}
            </p>
            <p className="text-xs text-muted-foreground">Aggregate estimated spend</p>
          </div>
          <div>
            <p className="text-xl font-semibold tabular-nums">
              {org.data.limitMicros === null ? '—' : formatMicros(org.data.limitMicros)}
            </p>
            <p className="text-xs text-muted-foreground">Organization limit</p>
          </div>
          <div>
            <p className="text-xl font-semibold tabular-nums">{org.data.unpricedEvents}</p>
            <p className="text-xs text-muted-foreground">Unpriced events (excluded)</p>
          </div>
        </div>
        {org.data.workspaces.length > 0 ? (
          <div>
            <p className="mb-1 text-xs font-medium">By workspace</p>
            <ul className="flex flex-col gap-1 text-xs">
              {org.data.workspaces.map((w) => (
                <li key={w.workspaceId ?? 'org'} className="flex justify-between gap-3">
                  <span className="truncate text-muted-foreground">
                    {w.workspaceId ?? 'organization-level'}
                  </span>
                  <span className="tabular-nums">{formatMicros(w.estimatedCostMicros)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Report({
  data,
  workspaceId,
  organizationId,
}: {
  data: UsageSummary;
  workspaceId: string;
  organizationId: string;
}) {
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

      <BudgetCard budget={data.budget} workspaceId={workspaceId} />

      <OrganizationBudgetCard organizationId={organizationId} />

      <OperationLimitsCard workspaceId={workspaceId} />

      <UnpricedCard workspaceId={workspaceId} />

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
        <Report
          data={usage.data}
          workspaceId={activeWorkspace.id}
          organizationId={activeWorkspace.organizationId}
        />
      )}
    </>
  );
}
