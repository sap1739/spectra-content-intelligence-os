import type {
  DocumentChunk,
  TenantScope,
  VectorSearchHit,
  VectorSearchRequest,
} from '@spectra/contracts';

/**
 * Provider-neutral vector store port. Production targets pgvector first
 * (ADR-0005); the interface allows swapping in a dedicated vector database
 * without touching retrieval callers. Tenant scope is mandatory on every
 * operation — cross-tenant retrieval must be impossible by construction.
 */

export interface UpsertChunksInput {
  tenant: TenantScope;
  collection: string;
  chunks: Array<{
    chunk: DocumentChunk;
    vector: number[];
  }>;
}

export interface VectorStoreProvider {
  readonly providerId: string;
  upsertChunks(input: UpsertChunksInput): Promise<void>;
  search(request: VectorSearchRequest): Promise<VectorSearchHit[]>;
  /** Deletion propagation: removing a document removes all its vectors. */
  deleteByDocument(tenant: TenantScope, collection: string, documentId: string): Promise<void>;
  /** Account/tenant deletion support. */
  deleteByTenant(tenant: TenantScope): Promise<void>;
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) {
    throw new Error('Vectors must be non-empty and of equal dimension');
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

interface StoredVector {
  tenantKey: string;
  collection: string;
  documentId: string;
  chunkId: string;
  text: string;
  vector: number[];
  metadata: Record<string, unknown>;
}

function tenantKeyOf(tenant: TenantScope): string {
  return `${tenant.organizationId}:${tenant.workspaceId}`;
}

/**
 * In-memory vector store for unit tests and offline development ONLY.
 * Real cosine similarity, real tenant filtering — no persistence.
 */
export class InMemoryVectorStore implements VectorStoreProvider {
  public readonly providerId = 'in-memory';
  private readonly vectors: StoredVector[] = [];

  async upsertChunks(input: UpsertChunksInput): Promise<void> {
    for (const { chunk, vector } of input.chunks) {
      const tenantKey = tenantKeyOf(input.tenant);
      const existingIndex = this.vectors.findIndex(
        (v) =>
          v.tenantKey === tenantKey && v.collection === input.collection && v.chunkId === chunk.id,
      );
      const record: StoredVector = {
        tenantKey,
        collection: input.collection,
        documentId: chunk.documentId,
        chunkId: chunk.id,
        text: chunk.text,
        vector,
        metadata: chunk.metadata,
      };
      if (existingIndex >= 0) {
        this.vectors[existingIndex] = record;
      } else {
        this.vectors.push(record);
      }
    }
  }

  async search(request: VectorSearchRequest): Promise<VectorSearchHit[]> {
    if (!request.queryVector) {
      throw new Error('InMemoryVectorStore requires queryVector (no embedder attached)');
    }
    const tenantKey = tenantKeyOf({
      organizationId: request.organizationId,
      workspaceId: request.workspaceId,
    });
    const scored = this.vectors
      .filter((v) => v.tenantKey === tenantKey && v.collection === request.collection)
      .map((v) => ({
        chunkId: v.chunkId,
        documentId: v.documentId,
        score: Math.max(0, cosineSimilarity(request.queryVector as number[], v.vector)),
        text: v.text,
        metadata: v.metadata,
      }))
      .filter((hit) => (request.minScore === undefined ? true : hit.score >= request.minScore))
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, request.topK);
  }

  async deleteByDocument(
    tenant: TenantScope,
    collection: string,
    documentId: string,
  ): Promise<void> {
    const tenantKey = tenantKeyOf(tenant);
    for (let i = this.vectors.length - 1; i >= 0; i -= 1) {
      const v = this.vectors[i] as StoredVector;
      if (v.tenantKey === tenantKey && v.collection === collection && v.documentId === documentId) {
        this.vectors.splice(i, 1);
      }
    }
  }

  async deleteByTenant(tenant: TenantScope): Promise<void> {
    const tenantKey = tenantKeyOf(tenant);
    for (let i = this.vectors.length - 1; i >= 0; i -= 1) {
      if ((this.vectors[i] as StoredVector).tenantKey === tenantKey) {
        this.vectors.splice(i, 1);
      }
    }
  }

  get size(): number {
    return this.vectors.length;
  }
}
