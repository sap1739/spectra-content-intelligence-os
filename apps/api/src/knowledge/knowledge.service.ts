import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { VectorSearchHit } from '@spectra/contracts';
import { reconcile, release, reserve } from '@spectra/metering';
import { PgVectorStore } from '@spectra/database';
import { JOB_NAMES } from '@spectra/workflow-core';

import { EmbeddingService } from '../infra/embedding.service';
import { QueueService } from '../infra/queue.service';
import { UsageService } from '../infra/usage.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../auth/types';

/**
 * Internal-knowledge retrieval over embedded research findings.
 * Tenant scope is compiled into every vector query (PgVectorStore).
 *
 * The embedder and its collection come from EmbeddingService as one value, so a
 * search always queries the collection its own model wrote (ADR-0023).
 */
@Injectable()
export class KnowledgeService {
  private readonly vectorStore: PgVectorStore;

  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddings: EmbeddingService,
    private readonly queue: QueueService,
    private readonly usage: UsageService,
  ) {
    this.vectorStore = new PgVectorStore(this.prisma.client);
  }

  async search(
    tenant: TenantContext,
    query: string,
    topK: number,
  ): Promise<{ hits: VectorSearchHit[]; retrieval: ReturnType<EmbeddingService['status']> }> {
    const scope = {
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId as string,
    };
    const { provider, collection } = this.embeddings.active;

    // Reserve BEFORE the provider call: the decision and the hold are atomic
    // (ADR-0029), so concurrent searches cannot all pass on the last allowance.
    // The lexical fallback is priced FREE_LOCAL and is never blocked — search
    // keeps working, honestly lexical.
    // Keyed per search so concurrent searches each take their own hold.
    const reservationKey = `knowledge-search-${scope.workspaceId}-${randomUUID()}`;
    await reserve(this.prisma.client, {
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      kind: 'AI_EMBEDDING',
      provider: provider.modelRef.provider,
      model: provider.modelRef.model,
      requests: 1,
      idempotencyKey: reservationKey,
      resourceType: 'KNOWLEDGE_SEARCH',
      // Short: a search either happens now or not at all.
      ttlMs: 60_000,
    });

    let embedResult;
    try {
      // 'query' side of the asymmetric pair — real models encode a search query
      // differently from a stored passage.
      embedResult = await provider.embed([query], scope, 'query');
    } catch (error) {
      // Never spent — return the allowance rather than holding it for the TTL.
      await release(this.prisma.client, scope, reservationKey);
      throw error;
    }
    const [queryVector] = embedResult.vectors;
    if (embedResult.usage) {
      await this.usage.record(scope, {
        kind: 'AI_EMBEDDING',
        provider: provider.modelRef.provider,
        model: provider.modelRef.model,
        totalTokens: embedResult.usage.totalTokens,
        resourceType: 'KNOWLEDGE_SEARCH',
      });
    }
    // Real usage (if any) is now in the ledger; stop the hold counting on top.
    await reconcile(this.prisma.client, scope, reservationKey);

    const hits = await this.vectorStore.search({
      ...scope,
      collection,
      queryText: query,
      queryVector: queryVector as number[],
      keywordWeight: 0.3,
      semanticWeight: 0.7,
      filters: {},
      topK,
      minScore: 0.05,
    });
    // The response states what retrieval actually did — semantic or lexical.
    return { hits, retrieval: this.embeddings.status() };
  }

  /**
   * Index coverage for the ACTIVE collection. Switching embedding model points
   * search at a new collection, so this reports honestly how much of the
   * workspace is actually searchable right now rather than implying full
   * coverage.
   */
  async status(tenant: TenantContext) {
    const scope = {
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId as string,
    };
    const { collection } = this.embeddings.active;
    const [indexed, total] = await Promise.all([
      this.prisma.client.documentChunk.count({ where: { ...scope, collection } }),
      this.prisma.client.documentChunk.count({ where: scope }),
    ]);
    // Distinct source rows across all collections = what COULD be indexed.
    const distinct = await this.prisma.client.documentChunk.findMany({
      where: scope,
      select: { documentId: true, index: true },
      distinct: ['documentId', 'index'],
    });
    const embeddable = distinct.length;
    return {
      retrieval: this.embeddings.status(),
      coverage: {
        indexed,
        embeddable,
        totalChunkRows: total,
        complete: indexed >= embeddable,
        note:
          indexed >= embeddable
            ? 'Every stored chunk is present in the active collection.'
            : `${embeddable - indexed} chunk(s) are not in the active collection and will not appear in search. Run a re-embed to backfill.`,
      },
    };
  }

  /** Enqueues the backfill that fills the active collection. */
  async reembed(tenant: TenantContext) {
    const scope = {
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId as string,
    };
    // A backfill can embed an entire corpus — the single most expensive
    // operation in the product. Reserve BEFORE queuing, so a blocked workspace
    // never has paid work sitting in the queue and two operators cannot both
    // start one against the same remaining allowance. Keyed per workspace so a
    // double-click re-uses the same hold instead of stacking a second.
    await reserve(this.prisma.client, {
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      kind: 'AI_EMBEDDING',
      provider: this.embeddings.active.provider.modelRef.provider,
      model: this.embeddings.active.provider.modelRef.model,
      requests: 1,
      idempotencyKey: `knowledge-reembed-${scope.workspaceId}`,
      resourceType: 'KNOWLEDGE_REEMBED',
    });
    await this.queue.enqueue(JOB_NAMES.knowledgeReembed, scope);
    return { status: 'QUEUED' as const, collection: this.embeddings.active.collection };
  }
}
