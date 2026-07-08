import { Injectable } from '@nestjs/common';
import type { VectorSearchHit } from '@spectra/contracts';
import { PgVectorStore } from '@spectra/database';
import { HashingEmbeddingProvider, LEXICAL_EMBEDDING_COLLECTION } from '@spectra/knowledge-core';

import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../auth/types';

/**
 * Internal-knowledge retrieval over embedded research findings.
 * Tenant scope is compiled into every vector query (PgVectorStore).
 */
@Injectable()
export class KnowledgeService {
  private readonly embedder = new HashingEmbeddingProvider();
  private readonly vectorStore: PgVectorStore;

  constructor(private readonly prisma: PrismaService) {
    this.vectorStore = new PgVectorStore(this.prisma.client);
  }

  async search(tenant: TenantContext, query: string, topK: number): Promise<VectorSearchHit[]> {
    const scope = {
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId as string,
    };
    const [queryVector] = await this.embedder.embed([query], scope);
    return this.vectorStore.search({
      ...scope,
      collection: LEXICAL_EMBEDDING_COLLECTION,
      queryText: query,
      queryVector: queryVector as number[],
      keywordWeight: 0.3,
      semanticWeight: 0.7,
      filters: {},
      topK,
      minScore: 0.05,
    });
  }
}
