import { describe, expect, it } from 'vitest';

import {
  availableCredits,
  expiringBy,
  expiryFor,
  planDeduction,
  planReversal,
  spendableGrants,
  type LedgerGrant,
} from './credits';
import {
  EntitlementExceededError,
  assertEntitled,
  checkEntitlement,
  effectivePlan,
  type EntitlementContext,
} from './entitlements';
import { BUILT_IN_PLANS, FALLBACK_PLAN_KEY, builtInPlan } from './plans';

const NOW = new Date('2026-10-08T12:00:00.000Z');

const freePlan = { key: 'free', entitlements: builtInPlan('free')!.entitlements };
const growthPlan = { key: 'growth', entitlements: builtInPlan('growth')!.entitlements };

function context(overrides: Partial<EntitlementContext> = {}): EntitlementContext {
  return { plan: growthPlan, status: 'ACTIVE', fallbackPlan: freePlan, ...overrides };
}

describe('effective plan', () => {
  it.each(['ACTIVE', 'TRIALING', 'PAST_DUE'] as const)('keeps the plan while %s', (status) => {
    expect(effectivePlan(context({ status })).key).toBe('growth');
  });

  it.each(['CANCELED', 'UNPAID', 'INCOMPLETE', 'INCOMPLETE_EXPIRED', 'PAUSED'] as const)(
    'falls back to free when %s',
    (status) => {
      // A lapsed subscription does not keep its generosity.
      expect(effectivePlan(context({ status })).key).toBe('free');
    },
  );

  it('falls back when there is no subscription at all', () => {
    expect(effectivePlan(context({ plan: null, status: null })).key).toBe('free');
  });

  it('keeps PAST_DUE working, because dunning is the provider’s job', () => {
    const decision = checkEntitlement({
      key: 'RESEARCH_RUNS_PER_PERIOD',
      used: 100,
      context: context({ status: 'PAST_DUE' }),
    });

    expect(decision.allowed).toBe(true);
    expect(decision.planKey).toBe('growth');
  });
});

