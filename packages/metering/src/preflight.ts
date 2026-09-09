import type { SpectraPrismaClient } from '@spectra/database';

/**
 * The slice of the client budget evaluation needs.
 *
 * Narrowed deliberately so the SAME function works against both the root client
 * and a `$transaction` client — the transactional reserve path (ADR-0029) must
 * evaluate the budget with the very reads it will then write against, and a
 * transaction client has no `$transaction` of its own.
 */
export type BudgetReadClient = Pick<
  SpectraPrismaClient,
  | 'workspaceBudget'
  | 'organizationBudget'
  | 'usageEvent'
  | 'budgetReservation'
  | 'budgetOperationLimit'
>;

import { periodEndFor, periodStartFor, type BudgetEnforcement } from './budget';
import { estimateCost, UNPRICED_REASON_TEXT, type UnpricedReason } from './rates';
import type { UsageKind } from './recorder';

/**
 * Budget pre-flight: the single decision point every paid operation passes
 * through before it spends anything.
 *
 * It evaluates, in one place:
 *  - the workspace cost ceiling,
 *  - the organization cost ceiling (optional, above the workspace),
 *  - per-operation monthly limits (requests and, where measured, tokens),
 *  - active reservations held by in-flight work,
 * and returns the STRICTEST outcome.
 *
 * Governing rule (ADR-0028): unknown cost is never silently zero. An operation
 * we cannot price is not therefore free — it is reported as
 * UNKNOWN_COST_ALLOW_WITH_NOTICE and still counted against per-operation limits,
 * which is the only bound that works when the price is unknown.
 */

export type PreflightOutcome =
  'ALLOW' | 'ALLOW_WITH_WARNING' | 'BLOCK' | 'REQUIRES_APPROVAL' | 'UNKNOWN_COST_ALLOW_WITH_NOTICE';

export type LimitExceededReason =
  | 'WORKSPACE_COST_CEILING'
  | 'ORGANIZATION_COST_CEILING'
  | 'WORKSPACE_OPERATION_LIMIT'
  | 'ORGANIZATION_OPERATION_LIMIT';

export type BudgetScope = 'WORKSPACE' | 'ORGANIZATION';

export interface BudgetWarning {
  scope: BudgetScope;
  kind?: UsageKind;
  message: string;
}

export interface OperationUsage {
  kind: UsageKind;
  requests: number;
  /** Tokens actually reported by providers this period. */
  measuredTokens: number;
  /**
   * Events of this kind whose token counts the provider never reported. These
   * are NOT included in `measuredTokens` — a token limit must not treat an
   * unmeasured call as zero tokens.
   */
  unknownQuantityEvents: number;
  maxRequests: number | null;
  maxTokens: number | null;
  remainingRequests: number | null;
  remainingTokens: number | null;
}

export interface PreflightRequest {
  organizationId: string;
  workspaceId: string;
  kind: UsageKind;
  /** For pricing the prospective operation; omit when genuinely unknown. */
  provider?: string;
  model?: string;
  requests?: number;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
}

export interface PreflightDecision {
  outcome: PreflightOutcome;
  /** Convenience: true only for BLOCK. */
  blocked: boolean;
  kind: UsageKind;
  periodStart: string;
  periodEnd: string;
  /** Populated for every BLOCK. */
  exceededReason?: LimitExceededReason;
  warnings: BudgetWarning[];
  /** Present when this operation's cost cannot be estimated. */
  unpricedReason?: UnpricedReason;
  unpricedNotice?: string;
  /** Estimated incremental cost of the prospective operation, if priceable. */
  estimatedCostMicros: number | null;
  workspace: CeilingView;
  organization: CeilingView | null;
  operation: OperationUsage | null;
  reason: string;
}

export interface CeilingView {
  configured: boolean;
  enforcement: BudgetEnforcement;
  limitMicros: number | null;
  usedMicros: number;
  /** Estimated cost held by in-flight reservations. */
  reservedMicros: number;
  remainingMicros: number | null;
  usedPercent: number | null;
  /** Events this period with no cost estimate — real spend is under-counted. */
  unpricedEvents: number;
}

