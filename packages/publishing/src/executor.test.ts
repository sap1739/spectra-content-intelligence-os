import { SocialPublisherRegistry } from '@spectra/social-core';
import { describe, expect, it, vi } from 'vitest';

import { executePublication } from './executor';

function fakePrisma(entry: { status: string; platform?: string }) {
  const updates: Array<{ data: Record<string, unknown> }> = [];
  const row = {
    id: 'e1',
    status: entry.status,
    platform: entry.platform ?? 'X',
    organizationId: 'o1',
    workspaceId: 'w1',
    contentItemId: 'ci1',
    socialAccountId: 'acct1',
    idempotencyKey: 'idem-1',
    note: 'hello',
  };
  const prisma = {
    contentScheduleEntry: {
      findUnique: vi.fn(async () => row),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        updates.push(args);
        return { ...row, ...args.data };
      }),
    },
    contentItem: { update: vi.fn(async () => ({})) },
  };
  return { prisma, updates };
}

describe('executePublication', () => {
  it('resolves to UNSUPPORTED (never fabricated) when no publisher is wired', async () => {
    const { prisma, updates } = fakePrisma({ status: 'QUEUED' });
    const outcome = await executePublication(
      { prisma: prisma as never, registry: new SocialPublisherRegistry() },
      { entryId: 'e1' },
    );
    expect(outcome.status).toBe('UNSUPPORTED');
    // First update flips to PUBLISHING + increments attempts; final is UNSUPPORTED.
    expect(updates.at(-1)!.data.status).toBe('UNSUPPORTED');
    expect(String(updates.at(-1)!.data.failureReason)).toContain('No live publisher');
  });

  it('is idempotent — an entry not QUEUED/PUBLISHING is skipped', async () => {
    const { prisma, updates } = fakePrisma({ status: 'PUBLISHED' });
    const outcome = await executePublication(
      { prisma: prisma as never, registry: new SocialPublisherRegistry() },
      { entryId: 'e1' },
    );
    expect(outcome.status).toBe('SKIPPED');
    expect(updates).toHaveLength(0);
  });

  it('publishes when an adapter is wired (future path)', async () => {
    const { prisma, updates } = fakePrisma({ status: 'QUEUED' });
    const registry = new SocialPublisherRegistry();
    registry.register({
      platform: 'X',
      adapterVersion: 'test-1',
      createPost: vi.fn(async () => ({
        idempotencyKey: 'idem-1',
        status: 'PUBLISHED' as const,
        externalPostId: 'x-123',
        externalUrl: 'https://x.com/p/123',
        publishedAt: '2026-07-14T00:00:00.000Z',
      })),
    } as never);

    const outcome = await executePublication(
      { prisma: prisma as never, registry },
      { entryId: 'e1' },
    );
    expect(outcome.status).toBe('PUBLISHED');
    expect(updates.at(-1)!.data.externalPostId).toBe('x-123');
    expect(prisma.contentItem.update).toHaveBeenCalled();
  });
});
