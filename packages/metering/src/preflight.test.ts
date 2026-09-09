import { describe, expect, it, vi } from 'vitest';

import { preflight, assertPreflight, BudgetBlockedError } from './preflight';

const ORG = 'org-1';
const WS = 'ws-1';
const NOW = new Date('2026-09-09T12:00:00.000Z');

interface FakeOpts {
  wsBudget?: Record<string, unknown> | null;
  orgBudget?: Record<string, unknown> | null;
  wsSpend?: number | null;
  orgSpend?: number | null;
  wsUnpriced?: number;
  orgUnpriced?: number;
  reservations?: Array<{
    workspaceId: string;
    kind: string;
    estimatedCostMicros: number;
    requests: number;
  }>;
  limits?: Array<Record<string, unknown>>;
  opRequests?: number;
  opTokens?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  unknownQuantity?: number;
}

function fakePrisma(o: FakeOpts = {}) {
  let aggregateCall = 0;
  let countCall = 0;
  return {
    workspaceBudget: { findFirst: vi.fn(async () => o.wsBudget ?? null) },
    organizationBudget: { findFirst: vi.fn(async () => o.orgBudget ?? null) },
    budgetReservation: { findMany: vi.fn(async () => o.reservations ?? []) },
    budgetOperationLimit: { findMany: vi.fn(async () => o.limits ?? []) },
    usageEvent: {
      aggregate: vi.fn(async () => {
        aggregateCall += 1;
        // 1st = workspace spend, 2nd = org spend, 3rd = per-operation totals.
        if (aggregateCall === 1) return { _sum: { estimatedCostMicros: o.wsSpend ?? null } };
        if (aggregateCall === 2) return { _sum: { estimatedCostMicros: o.orgSpend ?? null } };
        return {
          _sum: {
            requests: o.opRequests ?? 0,
            inputTokens: o.opTokens?.inputTokens ?? 0,
            outputTokens: o.opTokens?.outputTokens ?? 0,
            totalTokens: o.opTokens?.totalTokens ?? 0,
          },
        };
      }),
      count: vi.fn(async () => {
        countCall += 1;
        if (countCall === 1) return o.wsUnpriced ?? 0;
        if (countCall === 2) return o.orgUnpriced ?? 0;
        return o.unknownQuantity ?? 0;
      }),
    },
  };
}

const REQ = {
  organizationId: ORG,
  workspaceId: WS,
  kind: 'AI_GENERATION' as const,
  provider: 'anthropic',
  model: 'claude-opus-4-8',
  estimatedInputTokens: 1000,
};

describe('preflight — cost ceilings', () => {
  it('ALLOWs when nothing is configured', async () => {
    const d = await preflight(fakePrisma() as never, REQ, NOW);
    expect(d.outcome).toBe('ALLOW');
    expect(d.blocked).toBe(false);
    expect(d.workspace.configured).toBe(false);
    expect(d.organization).toBeNull();
  });

  it('BLOCKs on the workspace ceiling under ENFORCE', async () => {
    const d = await preflight(
      fakePrisma({
        wsBudget: { enforcement: 'ENFORCE', monthlyLimitMicros: 1_000, warnAtPercent: 80 },
        wsSpend: 5_000,
      }) as never,
      REQ,
      NOW,
    );
    expect(d.outcome).toBe('BLOCK');
    expect(d.exceededReason).toBe('WORKSPACE_COST_CEILING');
  });

  it('BLOCKs on the ORGANIZATION ceiling even when the workspace is fine', async () => {
    const d = await preflight(
      fakePrisma({
        wsBudget: { enforcement: 'ENFORCE', monthlyLimitMicros: 10_000_000, warnAtPercent: 80 },
        wsSpend: 1_000,
        orgBudget: { enforcement: 'ENFORCE', monthlyLimitMicros: 5_000, warnAtPercent: 80 },
        orgSpend: 9_000,
      }) as never,
      REQ,
      NOW,
    );
    // The stricter of the two scopes wins.
    expect(d.outcome).toBe('BLOCK');
    expect(d.exceededReason).toBe('ORGANIZATION_COST_CEILING');
  });

  it('does not block on an organization ceiling set to WARN', async () => {
    const d = await preflight(
      fakePrisma({
        orgBudget: { enforcement: 'WARN', monthlyLimitMicros: 1_000, warnAtPercent: 80 },
        orgSpend: 9_000,
      }) as never,
      REQ,
      NOW,
    );
    expect(d.blocked).toBe(false);
    expect(d.outcome).toBe('ALLOW_WITH_WARNING');
  });

  it('counts ACTIVE reservations as committed spend', async () => {
    const d = await preflight(
      fakePrisma({
        wsBudget: { enforcement: 'ENFORCE', monthlyLimitMicros: 10_000, warnAtPercent: 80 },
        wsSpend: 4_000,
        // Ledger alone is under the ceiling; the in-flight hold pushes it over.
        reservations: [
          { workspaceId: WS, kind: 'AI_GENERATION', estimatedCostMicros: 6_000, requests: 1 },
        ],
      }) as never,
      REQ,
      NOW,
    );
    expect(d.outcome).toBe('BLOCK');
    expect(d.workspace.reservedMicros).toBe(6_000);
  });
});