const EMPTY_CEILING: CeilingView = {
  configured: false,
  enforcement: 'OFF',
  limitMicros: null,
  usedMicros: 0,
  reservedMicros: 0,
  remainingMicros: null,
  usedPercent: null,
  unpricedEvents: 0,
};

/** Evaluates every budget control that applies to one prospective operation. */
export async function preflight(
  prisma: BudgetReadClient,
  request: PreflightRequest,
  now: Date = new Date(),
): Promise<PreflightDecision> {
  const { organizationId, workspaceId, kind } = request;
  const periodStart = periodStartFor(now);
  const periodEnd = periodEndFor(now);
  const window = { gte: periodStart, lt: periodEnd };

  const estimate = estimateCost({
    provider: request.provider ?? '',
    model: request.model ?? null,
    kind,
    inputTokens: request.estimatedInputTokens ?? null,
    outputTokens: request.estimatedOutputTokens ?? null,
    requests: request.requests ?? 1,
  });

  const [wsBudget, orgBudget, wsSpend, orgSpend, wsUnpriced, orgUnpriced, reservations, limits] =
    await Promise.all([
      prisma.workspaceBudget.findFirst({ where: { organizationId, workspaceId } }),
      prisma.organizationBudget.findFirst({ where: { organizationId } }),
      prisma.usageEvent.aggregate({
        where: { organizationId, workspaceId, occurredAt: window },
        _sum: { estimatedCostMicros: true },
      }),
      // Organization aggregate spans this organization's workspaces ONLY.
      prisma.usageEvent.aggregate({
        where: { organizationId, occurredAt: window },
        _sum: { estimatedCostMicros: true },
      }),
      prisma.usageEvent.count({
        where: { organizationId, workspaceId, occurredAt: window, estimatedCostMicros: null },
      }),
      prisma.usageEvent.count({
        where: { organizationId, occurredAt: window, estimatedCostMicros: null },
      }),
      prisma.budgetReservation.findMany({
        where: { organizationId, status: 'ACTIVE', expiresAt: { gt: now } },
        select: { workspaceId: true, kind: true, estimatedCostMicros: true, requests: true },
      }),
      prisma.budgetOperationLimit.findMany({ where: { organizationId, kind } }),
    ]);

  const wsReservedMicros = reservations
    .filter((r) => r.workspaceId === workspaceId)
    .reduce((sum, r) => sum + r.estimatedCostMicros, 0);
  const orgReservedMicros = reservations.reduce((sum, r) => sum + r.estimatedCostMicros, 0);

  const incremental = estimate.micros ?? 0;

  const workspace = buildCeiling(
    wsBudget,
    wsSpend._sum.estimatedCostMicros ?? 0,
    wsReservedMicros,
    wsUnpriced,
  );
  const organization = orgBudget
    ? buildCeiling(
        orgBudget,
        orgSpend._sum.estimatedCostMicros ?? 0,
        orgReservedMicros,
        orgUnpriced,
      )
    : null;

  // ---- per-operation limits (the only bound that works when price is unknown)
  const wsLimit = limits.find((l) => l.workspaceId === workspaceId) ?? null;
  const orgLimit = limits.find((l) => l.workspaceId === null) ?? null;
  const operation =
    wsLimit || orgLimit
      ? await buildOperationUsage(prisma, {
          organizationId,
          workspaceId,
          kind,
          window,
          wsLimit,
          orgLimit,
          reservations,
        })
      : null;

  const warnings: BudgetWarning[] = [];
  let outcome = 'ALLOW' as PreflightOutcome;
  let exceededReason: LimitExceededReason | undefined;
  let reason = 'Within all configured budgets.';

  // ---- BLOCK checks, strictest wins ---------------------------------------
  const block = (r: LimitExceededReason, message: string) => {
    if (outcome !== 'BLOCK') {
      outcome = 'BLOCK';
      exceededReason = r;
      reason = message;
    }
  };

  if (operation) {
    if (
      operation.maxRequests !== null &&
      operation.requests + (request.requests ?? 1) > operation.maxRequests
    ) {
      const scopeIsOrg = orgLimit?.maxRequests === operation.maxRequests && !wsLimit?.maxRequests;
      block(
        scopeIsOrg ? 'ORGANIZATION_OPERATION_LIMIT' : 'WORKSPACE_OPERATION_LIMIT',
        `The monthly limit of ${operation.maxRequests} ${kind} operation(s) has been reached (${operation.requests} used).`,
      );
    } else if (operation.maxTokens !== null && operation.measuredTokens >= operation.maxTokens) {
      block(
        'WORKSPACE_OPERATION_LIMIT',
        `The monthly limit of ${operation.maxTokens} ${kind} token(s) has been reached (${operation.measuredTokens} measured).`,
      );
    }
  }

  const ceilingBlocked = (view: CeilingView): boolean =>
    view.limitMicros !== null &&
    view.enforcement === 'ENFORCE' &&
    view.usedMicros + view.reservedMicros + incremental >= view.limitMicros;

  if (ceilingBlocked(workspace)) {
    block(
      'WORKSPACE_COST_CEILING',
      `This workspace has reached its monthly limit (estimated ${money(workspace.usedMicros + workspace.reservedMicros)} of ${money(workspace.limitMicros as number)}). New paid work is refused until the limit is raised or the period rolls over on ${periodEnd.toISOString().slice(0, 10)}.`,
    );
  }
  if (organization && ceilingBlocked(organization)) {
    block(
      'ORGANIZATION_COST_CEILING',
      `This organization has reached its monthly limit (estimated ${money(organization.usedMicros + organization.reservedMicros)} of ${money(organization.limitMicros as number)}). New paid work is refused across all its workspaces until the limit is raised or the period rolls over on ${periodEnd.toISOString().slice(0, 10)}.`,
    );
  }

  // ---- warnings (do not block) --------------------------------------------
  for (const [scope, view] of [
    ['WORKSPACE', workspace],
    ['ORGANIZATION', organization],
  ] as const) {
    if (!view || view.limitMicros === null || view.usedPercent === null) continue;
    const warnAt =
      scope === 'WORKSPACE' ? (wsBudget?.warnAtPercent ?? 80) : (orgBudget?.warnAtPercent ?? 80);
    if (view.usedPercent >= 100) {
      warnings.push({
        scope,
        message: `Over the ${scope.toLowerCase()} monthly limit (${view.usedPercent}%), but enforcement is ${view.enforcement} so work is not refused.`,
      });
    } else if (view.usedPercent >= warnAt) {
      warnings.push({
        scope,
        message: `${view.usedPercent}% of the ${scope.toLowerCase()} monthly limit used.`,
      });
    }
    if (view.unpricedEvents > 0) {
      warnings.push({
        scope,
        message: `${view.unpricedEvents} metered event(s) this period could not be priced, so real spend is higher than this estimate.`,
      });
    }
  }

  if (operation && operation.unknownQuantityEvents > 0) {
    warnings.push({
      scope: 'WORKSPACE',
      kind,
      message: `${operation.unknownQuantityEvents} ${kind} event(s) reported no token count; they are counted as operations but not as tokens.`,
    });
  }

  if (outcome !== 'BLOCK') {
    if (estimate.micros === null && estimate.unpricedReason === 'NO_RATE_FOR_MODEL') {
      // Real spend we cannot price. Allowed, but never silently: the operator is
      // told the ceiling cannot see this operation.
      outcome = 'UNKNOWN_COST_ALLOW_WITH_NOTICE';
      reason =
        'This operation has no configured rate, so it cannot be counted against a cost ceiling. It is still counted against per-operation limits.';
    } else if (warnings.length > 0) {
      outcome = 'ALLOW_WITH_WARNING';
      reason = warnings[0]?.message ?? reason;
    }
  }

  return {
    outcome,
    blocked: outcome === 'BLOCK',
    kind,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    ...(exceededReason ? { exceededReason } : {}),
    warnings,
    ...(estimate.unpricedReason ? { unpricedReason: estimate.unpricedReason } : {}),
    ...(estimate.unpricedReason
      ? { unpricedNotice: UNPRICED_REASON_TEXT[estimate.unpricedReason] }
      : {}),
    estimatedCostMicros: estimate.micros,
    workspace,
    organization,
    operation,
    reason,
  };
}

