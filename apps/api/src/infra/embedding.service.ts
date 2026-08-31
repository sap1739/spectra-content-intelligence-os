import { Injectable } from '@nestjs/common';
import { VoyageEmbeddingProvider } from '@spectra/ai-voyage';
import { resolveEmbedding, type ResolvedEmbedding } from '@spectra/knowledge-core';

import { getApiEnv } from '../config/env';

/**
 * The workspace's ACTIVE embedder, resolved together with its collection.
 *
 * Env-gated: with VOYAGE_API_KEY set, retrieval is semantic; without it the
 * system falls back to the first-party lexical embedder and reports that
 * honestly (`status().semantic === false` plus a plain-English note). Retrieval
 * quality is never overstated.
 *
 * The key lives only inside the adapter — never logged or serialised.
 */
@Injectable()
export class EmbeddingService {
  private readonly resolved: ResolvedEmbedding;

  constructor() {
    const env = getApiEnv();
    const voyage = new VoyageEmbeddingProvider({
      apiKey: env.VOYAGE_API_KEY,
      model: env.VOYAGE_EMBEDDING_MODEL,
      dimensions: env.VOYAGE_EMBEDDING_DIMENSIONS,
    });
    this.resolved = resolveEmbedding(voyage);
  }

  /** Provider + collection as one value — they must never diverge. */
  get active(): ResolvedEmbedding {
    return this.resolved;
  }

  /** Non-secret descriptor for the honest UI retrieval-quality state. */
  status(): {
    semantic: boolean;
    provider: string;
    model: string;
    dimensions: number;
    collection: string;
    note: string;
  } {
    const { provider, collection, semantic, note } = this.resolved;
    return {
      semantic,
      provider: provider.modelRef.provider,
      model: provider.modelRef.model,
      dimensions: provider.dimensions,
      collection,
      note,
    };
  }
}
