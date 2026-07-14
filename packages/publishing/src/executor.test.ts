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
  return { prisma, updates };
}

/** A stub live publisher — never touches the network. */
function stubResolver(outcome: Awaited<ReturnType<PostPublisher['publish']>>): ResolvePublisher {
  return async () => ({
    platform: 'WORDPRESS',
    adapterVersion: 'stub-1',
    publish: vi.fn(async () => outcome),
  });
}

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
