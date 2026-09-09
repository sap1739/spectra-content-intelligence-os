import type { TenantScope } from '@spectra/contracts';
import type { SpectraPrismaClient } from '@spectra/database';

/**
 * Per-workspace spend ceilings, evaluated BEFORE expensive work starts.
 *
 * Two honesty constraints shape this module:
 *
 * 1. "No budget configured" is its own state (`NOT_CONFIGURED`), never `OK`.
 *    `OK` asserts that a real limit was checked and there is room under it;
 *    saying that when nothing was checked would be a false reassurance.
 *
 * 2. Budgets are enforced against ESTIMATED cost (ADR-0026), which is
 *    approximate and excludes operations with no known rate. Every decision
 *    carries `unpricedEvents` so the incompleteness travels with the number
 *    instead of being quietly dropped.
 */

export type BudgetEnforcement = 'OFF' | 'WARN' | 'ENFORCE';

export type BudgetStatus =
  /** No budget row, or no ceiling set on it — nothing to exceed. */
  | 'NOT_CONFIGURED'
  /** A real ceiling exists and current spend is comfortably under it. */
  | 'OK'
  /** Past `warnAtPercent` of the ceiling but still under it. */
  | 'WARN'
  /** At or over the ceiling. */
  | 'EXCEEDED';

export interface BudgetDecision {
  status: BudgetStatus;
  enforcement: BudgetEnforcement;
  /** True only when work must actually be refused. */
  blocked: boolean;
  /** Calendar-month window the spend was summed over (UTC, ISO-8601). */
  periodStart: string;
  periodEnd: string;
  limitMicros: number | null;
  usedMicros: number;
  remainingMicros: number | null;
  usedPercent: number | null;
  /**
   * Metered events in this period that had no known rate and so contributed
   * nothing to `usedMicros`. Non-zero means real spend is UNDER-counted.
   */
  unpricedEvents: number;
  currency: string;
  /** Operator-facing explanation; always populated, always specific. */
  reason: string;
}

/** Start of the current UTC calendar month. */
export function periodStartFor(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Start of the next UTC calendar month. */
export function periodEndFor(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/**
 * Evaluates the workspace budget for the current calendar month.
 *
 * Tenant-scoped: both the budget lookup and the spend aggregate filter by
 * `organizationId` AND `workspaceId`.
 */
export async function evaluateBudget(
  prisma: SpectraPrismaClient,
  tenant: Required<TenantScope>,
  now: Date = new Date(),
): Promise<BudgetDecision> {
  const periodStart = periodStartFor(now);
  const periodEnd = periodEndFor(now);

  const budget = await prisma.workspaceBudget.findFirst({
    where: { organizationId: tenant.organizationId, workspaceId: tenant.workspaceId },
  });

  const [spend, unpriced] = await Promise.all([
    prisma.usageEvent.aggregate({
      where: {
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId,
        occurredAt: { gte: periodStart, lt: periodEnd },
      },
      _sum: { estimatedCostMicros: true },
    }),
    prisma.usageEvent.count({
      where: {
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId,
        occurredAt: { gte: periodStart, lt: periodEnd },
        estimatedCostMicros: null,
      },
    }),
  ]);

  const usedMicros = spend._sum.estimatedCostMicros ?? 0;
  const enforcement = (budget?.enforcement ?? 'OFF') as BudgetEnforcement;
  const limitMicros = budget?.monthlyLimitMicros ?? null;
  const currency = budget?.currency ?? 'USD';

  const base = {
    enforcement,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    limitMicros,
    usedMicros,
    unpricedEvents: unpriced,
    currency,
  };

  // No ceiling => nothing to be under. Reported as NOT_CONFIGURED, not OK.
  if (limitMicros === null || limitMicros <= 0) {
    return {
      ...base,
      status: 'NOT_CONFIGURED',
      blocked: false,
      remainingMicros: null,
      usedPercent: null,
      reason: 'No monthly spend limit is configured for this workspace, so no ceiling was checked.',
    };
  }

  const remainingMicros = limitMicros - usedMicros;
  const usedPercent = Math.round((usedMicros / limitMicros) * 100);
  const warnAt = budget?.warnAtPercent ?? 80;

  if (usedMicros >= limitMicros) {
    // Only ENFORCE actually blocks; WARN/OFF report the same truth without
    // stopping work, so an operator can observe before committing to a hard cap.
    const blocked = enforcement === 'ENFORCE';
    return {
      ...base,
      status: 'EXCEEDED',
      blocked,
      remainingMicros,
      usedPercent,
      reason: blocked
        ? `This workspace has reached its monthly limit (estimated ${fmt(usedMicros)} of ${fmt(limitMicros)} ${currency}). New paid work is refused until the limit is raised or the period rolls over on ${periodEnd.toISOString().slice(0, 10)}.`
        : `This workspace is over its monthly limit (estimated ${fmt(usedMicros)} of ${fmt(limitMicros)} ${currency}), but enforcement is ${enforcement} so work is not being refused.`,
    };
  }

  if (usedPercent >= warnAt) {
    return {
      ...base,
      status: 'WARN',
      blocked: false,
      remainingMicros,
      usedPercent,
      reason: `This workspace has used an estimated ${usedPercent}% of its monthly limit (${fmt(usedMicros)} of ${fmt(limitMicros)} ${currency}).`,
    };
  }

  return {
    ...base,
    status: 'OK',
    blocked: false,
    remainingMicros,
    usedPercent,
    reason: `Estimated ${fmt(usedMicros)} of ${fmt(limitMicros)} ${currency} used this period.`,
  };
}

/**
 * Money for operator-facing messages. Sub-cent amounts keep more precision:
 * rendering a $0.001 limit as "$0.00" would read as a zero limit.
 */
function fmt(micros: number): string {
  const value = micros / 1_000_000;
  if (value !== 0 && Math.abs(value) < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/**
 * Raised when a budget in ENFORCE mode blocks new paid work. Carries the whole
 * decision so callers can surface exactly why, and how much room is left.
 */
export class BudgetExceededError extends Error {
  readonly decision: BudgetDecision;

  constructor(decision: BudgetDecision) {
    super(decision.reason);
    this.name = 'BudgetExceededError';
    this.decision = decision;
  }
}

/** Throws `BudgetExceededError` when the workspace budget blocks new work. */
export async function assertWithinBudget(
  prisma: SpectraPrismaClient,
  tenant: Required<TenantScope>,
  now: Date = new Date(),
): Promise<BudgetDecision> {
  const decision = await evaluateBudget(prisma, tenant, now);
  if (decision.blocked) throw new BudgetExceededError(decision);
  return decision;
}