describe('preflight — unknown cost', () => {
  it('returns UNKNOWN_COST_ALLOW_WITH_NOTICE rather than treating it as free', async () => {
    const d = await preflight(
      fakePrisma() as never,
      {
        organizationId: ORG,
        workspaceId: WS,
        kind: 'AI_GENERATION',
        provider: 'mystery-vendor',
        model: 'm',
        estimatedInputTokens: 10,
      },
      NOW,
    );
    expect(d.outcome).toBe('UNKNOWN_COST_ALLOW_WITH_NOTICE');
    expect(d.estimatedCostMicros).toBeNull();
    expect(d.unpricedReason).toBe('NO_RATE_FOR_MODEL');
    expect(d.unpricedNotice).toBeTruthy();
  });

  it('an unknown-cost operation is still blocked by a per-kind request limit', async () => {
    const d = await preflight(
      fakePrisma({
        limits: [{ workspaceId: WS, kind: 'PUBLISH_ATTEMPT', maxRequests: 5, maxTokens: null }],
        opRequests: 5,
      }) as never,
      { organizationId: ORG, workspaceId: WS, kind: 'PUBLISH_ATTEMPT', provider: 'wordpress' },
      NOW,
    );
    // The only bound that works when the price is unknown.
    expect(d.outcome).toBe('BLOCK');
    expect(d.exceededReason).toBe('WORKSPACE_OPERATION_LIMIT');
  });
});

describe('preflight — per-kind limits', () => {
  it('BLOCKs when the monthly request limit is reached', async () => {
    const d = await preflight(
      fakePrisma({
        limits: [{ workspaceId: WS, kind: 'AI_GENERATION', maxRequests: 10, maxTokens: null }],
        opRequests: 10,
      }) as never,
      REQ,
      NOW,
    );
    expect(d.outcome).toBe('BLOCK');
    expect(d.operation?.maxRequests).toBe(10);
    expect(d.operation?.remainingRequests).toBe(0);
  });

  it('BLOCKs on a measured token limit', async () => {
    const d = await preflight(
      fakePrisma({
        limits: [{ workspaceId: WS, kind: 'AI_GENERATION', maxRequests: null, maxTokens: 1000 }],
        opTokens: { inputTokens: 900, outputTokens: 200 },
      }) as never,
      REQ,
      NOW,
    );
    expect(d.outcome).toBe('BLOCK');
  });

  it('does NOT count unmeasured events as zero tokens — it reports them', async () => {
    const d = await preflight(
      fakePrisma({
        limits: [
          { workspaceId: WS, kind: 'AI_GENERATION', maxRequests: null, maxTokens: 1_000_000 },
        ],
        opTokens: { inputTokens: 10 },
        unknownQuantity: 4,
      }) as never,
      REQ,
      NOW,
    );
    expect(d.operation?.unknownQuantityEvents).toBe(4);
    expect(d.operation?.measuredTokens).toBe(10);
    // Surfaced as a warning so the limit's incompleteness is visible.
    expect(d.warnings.some((w) => w.message.includes('no token count'))).toBe(true);
  });

  it('takes the stricter of workspace and organization per-kind limits', async () => {
    const d = await preflight(
      fakePrisma({
        limits: [
          { workspaceId: WS, kind: 'AI_GENERATION', maxRequests: 100, maxTokens: null },
          { workspaceId: null, kind: 'AI_GENERATION', maxRequests: 5, maxTokens: null },
        ],
        opRequests: 0,
      }) as never,
      REQ,
      NOW,
    );
    expect(d.operation?.maxRequests).toBe(5);
  });
});

describe('assertPreflight', () => {
  it('throws BudgetBlockedError carrying the decision', async () => {
    const prisma = fakePrisma({
      wsBudget: { enforcement: 'ENFORCE', monthlyLimitMicros: 1, warnAtPercent: 80 },
      wsSpend: 500,
    });
    await expect(assertPreflight(prisma as never, REQ, NOW)).rejects.toThrow(BudgetBlockedError);
  });
});
