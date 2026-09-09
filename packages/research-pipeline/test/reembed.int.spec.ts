import { createPrismaClient, PgVectorStore, type SpectraPrismaClient } from '@spectra/database';
import type { EmbeddingProvider } from '@spectra/ai-core';
import type { TenantScope } from '@spectra/contracts';
import { lexicalEmbed, LEXICAL_EMBEDDING_COLLECTION } from '@spectra/knowledge-core';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { executeReembed } from '../src/reembed';

/**
 * Phase 5A: switching embedding model must not silently empty search.
 * Real Postgres + pgvector; the "semantic" provider is a deterministic stub so
 * the test makes no network call (and needs no API key).
 */

process.env['DATABASE_URL'] ??=
  'postgresql://spectra:spectra_local_dev@localhost:5432/spectra?schema=public';

const DIMS = 1024;
const SEMANTIC_COLLECTION = `stub-semantic-${DIMS}-v1`;

/** Deterministic 1024-d stub standing in for a real semantic model. */
const stubSemantic: EmbeddingProvider & { isConfigured: boolean } = {
  id: 'stub',
  displayName: 'Stub semantic embedder',
  modelRef: { provider: 'stub', model: 'semantic' },
  dimensions: DIMS,
  isConfigured: true,
  embed: async (texts: readonly string[], _t: TenantScope) => ({
    vectors: texts.map((text) => {
      const seed = lexicalEmbed(text, 256);
      // Deterministically widen 256 -> 1024 so vectors differ per text.
      return Array.from({ length: DIMS }, (_, i) => seed[i % 256] as number);
    }),
    // Stub reports usage so the metering path is exercised end-to-end.
    usage: { totalTokens: texts.length * 10 },
  }),
};

