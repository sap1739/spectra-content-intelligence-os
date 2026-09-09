import type { PostPublisher } from '@spectra/social-core';
import { describe, expect, it, vi } from 'vitest';

import { executePublication, type ResolvePublisher } from './executor';

function fakePrisma(entry: { status: string; platform?: string }) {
  const updates: Array<{ data: Record<string, unknown> }> = [];
  const row = {
    id: 'e1',
    status: entry.status,
    platform: entry.platform ?? 'WORDPRESS',
    organizationId: 'o1',
    workspaceId: 'w1',
    contentItemId: 'ci1',
    socialAccountId: 'acct1',
    idempotencyKey: 'idem-1',
    note: 'hello',
  };
  const prisma = {
    // Publishing now passes through budget pre-flight (ADR-0028). Nothing
    // configured => UNKNOWN_COST_ALLOW_WITH_NOTICE, never blocked.
    workspaceBudget: { findFirst: vi.fn(async () => null) },
    organizationBudget: { findFirst: vi.fn(async () => null) },
    budgetOperationLimit: { findMany: vi.fn(async () => []) },
    budgetReservation: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: 'res-1' })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    usageEvent: {
      aggregate: vi.fn(async () => ({
        _sum: {
          estimatedCostMicros: null,
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        },
      })),
      count: vi.fn(async () => 0),
      create: vi.fn(async () => ({})),
    },
    contentScheduleEntry: {
      findUnique: vi.fn(async () => row),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        updates.push(args);
        return { ...row, ...args.data };
      }),
    },
    socialAccount: {
      findUnique: vi.fn(async () => ({
        id: 'acct1',
        platform: row.platform,
        externalAccountId: 'https://blog.example.com',
        encryptedToken: 'sealed',
      })),
    },
    contentItem: {
      findUnique: vi.fn(async () => ({ title: 'Hello', body: '<p>World</p>' })),
      update: vi.fn(async () => ({})),
    },
  };
  // Publishing reserves atomically (ADR-0029): the fake must model the
  // transaction boundary the executor now relies on.
  const withTx = {
    ...prisma,
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ ...prisma, $executeRaw: vi.fn(async () => 0) }),
    ),
  };
  return { prisma: withTx, updates };
}

/** A stub live publisher — never touches the network. */
function stubResolver(outcome: Awaited<ReturnType<PostPublisher['publish']>>): ResolvePublisher {
  return async () => ({
    platform: 'WORDPRESS',
    adapterVersion: 'stub-1',
    publish: vi.fn(async () => outcome),
  });
}

describe('executePublication — budget pre-flight (ADR-0028)', () => {
  it('passes through pre-flight and publishes when nothing limits it', async () => {
    const { prisma } = fakePrisma({ status: 'QUEUED' });
    const outcome = await executePublication(
      {
        prisma: prisma as never,
        resolvePublisher: stubResolver({ status: 'PUBLISHED', externalPostId: 'p1' }),
      },
      { entryId: 'e1' },
    );
    // Publishing is unpriced, so pre-flight allows with notice rather than
    // blocking — it must not be treated as zero-cost-therefore-unlimited.
    expect(outcome.status).toBe('PUBLISHED');
    expect(prisma.workspaceBudget.findFirst).toHaveBeenCalled();
  });

  it('is BLOCKED by a per-kind PUBLISH_ATTEMPT limit even though it is unpriced', async () => {
    const { prisma, updates } = fakePrisma({ status: 'QUEUED' });
    prisma.budgetOperationLimit.findMany = vi.fn(async () => [
      { workspaceId: 'w1', kind: 'PUBLISH_ATTEMPT', maxRequests: 2, maxTokens: null },
    ]) as never;
    prisma.usageEvent.aggregate = vi.fn(async () => ({
      _sum: {
        estimatedCostMicros: null,
        requests: 2,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
    })) as never;

    const publish = vi.fn(async () => ({ status: 'PUBLISHED' as const }));
    const outcome = await executePublication(
      {
        prisma: prisma as never,
        resolvePublisher: async () => ({ platform: 'WORDPRESS', adapterVersion: 's', publish }),
      },
      { entryId: 'e1' },
    );

    expect(outcome.status).toBe('FAILED');
    // Never reached the platform.
    expect(publish).not.toHaveBeenCalled();
    expect(String(updates.at(-1)!.data.failureReason)).toMatch(/PUBLISH_ATTEMPT/);
  });

  it('an unsupported platform still resolves UNSUPPORTED, not blocked or published', async () => {
    const { prisma, updates } = fakePrisma({ status: 'QUEUED' });
    const outcome = await executePublication({ prisma: prisma as never }, { entryId: 'e1' });
    expect(outcome.status).toBe('UNSUPPORTED');
    expect(String(updates.at(-1)!.data.failureReason)).toMatch(/No live publisher/);
  });
});

describe('executePublication', () => {
  it('resolves to UNSUPPORTED (never fabricated) when no publisher can be resolved', async () => {
    const { prisma, updates } = fakePrisma({ status: 'QUEUED' });
    // No resolvePublisher supplied — nothing is wired.
    const outcome = await executePublication({ prisma: prisma as never }, { entryId: 'e1' });
    expect(outcome.status).toBe('UNSUPPORTED');
    // First update flips to PUBLISHING + increments attempts; final is UNSUPPORTED.
    expect(updates.at(-1)!.data.status).toBe('UNSUPPORTED');
    expect(String(updates.at(-1)!.data.failureReason)).toContain('No live publisher');
  });

  it('is idempotent — an entry not QUEUED/PUBLISHING is skipped', async () => {
    const { prisma, updates } = fakePrisma({ status: 'PUBLISHED' });
    const outcome = await executePublication({ prisma: prisma as never }, { entryId: 'e1' });
    expect(outcome.status).toBe('SKIPPED');
    expect(updates).toHaveLength(0);
  });

  it('publishes the item body when a live publisher is resolved', async () => {
    const { prisma, updates } = fakePrisma({ status: 'QUEUED' });
    const resolvePublisher = stubResolver({
      status: 'PUBLISHED',
      externalPostId: 'wp-42',
      externalUrl: 'https://blog.example.com/?p=42',
      publishedAt: '2026-07-14T00:00:00.000Z',
    });

    const outcome = await executePublication(
      { prisma: prisma as never, resolvePublisher },
      { entryId: 'e1' },
    );
    expect(outcome.status).toBe('PUBLISHED');
    expect(updates.at(-1)!.data.externalPostId).toBe('wp-42');
    expect(prisma.contentItem.update).toHaveBeenCalled();
  });

  it('records a truthful FAILED when the publisher reports failure', async () => {
    const { prisma, updates } = fakePrisma({ status: 'QUEUED' });
    const resolvePublisher = stubResolver({
      status: 'FAILED',
      failureReason: 'WordPress responded 401 Unauthorized',
    });

    const outcome = await executePublication(
      { prisma: prisma as never, resolvePublisher },
      { entryId: 'e1' },
    );
    expect(outcome.status).toBe('FAILED');
    expect(updates.at(-1)!.data.status).toBe('FAILED');
    expect(String(updates.at(-1)!.data.failureReason)).toContain('401');
    expect(prisma.contentItem.update).not.toHaveBeenCalled();
  });
});
