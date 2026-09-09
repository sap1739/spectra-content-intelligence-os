import { createHash } from 'node:crypto';

import type { EmbeddingProvider } from '@spectra/ai-core';
import { PgVectorStore, type SpectraPrismaClient } from '@spectra/database';
import { resolveEmbedding, type VectorStoreProvider } from '@spectra/knowledge-core';
import type { Logger } from '@spectra/logging';
import {
  BudgetBlockedError,
  reconcile,
  release,
  reserve,
  type UsageRecorder,
} from '@spectra/metering';

/**
 * Re-embeds a workspace's stored chunks into the ACTIVE embedding collection.
 *
 * Why this exists: a collection holds one model's vectors. Switching on a
 * semantic provider therefore points search at a NEW, EMPTY collection — every
 * previously ingested finding would silently disappear from results. That is
 * exactly the kind of quiet wrongness this codebase refuses; the backfill makes
 * the switch complete instead of destructive.
 *
 * Source rows are read from whichever collection already holds them and their
 * stored `text` is re-embedded; the original collection is left intact, so a
 * rollback (unset the key) restores the previous behaviour immediately.
 */

export interface ReembedDeps {
  prisma: SpectraPrismaClient;
  /** The semantic provider; unconfigured/absent resolves to lexical. */
  embedder?: EmbeddingProvider;
  vectorStore?: VectorStoreProvider;
  logger?: Logger;
  /** Records real provider spend; omitted means no ledger. */
  usage?: UsageRecorder;
}

export interface ReembedInput {
  organizationId: string;
  workspaceId: string;
  /** Rows per batch (also the embed batch). */
  batchSize?: number;
}

export interface ReembedOutcome {
  collection: string;
  semantic: boolean;
  /** Chunks that already existed in the target collection before this run. */
  alreadyPresent: number;
  reembedded: number;
  failed: number;
  /** True when a budget stopped the backfill part-way (ADR-0028). */
  budgetStopped?: boolean;
  /** Chunks completed before the budget stopped it. */
  budgetStoppedAfter?: number;
  /** Chunks still not in the target collection when it stopped. */
  remaining?: number;
}

interface SourceRow {
  id: string;
  documentId: string;
  text: string;
  metadata: unknown;
  index: number;
}