describe('executeReembed (integration)', () => {
  let prisma: SpectraPrismaClient;
  const organizationId = randomUUID();
  const workspaceId = randomUUID();
  const documentId = randomUUID();

  beforeAll(async () => {
    prisma = createPrismaClient({ datasourceUrl: process.env['DATABASE_URL'] as string });
    // document_chunks is FK-free by design, but budgets are not — create the
    // real tenant rows so a workspace budget can attach to this workspace.
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: 'Reembed IT Org',
        slug: `reembed-it-${Date.now()}`,
        status: 'ACTIVE',
      },
    });
    await prisma.workspace.create({
      data: {
        id: workspaceId,
        organizationId,
        name: 'Reembed WS',
        slug: 'reembed-ws',
        status: 'ACTIVE',
      },
    });
    const store = new PgVectorStore(prisma);
    // Seed three chunks in the LEXICAL collection, as an earlier ingest would.
    await store.upsertChunks({
      tenant: { organizationId, workspaceId },
      collection: LEXICAL_EMBEDDING_COLLECTION,
      chunks: ['alpha document', 'beta document', 'gamma document'].map((text, index) => ({
        chunk: {
          id: randomUUID(),
          organizationId,
          workspaceId,
          documentId,
          index,
          text,
          headingPath: [],
          metadata: { kind: 'RESEARCH_FINDING' },
          embedding: { provider: 'spectra-local', model: 'lexical-hash', dimensions: 256 },
        } as never,
        vector: lexicalEmbed(text, 256),
      })),
    });
  });

  afterAll(async () => {
    await prisma.$executeRaw`
      DELETE FROM "document_chunks" WHERE "organizationId" = ${organizationId}::uuid`;
    // Cascades budgets, limits, reservations and usage events.
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it('starts with an empty semantic collection — the switch would lose search', async () => {
    const before = await prisma.documentChunk.count({
      where: { organizationId, workspaceId, collection: SEMANTIC_COLLECTION },
    });
    expect(before).toBe(0);
  });

  it('backfills every chunk into the active collection', async () => {
    const outcome = await executeReembed(
      { prisma, embedder: stubSemantic },
      { organizationId, workspaceId },
    );
    expect(outcome.semantic).toBe(true);
    expect(outcome.collection).toBe(SEMANTIC_COLLECTION);
    expect(outcome.reembedded).toBe(3);
    expect(outcome.failed).toBe(0);

    const rows = await prisma.documentChunk.findMany({
      where: { organizationId, workspaceId, collection: SEMANTIC_COLLECTION },
    });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.dimensions === DIMS)).toBe(true);
  });

  it('leaves the original lexical collection intact (rollback stays possible)', async () => {
    const lexical = await prisma.documentChunk.count({
      where: { organizationId, workspaceId, collection: LEXICAL_EMBEDDING_COLLECTION },
    });
    expect(lexical).toBe(3);
  });

  it('stores mixed vector widths side by side in one table', async () => {
    const widths = await prisma.$queryRaw<Array<{ collection: string; w: number }>>`
      SELECT "collection", vector_dims("embedding") AS w
      FROM "document_chunks"
      WHERE "organizationId" = ${organizationId}::uuid
      GROUP BY "collection", vector_dims("embedding") ORDER BY w`;
    expect(widths.map((r) => Number(r.w))).toEqual([256, DIMS]);
  });

  it('is idempotent — a second run re-embeds nothing', async () => {
    const outcome = await executeReembed(
      { prisma, embedder: stubSemantic },
      { organizationId, workspaceId },
    );
    expect(outcome.reembedded).toBe(0);
    expect(outcome.alreadyPresent).toBe(3);
    const rows = await prisma.documentChunk.count({
      where: { organizationId, workspaceId, collection: SEMANTIC_COLLECTION },
    });
    expect(rows).toBe(3); // no duplicates
  });

  it('stops mid-backfill when the budget is exhausted, and says how far it got', async () => {
    // Clear the target collection so there is work to do.
    await prisma.$executeRaw`DELETE FROM "document_chunks" WHERE "organizationId" = ${organizationId}::uuid AND "collection" = ${SEMANTIC_COLLECTION}`;

    await prisma.workspaceBudget.create({
      data: {
        organizationId,
        workspaceId,
        monthlyLimitMicros: 1_000,
        enforcement: 'ENFORCE',
      },
    });
    await prisma.usageEvent.create({
      data: {
        organizationId,
        workspaceId,
        kind: 'WEB_SEARCH',
        provider: 'brave',
        model: 'web-search',
        estimatedCostMicros: 900_000,
        rateVersion: 'rates-2026-09-09',
        rateSource: 'EXACT',
      },
    });

    let embedCalls = 0;
    const countingEmbedder = {
      ...stubSemantic,
      embed: async (texts: readonly string[], t: TenantScope) => {
        embedCalls += 1;
        return stubSemantic.embed(texts, t);
      },
    };

    const outcome = await executeReembed(
      { prisma, embedder: countingEmbedder },
      { organizationId, workspaceId, batchSize: 1 },
    );

    // Refused before spending: the paid provider was never called.
    expect(embedCalls).toBe(0);
    expect(outcome.budgetStopped).toBe(true);
    expect(outcome.reembedded).toBe(0);
    // Honest about what is left undone.
    expect(outcome.remaining).toBeGreaterThan(0);

    await prisma.workspaceBudget.deleteMany({ where: { organizationId, workspaceId } });
    await prisma.usageEvent.deleteMany({ where: { organizationId, workspaceId } });
    // Restore the collection for the remaining tests.
    await executeReembed({ prisma, embedder: stubSemantic }, { organizationId, workspaceId });
  }, 30_000);

  it('semantic vectors are searchable in their own collection', async () => {
    const store = new PgVectorStore(prisma);
    const {
      vectors: [queryVector],
    } = await stubSemantic.embed(['beta document'], {
      organizationId,
      workspaceId,
    });
    const hits = await store.search({
      organizationId,
      workspaceId,
      collection: SEMANTIC_COLLECTION,
      queryVector: queryVector as number[],
      keywordWeight: 0,
      semanticWeight: 1,
      filters: {},
      topK: 3,
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.text).toBe('beta document');
  });
});
