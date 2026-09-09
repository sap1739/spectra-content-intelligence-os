import { describe, expect, it, vi } from 'vitest';

import { BudgetBlockedError } from './preflight';
import {
  expireStaleReservations,
  reconcile,
  release,
  reserve,
  withReservation,
} from './reservation';

const NOW = new Date('2026-09-09T12:00:00.000Z');
const SCOPE = { organizationId: 'org-1', workspaceId: 'ws-1' };
const BASE = {
  ...SCOPE,
  kind: 'AI_GENERATION' as const,
  provider: 'anthropic',
  model: 'claude-opus-4-8',
  estimatedInputTokens: 1000,
};

interface Row {
  id: string;
  organizationId: string;
  workspaceId: string;
  kind: string;
  estimatedCostMicros: number;
  requests: number;
  status: string;
  idempotencyKey: string;
  expiresAt: Date;
}

/**
 * In-memory stand-in modelling the properties under test: an ACTIVE reservation
 * is visible to the next pre-flight, and `$transaction` is all-or-nothing — a
 * throw inside it discards writes, exactly as PostgreSQL rolls back.
 */
function fakeDb(opts: { limitMicros?: number | null; spend?: number } = {}) {
  const reservations: Row[] = [];
  const lockCalls: unknown[] = [];
  let seq = 0;

  const delegates = (staged: Row[]) => ({
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
        [...reservations, ...staged].filter((r) => r.status === 'ACTIVE' && r.expiresAt > NOW),
      ),
      findUnique: vi.fn(
        async (args: { where: { idempotencyKey: string } }) =>
          [...reservations, ...staged].find(
            (r) => r.idempotencyKey === args.where.idempotencyKey,
          ) ?? null,
      ),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        seq += 1;
        const row = {
          id: `r${seq}`,
          status: 'ACTIVE',
          ...(args.data as Record<string, unknown>),
        } as unknown as Row;
        staged.push(row);
        return row;
      }),
      updateMany: vi.fn(
        async (args: {
          where: { idempotencyKey?: string; organizationId?: string; workspaceId?: string };
          data: { status: string };
        }) => {
          let count = 0;
          for (const r of reservations) {
            if (
              r.idempotencyKey === args.where.idempotencyKey &&
              r.organizationId === args.where.organizationId &&
              r.workspaceId === args.where.workspaceId &&
              r.status === 'ACTIVE'
            ) {
              r.status = args.data.status;
              count += 1;
            }
          }
          return { count };
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
  });

  const prisma = {
    ...delegates([]),
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      // Writes land in `staged` and are committed only if `fn` resolves.
      const staged: Row[] = [];
      const tx = {
        ...delegates(staged),
        $executeRaw: vi.fn(async (...args: unknown[]) => {
          lockCalls.push(args);
          return 0;
        }),
      };
      const result = await fn(tx);
      reservations.push(...staged);
      return result;
    }),
  };
  return { prisma, reservations, lockCalls };
}

