import { randomUUID } from 'node:crypto';

import { createPrismaClient, type SpectraPrismaClient } from '@spectra/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { BudgetBlockedError, reserve } from '../src/index';

/**
 * Concurrency regression test for ADR-0029, against REAL PostgreSQL.
 *
 * The unit tests use a fake `$transaction` and therefore cannot prove the thing
 * that actually matters: that the advisory lock serializes concurrent
 * decide-and-hold sequences. This spec fires genuinely parallel reservations at
 * a live database and asserts only one can win the last allowance.
 */

process.env['DATABASE_URL'] ??=
  'postgresql://spectra:spectra_local_dev@localhost:5432/spectra?schema=public';

/** anthropic:claude-opus-4-8 at 1000 input tokens => 5,000 micros. */
const OP_COST_MICROS = 5_000;
const OP = {
  kind: 'AI_GENERATION' as const,
  provider: 'anthropic',
  model: 'claude-opus-4-8',
  estimatedInputTokens: 1000,
};

describe('budget reservation concurrency (integration)', () => {
  let prisma: SpectraPrismaClient;
  const organizationId = randomUUID();
  const workspaceId = randomUUID();
  const otherOrgId = randomUUID();
  const otherWorkspaceId = randomUUID();

  beforeAll(async () => {
    prisma = createPrismaClient({ datasourceUrl: process.env['DATABASE_URL'] as string });
    await prisma.organization.create({
      data: { id: organizationId, name: 'Conc Org', slug: `conc-${Date.now()}`, status: 'ACTIVE' },
    });
    await prisma.workspace.create({
      data: { id: workspaceId, organizationId, name: 'Conc WS', slug: 'conc-ws', status: 'ACTIVE' },
    });
    await prisma.organization.create({
      data: {
        id: otherOrgId,
        name: 'Other Org',
        slug: `conc-other-${Date.now()}`,
        status: 'ACTIVE',
      },
    });
    await prisma.workspace.create({
      data: {
        id: otherWorkspaceId,
        organizationId: otherOrgId,
        name: 'Other WS',
        slug: 'conc-other-ws',
        status: 'ACTIVE',
      },
    });
  }, 30_000);

  afterAll(async () => {
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
    await prisma.organization.delete({ where: { id: otherOrgId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    for (const org of [organizationId, otherOrgId]) {
      await prisma.budgetReservation.deleteMany({ where: { organizationId: org } });
      await prisma.usageEvent.deleteMany({ where: { organizationId: org } });
      await prisma.workspaceBudget.deleteMany({ where: { organizationId: org } });
      await prisma.organizationBudget.deleteMany({ where: { organizationId: org } });
      await prisma.budgetOperationLimit.deleteMany({ where: { organizationId: org } });
    }
  });

  async function setWorkspaceCeiling(limitMicros: number, org = organizationId, ws = workspaceId) {
    await prisma.workspaceBudget.create({
      data: {
        organizationId: org,
        workspaceId: ws,
        monthlyLimitMicros: limitMicros,
        enforcement: 'ENFORCE',
      },
    });
  }

  /** Fires N reserves in parallel and reports how many won. */
  async function race(n: number, org = organizationId, ws = workspaceId) {
    const results = await Promise.allSettled(
      Array.from({ length: n }, (_, i) =>
        reserve(prisma, {
          organizationId: org,
          workspaceId: ws,
          ...OP,
          idempotencyKey: `race-${randomUUID()}-${i}`,
        }),
      ),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    return { fulfilled, rejected, results };
  }

  it('lets exactly ONE of 10 concurrent operations take the last allowance', async () => {
    // Room for exactly one operation: a second would reach the ceiling.
    await setWorkspaceCeiling(OP_COST_MICROS + 1);

    const { fulfilled, rejected } = await race(10);

    // The whole point of ADR-0029. Before it, several would pass.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(9);

    // Losers are told the truth, not failed with an internal error.
    for (const r of rejected) {
      const reason = (r as PromiseRejectedResult).reason as unknown;
      expect(reason).toBeInstanceOf(BudgetBlockedError);
      expect((reason as BudgetBlockedError).decision.outcome).toBe('BLOCK');
      expect((reason as BudgetBlockedError).decision.exceededReason).toBe('WORKSPACE_COST_CEILING');
    }

    // And exactly one hold exists — no partial or orphaned rows.
    const rows = await prisma.budgetReservation.findMany({ where: { organizationId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('ACTIVE');
  }, 30_000);

  it('lets exactly THREE through when there is room for three', async () => {
    await setWorkspaceCeiling(OP_COST_MICROS * 3 + 1);
    const { fulfilled } = await race(10);
    expect(fulfilled).toHaveLength(3);

    const rows = await prisma.budgetReservation.findMany({ where: { organizationId } });
    expect(rows).toHaveLength(3);
  }, 30_000);

  it('does not leak across tenants — another org races its own allowance', async () => {
    await setWorkspaceCeiling(OP_COST_MICROS + 1);
    await setWorkspaceCeiling(OP_COST_MICROS + 1, otherOrgId, otherWorkspaceId);

    const [mine, theirs] = await Promise.all([race(5), race(5, otherOrgId, otherWorkspaceId)]);

    // Each organization gets its own single allowance; neither consumes the other's.
    expect(mine.fulfilled).toHaveLength(1);
    expect(theirs.fulfilled).toHaveLength(1);

    const mineRows = await prisma.budgetReservation.findMany({ where: { organizationId } });
    const theirRows = await prisma.budgetReservation.findMany({
      where: { organizationId: otherOrgId },
    });
    expect(mineRows).toHaveLength(1);
    expect(theirRows).toHaveLength(1);
    expect(mineRows[0]?.workspaceId).toBe(workspaceId);
    expect(theirRows[0]?.workspaceId).toBe(otherWorkspaceId);
  }, 30_000);

  it('concurrent retries of the SAME idempotency key create exactly one hold', async () => {
    await setWorkspaceCeiling(OP_COST_MICROS * 5);
    const key = `retry-${randomUUID()}`;
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        reserve(prisma, { organizationId, workspaceId, ...OP, idempotencyKey: key }),
      ),
    );
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    const rows = await prisma.budgetReservation.findMany({
      where: { organizationId, idempotencyKey: key },
    });
    // A retry storm must not consume the allowance eight times over.
    expect(rows).toHaveLength(1);
  }, 30_000);

  it('an ORGANIZATION ceiling bounds concurrent work across two workspaces', async () => {
    const secondWorkspaceId = randomUUID();
    await prisma.workspace.create({
      data: {
        id: secondWorkspaceId,
        organizationId,
        name: 'Second WS',
        slug: `conc-ws2-${Date.now()}`,
        status: 'ACTIVE',
      },
    });
    // No workspace ceilings; only an org-wide one with room for a single op.
    await prisma.organizationBudget.create({
      data: {
        organizationId,
        monthlyLimitMicros: OP_COST_MICROS + 1,
        enforcement: 'ENFORCE',
      },
    });

    const results = await Promise.allSettled([
      ...Array.from({ length: 4 }, (_, i) =>
        reserve(prisma, {
          organizationId,
          workspaceId,
          ...OP,
          idempotencyKey: `org-a-${randomUUID()}-${i}`,
        }),
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        reserve(prisma, {
          organizationId,
          workspaceId: secondWorkspaceId,
          ...OP,
          idempotencyKey: `org-b-${randomUUID()}-${i}`,
        }),
      ),
    ]);

    // The org lock covers both workspaces, so the aggregate ceiling holds.
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const blocked = results.filter((r) => r.status === 'rejected');
    expect(
      blocked.every(
        (r) =>
          ((r as PromiseRejectedResult).reason as BudgetBlockedError).decision.exceededReason ===
          'ORGANIZATION_COST_CEILING',
      ),
    ).toBe(true);

    await prisma.workspace.delete({ where: { id: secondWorkspaceId } }).catch(() => undefined);
  }, 30_000);

  it('a per-kind request limit bounds concurrent unpriced operations', async () => {
    // No cost ceiling at all: the only bound is the operation limit, which is
    // the case that matters for work we cannot price.
    await prisma.budgetOperationLimit.create({
      data: { organizationId, workspaceId, kind: 'PUBLISH_ATTEMPT', maxRequests: 2 },
    });

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        reserve(prisma, {
          organizationId,
          workspaceId,
          kind: 'PUBLISH_ATTEMPT',
          provider: 'wordpress',
          idempotencyKey: `pub-${randomUUID()}-${i}`,
        }),
      ),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    const rows = await prisma.budgetReservation.findMany({
      where: { organizationId, kind: 'PUBLISH_ATTEMPT' },
    });
    expect(rows).toHaveLength(2);
  }, 30_000);

  it('blocked attempts leave no reservation rows behind at all', async () => {
    await setWorkspaceCeiling(1); // nothing fits
    const { fulfilled, rejected } = await race(5);
    expect(fulfilled).toHaveLength(0);
    expect(rejected).toHaveLength(5);
    const rows = await prisma.budgetReservation.findMany({ where: { organizationId } });
    expect(rows).toHaveLength(0);
  }, 30_000);
});