export async function executeReembed(
  deps: ReembedDeps,
  input: ReembedInput,
): Promise<ReembedOutcome> {
  const { prisma } = deps;
  const embedding = resolveEmbedding(deps.embedder);
  const store = deps.vectorStore ?? new PgVectorStore(prisma);
  const batchSize = Math.min(Math.max(input.batchSize ?? 64, 1), 256);
  const tenant = { organizationId: input.organizationId, workspaceId: input.workspaceId };
  const logger = deps.logger?.child({ collection: embedding.collection });

  const alreadyPresent = await prisma.documentChunk.count({
    where: { ...tenant, collection: embedding.collection },
  });

  // Source rows: everything for this tenant that is NOT already in the target
  // collection. Re-running is safe — completed chunks drop out of this set.
  const rows = await prisma.$queryRaw<SourceRow[]>`
    SELECT DISTINCT ON ("documentId", "index")
      "id", "documentId", "text", "metadata", "index"
    FROM "document_chunks"
    WHERE "organizationId" = ${input.organizationId}::uuid
      AND "workspaceId" = ${input.workspaceId}::uuid
      AND "collection" <> ${embedding.collection}
      AND NOT EXISTS (
        SELECT 1 FROM "document_chunks" t
        WHERE t."organizationId" = "document_chunks"."organizationId"
          AND t."workspaceId" = "document_chunks"."workspaceId"
          AND t."collection" = ${embedding.collection}
          AND t."documentId" = "document_chunks"."documentId"
          AND t."index" = "document_chunks"."index"
      )
    ORDER BY "documentId", "index"
  `;

  let reembedded = 0;
  let failed = 0;
  let budgetStoppedAfter: number | null = null;
  // Stable across retries of the same backfill, so a re-delivered job re-uses
  // its own per-batch holds rather than stacking new ones.
  const reservationPrefix = `knowledge-reembed-${tenant.workspaceId}-${embedding.collection}`;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);

    // Reserve EVERY batch, not just once at the start. A corpus backfill runs
    // for a long time and spends continuously; a single entry check would let
    // it blow through a ceiling it crossed mid-run, and a non-atomic check
    // would let a concurrent operation take the same allowance (ADR-0029).
    const batchKey = `${reservationPrefix}-batch-${i}`;
    let decision;
    try {
      ({ decision } = await reserve(deps.prisma, {
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId,
        kind: 'AI_EMBEDDING',
        provider: embedding.provider.modelRef.provider,
        model: embedding.provider.modelRef.model,
        requests: batch.length,
        idempotencyKey: batchKey,
        resourceType: 'KNOWLEDGE_REEMBED',
        ttlMs: 10 * 60_000,
      }));
    } catch (error) {
      if (!(error instanceof BudgetBlockedError)) throw error;
      decision = error.decision;
    }
    if (decision.blocked) {
      // Stop honestly and say how far we got — the collection is partially
      // backfilled, which the status endpoint already surfaces.
      budgetStoppedAfter = reembedded;
      logger?.warn(
        { reembedded, remaining: rows.length - i, reason: decision.reason },
        'Re-embed stopped by budget',
      );
      break;
    }
    let vectors: number[][];
    try {
      // Stored passages embed as 'document' — matching how search queries them.
      const result = await embedding.provider.embed(
        batch.map((r) => r.text),
        tenant,
        'document',
      );
      vectors = result.vectors;
      // Real token usage is metered below; the batch hold has done its job.
      await reconcile(deps.prisma, tenant, batchKey, logger);
      if (result.usage && deps.usage) {
        await deps.usage.record(tenant, {
          kind: 'AI_EMBEDDING',
          provider: embedding.provider.modelRef.provider,
          model: embedding.provider.modelRef.model,
          totalTokens: result.usage.totalTokens,
          resourceType: 'REEMBED',
        });
      }
    } catch (error) {
      failed += batch.length;
      // Failed before the provider returned: nothing was spent, so return the
      // allowance instead of holding it until expiry.
      await release(deps.prisma, tenant, batchKey, logger);
      logger?.warn(
        { err: error instanceof Error ? error.message : String(error), batch: batch.length },
        'Re-embed batch failed',
      );
      continue;
    }

    await store.upsertChunks({
      tenant,
      collection: embedding.collection,
      chunks: batch.map((row, idx) => ({
        chunk: {
          // Deterministic new id per (target collection, source chunk) so a
          // re-run overwrites rather than duplicating.
          id: deriveChunkId(row.id, embedding.collection),
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          documentId: row.documentId,
          index: row.index,
          text: row.text,
          headingPath: [],
          metadata: (row.metadata ?? {}) as Record<string, unknown>,
          embedding: {
            provider: embedding.provider.modelRef.provider,
            model: embedding.provider.modelRef.model,
            dimensions: embedding.provider.dimensions,
          },
        } as never,
        vector: vectors[idx] as number[],
      })),
    });
    reembedded += batch.length;
  }

  logger?.info({ reembedded, failed, alreadyPresent }, 'Re-embed complete');
  return {
    collection: embedding.collection,
    semantic: embedding.semantic,
    alreadyPresent,
    reembedded,
    failed,
    ...(budgetStoppedAfter !== null
      ? {
          budgetStopped: true,
          budgetStoppedAfter,
          remaining: rows.length - budgetStoppedAfter,
        }
      : {}),
  };
}

/**
 * UUIDv5-style derivation is overkill here; a stable hash of
 * (sourceId, collection) rendered as a UUID keeps re-runs idempotent.
 */
function deriveChunkId(sourceId: string, collection: string): string {
  const hex = sha1Hex(`${sourceId}:${collection}`);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0') +
      hex.slice(18, 20),
    hex.slice(20, 32),
  ].join('-');
}

function sha1Hex(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}