describe('entitlement checks', () => {
  it('allows a request inside the limit and reports what is left', () => {
    const decision = checkEntitlement({
      key: 'RESEARCH_RUNS_PER_PERIOD',
      used: 10,
      context: context(),
    });

    expect(decision).toMatchObject({
      outcome: 'ALLOWED',
      allowed: true,
      limit: 300,
      remaining: 290,
    });
  });

  it('refuses the request that would cross the limit, not the one after it', () => {
    const atLimit = checkEntitlement({
      key: 'WORKSPACE_COUNT',
      used: 10,
      context: context(),
    });

    expect(atLimit.allowed).toBe(false);
    expect(atLimit.outcome).toBe('AT_LIMIT');
    expect(atLimit.reason).toContain('the growth plan allows 10');
  });

  it('counts the size of the request, not just one at a time', () => {
    const bulk = checkEntitlement({
      key: 'WORKSPACE_COUNT',
      used: 8,
      requested: 5,
      context: context(),
    });

    expect(bulk.allowed).toBe(false);
  });

  it('treats null as unlimited', () => {
    const decision = checkEntitlement({
      key: 'CONTENT_GENERATIONS_PER_PERIOD',
      used: 1_000_000,
      context: context({
        plan: { key: 'scale', entitlements: builtInPlan('scale')!.entitlements },
      }),
    });

    expect(decision).toMatchObject({ allowed: true, limit: null, remaining: null });
    expect(decision.reason).toContain('unlimited');
  });

  it('refuses a key the plan does not grant at all, distinctly from being at a limit', () => {
    const decision = checkEntitlement({
      key: 'STORAGE_BYTES',
      used: 0,
      context: context({ plan: { key: 'custom', entitlements: { WORKSPACE_COUNT: 1 } } }),
    });

    expect(decision.outcome).toBe('NOT_IN_PLAN');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('not included in the custom plan');
  });

  it('explains a refusal caused by having no subscription, rather than blaming the plan', () => {
    const decision = checkEntitlement({
      key: 'WORKSPACE_COUNT',
      used: 1,
      context: context({ status: 'CANCELED' }),
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('no active subscription');
  });

  it('inverts for sync frequency, where a smaller interval is the better plan', () => {
    // growth allows 60 minutes. Asking for hourly is fine; asking for every
    // 15 minutes is not — the opposite of every other entitlement.
    const hourly = checkEntitlement({
      key: 'ANALYTICS_SYNC_MIN_INTERVAL_MINUTES',
      used: 0,
      requested: 60,
      context: context(),
    });
    const tooFrequent = checkEntitlement({
      key: 'ANALYTICS_SYNC_MIN_INTERVAL_MINUTES',
      used: 0,
      requested: 15,
      context: context(),
    });

    expect(hourly.allowed).toBe(true);
    expect(tooFrequent.allowed).toBe(false);
    expect(tooFrequent.reason).toContain('at least 60 minutes');
  });

  it('throws a typed error carrying the decision', () => {
    const error = (() => {
      try {
        assertEntitled({ key: 'WORKSPACE_COUNT', used: 99, context: context() });
        return null;
      } catch (caught) {
        return caught as EntitlementExceededError;
      }
    })();

    expect(error).toBeInstanceOf(EntitlementExceededError);
    expect(error!.decision.key).toBe('WORKSPACE_COUNT');
    expect(error!.decision.limit).toBe(10);
  });
});

describe('the plan catalog', () => {
  it('always contains the fallback plan', () => {
    expect(builtInPlan(FALLBACK_PLAN_KEY)).toBeTruthy();
  });

  it('defines every entitlement key on every built-in plan', () => {
    // A plan missing a key would silently read as NOT_IN_PLAN at runtime.
    const keys = Object.keys(builtInPlan('free')!.entitlements);
    for (const plan of BUILT_IN_PLANS) {
      expect(Object.keys(plan.entitlements).sort()).toEqual(keys.sort());
    }
  });

  it('is monotonic: a higher tier is never stingier', () => {
    const order = ['free', 'starter', 'growth'] as const;
    for (let i = 1; i < order.length; i += 1) {
      const lower = builtInPlan(order[i - 1]!)!.entitlements;
      const higher = builtInPlan(order[i]!)!.entitlements;
      expect(higher.WORKSPACE_COUNT!).toBeGreaterThanOrEqual(lower.WORKSPACE_COUNT!);
      // Sync interval inverts: the better plan allows a *smaller* gap.
      expect(higher.ANALYTICS_SYNC_MIN_INTERVAL_MINUTES!).toBeLessThanOrEqual(
        lower.ANALYTICS_SYNC_MIN_INTERVAL_MINUTES!,
      );
    }
  });
});

function grant(overrides: Partial<LedgerGrant> = {}): LedgerGrant {
  return {
    id: 'g1',
    source: 'PURCHASED',
    remaining: 100,
    expiresAt: null,
    grantedAt: new Date('2026-10-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('credit ledger', () => {
  it('spends soonest-expiring credits first, not the ones that were paid for', () => {
    const monthly = grant({
      id: 'monthly',
      source: 'MONTHLY_ALLOWANCE',
      remaining: 50,
      expiresAt: new Date('2026-11-01T00:00:00.000Z'),
    });
    const purchased = grant({ id: 'purchased', source: 'PURCHASED', remaining: 500 });

    const plan = planDeduction([purchased, monthly], 70, NOW);

    expect(plan.deductions).toEqual([
      { grantId: 'monthly', amount: 50 },
      { grantId: 'purchased', amount: 20 },
    ]);
    expect(plan.shortfall).toBe(0);
  });

  it('prefers an expiring grant over a never-expiring one, however old', () => {
    const ancient = grant({ id: 'ancient', grantedAt: new Date('2020-01-01'), expiresAt: null });
    const expiring = grant({
      id: 'expiring',
      grantedAt: new Date('2026-10-07'),
      expiresAt: new Date('2026-12-01'),
    });

    expect(spendableGrants([ancient, expiring], NOW).map((g) => g.id)).toEqual([
      'expiring',
      'ancient',
    ]);
  });

  it('ignores expired and empty grants', () => {
    const expired = grant({ id: 'expired', expiresAt: new Date('2026-09-01') });
    const empty = grant({ id: 'empty', remaining: 0 });
    const live = grant({ id: 'live', remaining: 10 });

    expect(availableCredits([expired, empty, live], NOW)).toBe(10);
    expect(spendableGrants([expired, empty, live], NOW).map((g) => g.id)).toEqual(['live']);
  });

  it('reports a shortfall instead of silently part-charging', () => {
    const plan = planDeduction([grant({ remaining: 30 })], 100, NOW);

    expect(plan.shortfall).toBe(70);
    expect(plan.deductions).toEqual([{ grantId: 'g1', amount: 30 }]);
  });

  it('treats a zero or negative deduction as a no-op', () => {
    expect(planDeduction([grant()], 0, NOW).deductions).toEqual([]);
    expect(planDeduction([grant()], -5, NOW).deductions).toEqual([]);
  });

  it('returns a reversal to the grant it came from', () => {
    const original = [{ grantId: 'g1', amount: 20 }];

    const { restorations, unrestorable } = planReversal(original, [grant()], NOW);

    expect(restorations).toEqual([{ grantId: 'g1', amount: 20 }]);
    expect(unrestorable).toBe(0);
  });

  it('refuses to revive a lapsed grant, reporting the amount instead', () => {
    // Returning credits to an expired grant would quietly extend its life.
    const expired = grant({ expiresAt: new Date('2026-09-01') });

    const { restorations, unrestorable } = planReversal(
      [{ grantId: 'g1', amount: 20 }],
      [expired],
      NOW,
    );

    expect(restorations).toEqual([]);
    expect(unrestorable).toBe(20);
  });

  it('applies the expiry policy by source', () => {
    const periodEnd = new Date('2026-11-01T00:00:00.000Z');
    const explicit = new Date('2027-01-01T00:00:00.000Z');

    expect(expiryFor('MONTHLY_ALLOWANCE', periodEnd, null)).toBe(periodEnd);
    expect(expiryFor('PURCHASED', periodEnd, null)).toBeNull();
    expect(expiryFor('PURCHASED', periodEnd, explicit)).toBe(explicit);
    expect(expiryFor('MANUAL', periodEnd, explicit)).toBe(explicit);
  });

  it('reports what lapses at period end, so the UI can warn', () => {
    const monthly = grant({ id: 'm', remaining: 40, expiresAt: new Date('2026-10-31') });
    const purchased = grant({ id: 'p', remaining: 60, expiresAt: null });

    expect(expiringBy([monthly, purchased], new Date('2026-11-01'), NOW)).toBe(40);
    expect(expiringBy([monthly, purchased], null, NOW)).toBe(0);
  });
});
