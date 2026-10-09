import {
  ENTITLED_SUBSCRIPTION_STATUSES,
  ENTITLEMENT_DEFINITIONS,
  type EntitlementDecision,
  type EntitlementKey,
  type PlanEntitlements,
  type SubscriptionStatus,
} from '@spectra/contracts';

/**
 * Entitlement resolution and enforcement.
 *
 * An entitlement caps what a **plan** allows. It is not a budget: a budget caps
 * *estimated spend* (ADR-0026) and answers "is this going to cost too much?",
 * while an entitlement answers "does this plan include this at all?". Both can
 * refuse the same request, for different reasons, and the two answers are
 * never merged.
 *
 * The bias is explicit: **no subscription means no plan limits, not unlimited
 * use.** An organization with no active subscription falls back to the free
 * plan's entitlements, never to "allow everything".
 */

export interface ResolvedPlan {
  key: string;
  entitlements: PlanEntitlements;
}

export interface EntitlementContext {
  /** The plan the organization is actually entitled to right now. */
  plan: ResolvedPlan | null;
  /** The subscription's status, or null when there is no subscription. */
  status: SubscriptionStatus | null;
  /** The plan applied when no subscription entitles one. Never null in practice. */
  fallbackPlan: ResolvedPlan;
}

/**
 * Which plan's limits actually apply. A `CANCELED` or `UNPAID` subscription
 * does not keep its plan's generosity — it falls back.
 */
export function effectivePlan(context: EntitlementContext): ResolvedPlan {
  if (!context.plan || !context.status) return context.fallbackPlan;
  const entitled = (ENTITLED_SUBSCRIPTION_STATUSES as readonly SubscriptionStatus[]).includes(
    context.status,
  );
  return entitled ? context.plan : context.fallbackPlan;
}

export interface CheckInput {
  key: EntitlementKey;
  /** What the organization has used, or holds, already. */
  used: number;
  /** How much this request would add. Defaults to 1. */
  requested?: number;
  context: EntitlementContext;
}

/**
 * Decides one entitlement. Pure, so the API, the worker and the UI all answer
 * the question identically.
 */
export function checkEntitlement(input: CheckInput): EntitlementDecision {
  const definition = ENTITLEMENT_DEFINITIONS[input.key];
  const plan = effectivePlan(input.context);
  const requested = input.requested ?? 1;
  const hasKey = Object.prototype.hasOwnProperty.call(plan.entitlements, input.key);
  const limit = hasKey ? (plan.entitlements[input.key] ?? null) : undefined;

  const usingFallback = plan.key === input.context.fallbackPlan.key && input.context.plan !== null;

  if (limit === undefined) {
    return {
      key: input.key,
      outcome: 'NOT_IN_PLAN',
      allowed: false,
      limit: 0,
      used: input.used,
      remaining: 0,
      planKey: plan.key,
      reason: `${definition.label} is not included in the ${plan.key} plan.`,
    };
  }

  // Unlimited.
  if (limit === null) {
    return {
      key: input.key,
      outcome: 'ALLOWED',
      allowed: true,
      limit: null,
      used: input.used,
      remaining: null,
      planKey: plan.key,
      reason: `${definition.label} is unlimited on the ${plan.key} plan.`,
    };
  }

  // An interval entitlement inverts: a *smaller* configured interval is more
  // permissive, so "used" is the interval being asked for, and it must be at
  // least the plan's floor.
  if (!definition.higherIsMorePermissive) {
    const allowed = requested >= limit;
    return {
      key: input.key,
      outcome: allowed ? 'ALLOWED' : 'AT_LIMIT',
      allowed,
      limit,
      used: input.used,
      remaining: null,
      planKey: plan.key,
      reason: allowed
        ? `${definition.label}: the ${plan.key} plan allows a gap of ${limit} minutes or more.`
        : `${definition.label}: the ${plan.key} plan requires at least ${limit} minutes between syncs; ${requested} was asked for.`,
    };
  }

  const remaining = Math.max(0, limit - input.used);
  const allowed = input.used + requested <= limit;

  return {
    key: input.key,
    outcome: allowed ? 'ALLOWED' : 'AT_LIMIT',
    allowed,
    limit,
    used: input.used,
    remaining,
    planKey: plan.key,
    reason: allowed
      ? `${definition.label}: ${input.used} of ${limit} used on the ${plan.key} plan.`
      : usingFallback
        ? `${definition.label}: this organization has no active subscription, so the ${plan.key} plan applies — ${limit} allowed, ${input.used} already used.`
        : `${definition.label}: the ${plan.key} plan allows ${limit}, and ${input.used} ${definition.kind === 'PERIOD' ? 'have been used this period' : 'are already in use'}.`,
  };
}

/** Thrown when an entitlement refuses an operation. Carries the decision. */
export class EntitlementExceededError extends Error {
  readonly decision: EntitlementDecision;
  constructor(decision: EntitlementDecision) {
    super(decision.reason);
    this.name = 'EntitlementExceededError';
    this.decision = decision;
  }
}

export function assertEntitled(input: CheckInput): EntitlementDecision {
  const decision = checkEntitlement(input);
  if (!decision.allowed) throw new EntitlementExceededError(decision);
  return decision;
}
