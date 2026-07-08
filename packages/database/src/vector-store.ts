import type { TenantScope, VectorSearchHit, VectorSearchRequest } from '@spectra/contracts';
import type { UpsertChunksInput, VectorStoreProvider } from '@spectra/knowledge-core';

import type { SpectraPrismaClient } from './client';

/**
 * pgvector-backed VectorStoreProvider (ADR-0005). Vector columns are
 * `Unsupported()` in Prisma, so reads/writes go through parameterized raw
 * SQL. Tenant scope is compiled into every statement — cross-tenant
 * retrieval is impossible by construction.
 */
export class PgVectorStore implements VectorStoreProvider {
  public readonly providerId = 'pgvector';

  constructor(private readonly prisma: SpectraPrismaClient) {}

  /** Numbers-only vector literal — validated before interpolation. */
  private vectorLiteral(vector: readonly number[]): string {
    if (vector.some((v) => !Number.isFinite(v))) {
      throw new Error('Vector contains non-finite values');
    }
    return `[${vector.join(',')}]`;
  }

  async upsertChunks(input: UpsertChunksInput): Promise<void> {
    for (const { chunk, vector } of input.chunks) {
      const literal = this.vectorLiteral(vector);
      const provider = chunk.embedding?.provider ?? 'unknown';
      const model = chunk.embedding?.model ?? 'unknown';
      await this.prisma.$executeRaw`
        INSERT INTO "document_chunks"
          ("id", "organizationId", "workspaceId", "collection", "documentId",
           "index", "text", "metadata", "embeddingProvider", "embeddingModel",
           "dimensions", "embedding", "updatedAt")
        VALUES
          (${chunk.id}::uuid, ${input.tenant.organizationId}::uuid,
           ${input.tenant.workspaceId}::uuid, ${input.collection}, ${chunk.documentId}::uuid,
           ${chunk.index}, ${chunk.text}, ${JSON.stringify(chunk.metadata)}::jsonb,
           ${provider}, ${model}, ${vector.length}, ${literal}::vector, now())
        ON CONFLICT ("id") DO UPDATE SET
          "text" = EXCLUDED."text",
          "metadata" = EXCLUDED."metadata",
          "embedding" = EXCLUDED."embedding",
          "updatedAt" = now()
      `;
    }
  }

  async search(request: VectorSearchRequest): Promise<VectorSearchHit[]> {
    if (!request.queryVector) {
      throw new Error('PgVectorStore.search requires queryVector (embed the query first)');
    }
    const literal = this.vectorLiteral(request.queryVector);
    const keyword = request.queryText ? `%${request.queryText}%` : null;

    // Hybrid rank: semanticWeight × cosine similarity + keywordWeight × ILIKE hit.
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; documentId: string; text: string; metadata: unknown; score: number }>
    >`
      SELECT
        "id",
        "documentId",
        "text",
        "metadata",
        (${request.semanticWeight} * (1 - ("embedding" <=> ${literal}::vector))
         + CASE WHEN ${keyword}::text IS NOT NULL AND "text" ILIKE ${keyword}
                THEN ${request.keywordWeight} ELSE 0 END)::float AS score
      FROM "document_chunks"
      WHERE "organizationId" = ${request.organizationId}::uuid
        AND "workspaceId" = ${request.workspaceId}::uuid
        AND "collection" = ${request.collection}
        AND "embedding" IS NOT NULL
      ORDER BY score DESC
      LIMIT ${request.topK}
    `;

    return rows
      .map((row) => ({
        chunkId: row.id,
        documentId: row.documentId,
        score: Math.max(0, Math.min(1, row.score)),
        text: row.text,
        metadata: (row.metadata ?? {}) as Record<string, unknown>,
      }))
      .filter((hit) => (request.minScore === undefined ? true : hit.score >= request.minScore));
  }

  async deleteByDocument(
    tenant: TenantScope,
    collection: string,
    documentId: string,
  ): Promise<void> {
    await this.prisma.$executeRaw`
      DELETE FROM "document_chunks"
      WHERE "organizationId" = ${tenant.organizationId}::uuid
        AND "workspaceId" = ${tenant.workspaceId}::uuid
        AND "collection" = ${collection}
        AND "documentId" = ${documentId}::uuid
    `;
  }

  async deleteByTenant(tenant: TenantScope): Promise<void> {
    await this.prisma.$executeRaw`
      DELETE FROM "document_chunks"
      WHERE "organizationId" = ${tenant.organizationId}::uuid
        AND "workspaceId" = ${tenant.workspaceId}::uuid
    `;
  }
}