describe('reserve — atomicity', () => {
  it('takes the decision and the hold inside ONE transaction', async () => {
    const { prisma, lockCalls } = fakeDb({ limitMicros: 100_000_000 });
    await reserve(prisma as never, { ...BASE, idempotencyKey: 'op-1' }, NOW);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // An advisory lock is taken before anything is read.
    expect(lockCalls.length).toBeGreaterThan(0);
  });

  it('holds estimated cost so a SECOND reserve sees it as committed', async () => {
    // Ceiling leaves room for exactly one 5,000-micro operation.
    const { prisma } = fakeDb({ limitMicros: 6_000, spend: 0 });
    await reserve(prisma as never, { ...BASE, idempotencyKey: 'op-1' }, NOW);
    await expect(
      reserve(prisma as never, { ...BASE, idempotencyKey: 'op-2' }, NOW),
    ).rejects.toThrow(BudgetBlockedError);
  });

  it('creates NO reservation when the decision blocks (rollback, not partial)', async () => {
    const { prisma, reservations } = fakeDb({ limitMicros: 1, spend: 500 });
    await expect(
      reserve(prisma as never, { ...BASE, idempotencyKey: 'blocked' }, NOW),
    ).rejects.toThrow(BudgetBlockedError);
    expect(reservations).toHaveLength(0);
  });

  it('a retry with the same idempotency key does NOT double-reserve', async () => {
    const { prisma, reservations } = fakeDb({ limitMicros: 100_000_000 });
    const first = await reserve(prisma as never, { ...BASE, idempotencyKey: 'same-op' }, NOW);
    const second = await reserve(prisma as never, { ...BASE, idempotencyKey: 'same-op' }, NOW);
    expect(reservations).toHaveLength(1);
    expect(second.reused).toBe(true);
    expect(second.id).toBe(first.id);
  });

  it('a retry is not blocked by its OWN hold even on a tight ceiling', async () => {
    // Room for exactly one; the retry must re-use its hold, not be refused by it.
    const { prisma } = fakeDb({ limitMicros: 6_000, spend: 0 });
    await reserve(prisma as never, { ...BASE, idempotencyKey: 'retry-me' }, NOW);
    const again = await reserve(prisma as never, { ...BASE, idempotencyKey: 'retry-me' }, NOW);
    expect(again.reused).toBe(true);
  });

  it('refuses to hand back a hold belonging to another tenant', async () => {
    const { prisma } = fakeDb({ limitMicros: 100_000_000 });
    await reserve(prisma as never, { ...BASE, idempotencyKey: 'shared-key' }, NOW);
    await expect(
      reserve(
        prisma as never,
        { ...BASE, organizationId: 'org-2', workspaceId: 'ws-2', idempotencyKey: 'shared-key' },
        NOW,
      ),
    ).rejects.toThrow(/different tenant/);
  });
});

describe('settlement', () => {
  it('reconcile stops the hold counting once real usage is in the ledger', async () => {
    const { prisma, reservations } = fakeDb({ limitMicros: 100_000_000 });
    await reserve(prisma as never, { ...BASE, idempotencyKey: 'op-x' }, NOW);
    await reconcile(prisma as never, SCOPE, 'op-x');
    expect(reservations[0]?.status).toBe('RECONCILED');
  });

  it('release returns the allowance when work never ran', async () => {
    const { prisma, reservations } = fakeDb({ limitMicros: 100_000_000 });
    await reserve(prisma as never, { ...BASE, idempotencyKey: 'op-y' }, NOW);
    await release(prisma as never, SCOPE, 'op-y');
    expect(reservations[0]?.status).toBe('RELEASED');
  });

  it('settlement is tenant-scoped — a foreign scope cannot settle the hold', async () => {
    const { prisma, reservations } = fakeDb({ limitMicros: 100_000_000 });
    await reserve(prisma as never, { ...BASE, idempotencyKey: 'op-t' }, NOW);
    await release(prisma as never, { organizationId: 'org-2', workspaceId: 'ws-2' }, 'op-t');
    expect(reservations[0]?.status).toBe('ACTIVE');
  });

  it('withReservation releases when the work fails before spending', async () => {
    const { prisma, reservations } = fakeDb({ limitMicros: 100_000_000 });
    await expect(
      withReservation(prisma as never, { ...BASE, idempotencyKey: 'op-z' }, async () => {
        throw new Error('failed before provider call');
      }),
    ).rejects.toThrow('failed before provider call');
    expect(reservations[0]?.status).toBe('RELEASED');
  });

  it('withReservation reconciles when the work failed AFTER spending', async () => {
    const { prisma, reservations } = fakeDb({ limitMicros: 100_000_000 });
    await expect(
      withReservation(
        prisma as never,
        { ...BASE, idempotencyKey: 'op-spent' },
        async () => {
          throw new Error('provider returned then we crashed');
        },
        { failedBeforeSpend: () => false },
      ),
    ).rejects.toThrow();
    // Something was spent; the ledger has it, so the hold reconciles.
    expect(reservations[0]?.status).toBe('RECONCILED');
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
      { ...SCOPE, kind: 'PUBLISH_ATTEMPT', provider: 'wordpress', idempotencyKey: 'pub-1' },
      NOW,
    );
    expect(reservations[0]?.estimatedCostMicros).toBe(0);
    expect(reservations[0]?.requests).toBe(1);
  });
});

describe('expireStaleReservations', () => {
  it('sweeps expired holds via a raw, cross-tenant statement', async () => {
    const executeRaw = vi.fn(async () => 3);
    const count = await expireStaleReservations({ $executeRaw: executeRaw } as never, NOW);
    expect(count).toBe(3);
    expect(executeRaw).toHaveBeenCalled();
  });
});