function buildCeiling(
  budget: { enforcement: string; monthlyLimitMicros: number | null } | null,
  usedMicros: number,
  reservedMicros: number,
  unpricedEvents: number,
): CeilingView {
  if (!budget || budget.monthlyLimitMicros === null || budget.monthlyLimitMicros <= 0) {
    return { ...EMPTY_CEILING, usedMicros, reservedMicros, unpricedEvents };
  }
  const limitMicros = budget.monthlyLimitMicros;
  const committed = usedMicros + reservedMicros;
  return {
    configured: true,
    enforcement: budget.enforcement as BudgetEnforcement,
    limitMicros,
    usedMicros,
    reservedMicros,
    remainingMicros: limitMicros - committed,
    usedPercent: Math.round((committed / limitMicros) * 100),
    unpricedEvents,
  };
}

async function buildOperationUsage(
  prisma: BudgetReadClient,
  args: {
    organizationId: string;
    workspaceId: string;
    kind: UsageKind;
    window: { gte: Date; lt: Date };
    wsLimit: { maxRequests: number | null; maxTokens: number | null } | null;
    orgLimit: { maxRequests: number | null; maxTokens: number | null } | null;
    reservations: Array<{ workspaceId: string; kind: string; requests: number }>;
  },
): Promise<OperationUsage> {
  const { organizationId, workspaceId, kind, window } = args;
  // Org-scoped limits count the whole organization; workspace limits count one.
  const orgScoped = args.wsLimit === null && args.orgLimit !== null;
  const where = orgScoped
    ? { organizationId, kind, occurredAt: window }
    : { organizationId, workspaceId, kind, occurredAt: window };

  const [totals, unknown] = await Promise.all([
    prisma.usageEvent.aggregate({
      where,
      _sum: { requests: true, inputTokens: true, outputTokens: true, totalTokens: true },
    }),
    prisma.usageEvent.count({ where: { ...where, quantityUnknown: true } }),
  ]);

  const heldRequests = args.reservations
    .filter((r) => r.kind === kind && (orgScoped || r.workspaceId === workspaceId))
    .reduce((sum, r) => sum + r.requests, 0);

  const requests = (totals._sum.requests ?? 0) + heldRequests;
  const measuredTokens =
    (totals._sum.inputTokens ?? 0) +
    (totals._sum.outputTokens ?? 0) +
    (totals._sum.totalTokens ?? 0);

  // Strictest of the two limits wins when both are configured.
  const maxRequests = strictest(args.wsLimit?.maxRequests, args.orgLimit?.maxRequests);
  const maxTokens = strictest(args.wsLimit?.maxTokens, args.orgLimit?.maxTokens);

  return {
    kind,
    requests,
    measuredTokens,
    unknownQuantityEvents: unknown,
    maxRequests,
    maxTokens,
    remainingRequests: maxRequests === null ? null : maxRequests - requests,
    remainingTokens: maxTokens === null ? null : maxTokens - measuredTokens,
  };
}

function strictest(a: number | null | undefined, b: number | null | undefined): number | null {
  const values = [a, b].filter((v): v is number => typeof v === 'number');
  return values.length === 0 ? null : Math.min(...values);
}

function money(micros: number): string {
  const value = micros / 1_000_000;
  if (value !== 0 && Math.abs(value) < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/** Raised when pre-flight blocks an operation. Carries the whole decision. */
export class BudgetBlockedError extends Error {
  readonly decision: PreflightDecision;

  constructor(decision: PreflightDecision) {
    super(decision.reason);
    this.name = 'BudgetBlockedError';
    this.decision = decision;
  }
}

/** Runs pre-flight and throws when the outcome is BLOCK. */
export async function assertPreflight(
  prisma: BudgetReadClient,
  request: PreflightRequest,
  now: Date = new Date(),
): Promise<PreflightDecision> {
  const decision = await preflight(prisma, request, now);
  if (decision.blocked) throw new BudgetBlockedError(decision);
  return decision;
}
