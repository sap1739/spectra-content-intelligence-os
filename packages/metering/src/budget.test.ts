import { describe, expect, it, vi } from 'vitest';

import {
  BudgetExceededError,
  assertWithinBudget,
  evaluateBudget,
  periodEndFor,
  periodStartFor,
} from './budget';

const TENANT = { organizationId: 'org-1', workspaceId: 'ws-1' };
const NOW = new Date('2026-09-09T12:00:00.000Z');

function fakePrisma(opts: {
  budget?: Record<string, unknown> | null;
  spendMicros?: number | null;
  unpriced?: number;
}) {
  const aggregate = vi.fn(async () => ({
    _sum: { estimatedCostMicros: opts.spendMicros ?? null },
  }));
  const count = vi.fn(async () => opts.unpriced ?? 0);
  const findFirst = vi.fn(async () => opts.budget ?? null);
  return {
    client: {
      workspaceBudget: { findFirst },
      usageEvent: { aggregate, count },
    },
    findFirst,
    aggregate,
    count,
  };
}

describe('period helpers', () => {
  it('spans the current UTC calendar month', () => {
    expect(periodStartFor(NOW).toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(periodEndFor(NOW).toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('rolls the year over in December', () => {
    const dec = new Date('2026-12-20T00:00:00.000Z');
    expect(periodEndFor(dec).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('evaluateBudget', () => {
  it('reports NOT_CONFIGURED — never OK — when no budget row exists', async () => {
    const p = fakePrisma({ budget: null, spendMicros: 5_000 });
    const decision = await evaluateBudget(p.client as never, TENANT, NOW);
    // OK would assert a real ceiling was checked. Nothing was.
    expect(decision.status).toBe('NOT_CONFIGURED');
    expect(decision.blocked).toBe(false);
    expect(decision.limitMicros).toBeNull();
    expect(decision.remainingMicros).toBeNull();
    expect(decision.reason).toMatch(/No monthly spend limit is configured/);
  });

  it('reports NOT_CONFIGURED when a row exists with no ceiling', async () => {
    const p = fakePrisma({
      budget: { enforcement: 'ENFORCE', monthlyLimitMicros: null },
      spendMicros: 999_999,
    });
    const decision = await evaluateBudget(p.client as never, TENANT, NOW);
    expect(decision.status).toBe('NOT_CONFIGURED');
    expect(decision.blocked).toBe(false);
  });

  it('reports OK below the warn threshold', async () => {
    const p = fakePrisma({
      budget: { enforcement: 'ENFORCE', monthlyLimitMicros: 1_000_000, warnAtPercent: 80 },
      spendMicros: 100_000,
    });
    const decision = await evaluateBudget(p.client as never, TENANT, NOW);
    expect(decision.status).toBe('OK');
    expect(decision.usedPercent).toBe(10);
    expect(decision.remainingMicros).toBe(900_000);
    expect(decision.blocked).toBe(false);
  });

  it('reports WARN at the configured threshold without blocking', async () => {
    const p = fakePrisma({
      budget: { enforcement: 'ENFORCE', monthlyLimitMicros: 1_000_000, warnAtPercent: 80 },
      spendMicros: 850_000,
    });
    const decision = await evaluateBudget(p.client as never, TENANT, NOW);
    expect(decision.status).toBe('WARN');
    expect(decision.blocked).toBe(false);
  });

  it('blocks only under ENFORCE when the ceiling is reached', async () => {
    const enforcing = fakePrisma({
      budget: { enforcement: 'ENFORCE', monthlyLimitMicros: 1_000_000 },
      spendMicros: 1_000_000,
    });
    const decision = await evaluateBudget(enforcing.client as never, TENANT, NOW);
    expect(decision.status).toBe('EXCEEDED');
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toMatch(/refused/);
  });

  it('reports EXCEEDED but does NOT block under WARN', async () => {
    const warning = fakePrisma({
      budget: { enforcement: 'WARN', monthlyLimitMicros: 1_000_000 },
      spendMicros: 2_000_000,
    });
    const decision = await evaluateBudget(warning.client as never, TENANT, NOW);
    expect(decision.status).toBe('EXCEEDED');
    expect(decision.blocked).toBe(false);
    expect(decision.reason).toMatch(/enforcement is WARN/);
  });

  it('reports EXCEEDED but does NOT block under OFF', async () => {
    const off = fakePrisma({
      budget: { enforcement: 'OFF', monthlyLimitMicros: 1_000 },
      spendMicros: 50_000,
    });
    const decision = await evaluateBudget(off.client as never, TENANT, NOW);
    expect(decision.blocked).toBe(false);
  });

  it('carries unpriced-event count so under-counting is visible', async () => {
    const p = fakePrisma({
      budget: { enforcement: 'ENFORCE', monthlyLimitMicros: 1_000_000 },
      spendMicros: 100_000,
      unpriced: 7,
    });
    const decision = await evaluateBudget(p.client as never, TENANT, NOW);
    // Real spend is higher than usedMicros; the caller must be able to see that.
    expect(decision.unpricedEvents).toBe(7);
  });

  it('treats no recorded spend as zero used, not as an error', async () => {
    const p = fakePrisma({
      budget: { enforcement: 'ENFORCE', monthlyLimitMicros: 1_000_000 },
      spendMicros: null,
    });
    const decision = await evaluateBudget(p.client as never, TENANT, NOW);
    expect(decision.usedMicros).toBe(0);
    expect(decision.status).toBe('OK');
  });

  it('scopes both the budget lookup and the spend sum to the tenant', async () => {
    const p = fakePrisma({ budget: null });
    await evaluateBudget(p.client as never, TENANT, NOW);
    const budgetWhere = (
      p.findFirst.mock.calls[0] as unknown as [{ where: Record<string, unknown> }]
    )[0].where;
    expect(budgetWhere['organizationId']).toBe('org-1');
    expect(budgetWhere['workspaceId']).toBe('ws-1');
    const spendWhere = (
      p.aggregate.mock.calls[0] as unknown as [{ where: Record<string, unknown> }]
    )[0].where;
    expect(spendWhere['organizationId']).toBe('org-1');
    expect(spendWhere['workspaceId']).toBe('ws-1');
  });
});

describe('reason formatting', () => {
  it('keeps sub-cent precision so a small limit never reads as zero', async () => {
    const p = fakePrisma({
      budget: { enforcement: 'ENFORCE', monthlyLimitMicros: 1_000 },
      spendMicros: 9_000_000,
    });
    const decision = await evaluateBudget(p.client as never, TENANT, NOW);
    // $0.001 must not render as "$0.00".
    expect(decision.reason).toContain('$0.0010');
    expect(decision.reason).toContain('$9.00');
  });
});

describe('assertWithinBudget', () => {
  it('throws with the full decision attached when blocked', async () => {
    const p = fakePrisma({
      budget: { enforcement: 'ENFORCE', monthlyLimitMicros: 1_000 },
      spendMicros: 5_000,
    });
    await expect(assertWithinBudget(p.client as never, TENANT, NOW)).rejects.toThrow(
      BudgetExceededError,
    );
    await assertWithinBudget(p.client as never, TENANT, NOW).catch((error: unknown) => {
      expect((error as BudgetExceededError).decision.status).toBe('EXCEEDED');
      expect((error as BudgetExceededError).decision.limitMicros).toBe(1_000);
    });
  });

  it('returns the decision when not blocked', async () => {
    const p = fakePrisma({ budget: null });
    await expect(assertWithinBudget(p.client as never, TENANT, NOW)).resolves.toMatchObject({
      status: 'NOT_CONFIGURED',
    });
  });
});
