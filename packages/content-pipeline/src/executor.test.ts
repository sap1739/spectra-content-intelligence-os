import type { TextGenerationProvider } from '@spectra/ai-core';
import { describe, expect, it, vi } from 'vitest';

import { executeContentDraft } from './executor';

function stubProvider(text: string, finishReason: 'stop' | 'content_filter' = 'stop') {
  const provider: TextGenerationProvider = {
    id: 'stub',
    displayName: 'Stub',
    modelRef: { provider: 'stub', model: 'stub-1', version: '1' },
    generateText: vi.fn(async () => ({
      text,
      modelRef: { provider: 'stub', model: 'stub-1', version: '1' },
      finishReason,
      usage: { inputTokens: 5, outputTokens: 7 },
    })),
  };
  return provider;
}

function fakePrisma(overrides: { draftStatus?: string } = {}) {
  const draftRow = {
    id: 'd1',
    status: overrides.draftStatus ?? 'GENERATING',
    organizationId: 'o1',
    workspaceId: 'w1',
    contentItem: {
      id: 'ci1',
      evidencePackId: 'p1',
      contentType: 'POST',
      title: 'AI testing',
      objective: null,
      funnelStage: null,
    },
  };
  const draftUpdates: Array<{ data: Record<string, unknown> }> = [];
  const itemUpdates: Array<{ data: Record<string, unknown> }> = [];
  const packUpdates: Array<{ data: Record<string, unknown> }> = [];

  const prisma = {
    contentDraft: {
      findUnique: vi.fn(async () => draftRow),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        draftUpdates.push(args);
        return { ...draftRow, ...args.data };
      }),
    },
    evidencePack: {
      findFirst: vi.fn(async () => ({
        id: 'p1',
        organizationId: 'o1',
        workspaceId: 'w1',
        title: 'AI testing',
        summary: 'Summary.',
        findingIds: ['f1'],
        citationIds: ['c1'],
      })),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => packUpdates.push(args)),
    },
    researchFinding: {
      findMany: vi.fn(async () => [
        {
          id: 'f1',
          summary: 'Adoption grew.',
          excerpt: 'excerpt',
          source: { url: 'https://x/1', title: 'x', publisher: null },
        },
      ]),
    },
    citation: {
      findMany: vi.fn(async () => [
        {
          id: 'c1',
          excerpt: 'Adoption grew 40%',
          url: 'https://x/1',
          title: 'x',
          publisher: null,
          findingId: 'f1',
        },
      ]),
    },
    contentItem: {
      update: vi.fn(async (args: { data: Record<string, unknown> }) => itemUpdates.push(args)),
    },
  };
  return { prisma, draftUpdates, itemUpdates, packUpdates };
}

describe('executeContentDraft', () => {
  it('generates, validates citations, and marks the draft READY + item GENERATED', async () => {
    const { prisma, draftUpdates, itemUpdates, packUpdates } = fakePrisma();
    const provider = stubProvider('Grounded claim [1]. Another [2]. Fabricated [3].');

    const outcome = await executeContentDraft(
      { prisma: prisma as never, provider },
      { draftId: 'd1' },
    );

    expect(outcome.status).toBe('READY');
    const finalDraft = draftUpdates.at(-1)!.data;
    expect(finalDraft.status).toBe('READY');
    expect(finalDraft.citationIds).toEqual(['c1']);
    expect(finalDraft.findingIds).toEqual(['f1']);
    // [1],[2] map to the 2 grounded sources; [3] is dangling.
    const validation = finalDraft.citationValidation as { unsupportedMarkers: number[] };
    expect(validation.unsupportedMarkers).toEqual([3]);

    expect(itemUpdates.at(-1)!.data.lifecycleState).toBe('GENERATED');
    expect(packUpdates).toHaveLength(1); // usedByContentItemIds push
  });

  it('records a content_filter refusal as FAILED without touching the item', async () => {
    const { prisma, itemUpdates } = fakePrisma();
    const provider = stubProvider('', 'content_filter');

    const outcome = await executeContentDraft(
      { prisma: prisma as never, provider },
      { draftId: 'd1' },
    );
    expect(outcome.status).toBe('FAILED');
    expect(itemUpdates).toHaveLength(0);
  });

  it('is idempotent — a non-GENERATING draft is skipped', async () => {
    const { prisma, draftUpdates } = fakePrisma({ draftStatus: 'READY' });
    const provider = stubProvider('should not run');

    const outcome = await executeContentDraft(
      { prisma: prisma as never, provider },
      { draftId: 'd1' },
    );
    expect(outcome.status).toBe('SKIPPED');
    expect(draftUpdates).toHaveLength(0);
    expect(provider.generateText).not.toHaveBeenCalled();
  });
});
