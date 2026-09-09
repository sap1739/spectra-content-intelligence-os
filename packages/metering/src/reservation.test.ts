import { describe, expect, it, vi } from 'vitest';

import { BudgetBlockedError } from './preflight';
import { reconcile, release, reserve, withReservation } from './reservation';

const NOW = new Date('2026-09-09T12:00:00.000Z');
const BASE = {
  organizationId: 'org-1',
  workspaceId: 'ws-1',
  kind: 'AI_GENERATION' as const,
  provider: 'anthropic',
  model: 'claude-opus-4-8',
  estimatedInputTokens: 1000,
};

/**
 * An in-memory stand-in that behaves like the real tables for the one property
 * under test: an ACTIVE reservation is visible to the NEXT pre-flight.
 */
function fakeDb(opts: { limitMicros?: number | null; spend?: number } = {}) {
  const reservations: Array<{
    id: string;
    workspaceId: string;
    kind: string;
    estimatedCostMicros: number;
    requests: number;
    status: string;
    idempotencyKey: string;
    expiresAt: Date;
  }> = [];
  let seq = 0;

  const prisma = {
    workspaceBudget: {
      findFirst: vi.fn(async () =>
        opts.limitMicros === undefined
          ? null
          : { enforcement: 'ENFORCE', monthlyLimitMicros: opts.limitMicros, warnAtPercent: 80 },
      ),
    },
    organizationBudget: { findFirst: vi.fn(async () => null) },
    budgetOperationLimit: { findMany: vi.fn(async () => []) },
    budgetReservation: {
      findMany: vi.fn(async () =>
        reservations.filter((r) => r.status === 'ACTIVE' && r.expiresAt > NOW),
      ),
      findUnique: vi.fn(
        async (args: { where: { idempotencyKey: string } }) =>
          reservations.find((r) => r.idempotencyKey === args.where.idempotencyKey) ?? null,
      ),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        seq += 1;
        const row = {
          id: `r${seq}`,
          status: 'ACTIVE',
          ...(args.data as Record<string, unknown>),
        } as never;
        reservations.push(row);
        return row;
      }),
      updateMany: vi.fn(
        async (args: { where: { idempotencyKey: string }; data: { status: string } }) => {
          for (const r of reservations) {
            if (r.idempotencyKey === args.where.idempotencyKey && r.status === 'ACTIVE') {
              r.status = args.data.status;
            }
          }
          return { count: 1 };
        },
      ),
    },
    usageEvent: {
      aggregate: vi.fn(async () => ({
        _sum: {
          estimatedCostMicros: opts.spend ?? 0,
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        },
      })),
      count: vi.fn(async () => 0),
    },
  };
  return { prisma, reservations };
}

describe('budget reservations', () => {
  it('holds estimated cost so a SECOND pre-flight sees it as committed', async () => {
    // Ceiling leaves room for exactly one 5,000-micro operation.
    const { prisma } = fakeDb({ limitMicros: 6_000, spend: 0 });

    const first = await reserve(prisma as never, { ...BASE, idempotencyKey: 'op-1' }, NOW);
    expect(first.id).toBeTruthy();

    // Without reservations both would pass against the same allowance.
    await expect(
      reserve(prisma as never, { ...BASE, idempotencyKey: 'op-2' }, NOW),
    ).rejects.toThrow(BudgetBlockedError);
  });

  it('a retry with the same idempotency key does NOT double-reserve', async () => {
    const { prisma, reservations } = fakeDb({ limitMicros: 100_000_000 });
    await reserve(prisma as never, { ...BASE, idempotencyKey: 'same-op' }, NOW);
    await reserve(prisma as never, { ...BASE, idempotencyKey: 'same-op' }, NOW);
    expect(reservations).toHaveLength(1);
  });

  it('reconcile stops the hold counting once real usage is in the ledger', async () => {
    const { prisma, reservations } = fakeDb({ limitMicros: 100_000_000 });
    await reserve(prisma as never, { ...BASE, idempotencyKey: 'op-x' }, NOW);
    await reconcile(prisma as never, 'op-x');
    expect(reservations[0]?.status).toBe('RECONCILED');
  });

  it('release returns the allowance when work never ran', async () => {
    const { prisma, reservations } = fakeDb({ limitMicros: 100_000_000 });
    await reserve(prisma as never, { ...BASE, idempotencyKey: 'op-y' }, NOW);
    await release(prisma as never, 'op-y');
    expect(reservations[0]?.status).toBe('RELEASED');
  });

  it('withReservation releases the hold when the work throws', async () => {
    const { prisma, reservations } = fakeDb({ limitMicros: 100_000_000 });
    await expect(
      withReservation(prisma as never, { ...BASE, idempotencyKey: 'op-z' }, async () => {
        throw new Error('generation failed');
      }),
    ).rejects.toThrow('generation failed');
    // A failed job must not permanently consume an allowance.
    expect(reservations[0]?.status).toBe('RELEASED');
  });

  it('withReservation reconciles on success', async () => {
    const { prisma, reservations } = fakeDb({ limitMicros: 100_000_000 });
    const out = await withReservation(
      prisma as never,
      { ...BASE, idempotencyKey: 'op-ok' },
      async () => 'done',
    );
    expect(out).toBe('done');
    expect(reservations[0]?.status).toBe('RECONCILED');
  });

  it('an unpriceable operation still reserves its request count', async () => {
    const { prisma, reservations } = fakeDb({ limitMicros: 100_000_000 });
    await reserve(
      prisma as never,
      {
        organizationId: 'org-1',
        workspaceId: 'ws-1',
        kind: 'PUBLISH_ATTEMPT',
        provider: 'wordpress',
        idempotencyKey: 'pub-1',
      },
      NOW,
    );
    // Zero cost held (we cannot price it) but the operation is still counted.
    expect(reservations[0]?.estimatedCostMicros).toBe(0);
    expect(reservations[0]?.requests).toBe(1);
  });
});
