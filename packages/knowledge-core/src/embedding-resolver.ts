import type { EmbeddingProvider } from '@spectra/ai-core';

import { HashingEmbeddingProvider, LEXICAL_EMBEDDING_COLLECTION } from './hashing-embedder';

/**
 * Resolves the ACTIVE embedder together with the collection it writes to.
 *
 * Why they must resolve as a pair: a collection stores exactly one embedding
 * model's vectors. If ingestion embedded with model A into collection A and a
 * later search embedded with model B but queried collection A, every score
 * would be meaningless — the vectors would be incomparable. Binding the
 * provider and the collection name in one value makes that mismatch
 * unrepresentable.
 *
 * Honesty: when no semantic provider is configured this returns the lexical
 * embedder with `semantic: false` and a human-readable `note`. Callers surface
 * that rather than implying semantic retrieval they are not performing.
 */

export interface ResolvedEmbedding {
  provider: EmbeddingProvider;
  /** The collection this provider's vectors live in. */
  collection: string;
  /** True only when a real semantic model is active. */
  semantic: boolean;
  /** Human-readable statement of what retrieval is actually doing. */
  note: string;
}

/**
 * Collection naming: `<provider>-<model>-<dims>-v1`. Changing model or width
 * yields a new collection, so vectors never silently mix across models and a
 * re-embed can run alongside the old collection until it is complete.
 */
export function embeddingCollectionFor(provider: EmbeddingProvider): string {
  const { provider: vendor, model } = provider.modelRef;
  return `${vendor}-${model}-${provider.dimensions}-v1`;
}

const LEXICAL_NOTE =
  'Retrieval is LEXICAL (first-party hashing embedder): it matches shared words and ' +
  'character trigrams, not meaning — "car" and "automobile" score as unrelated. ' +
  'Set VOYAGE_API_KEY to enable semantic retrieval.';

/**
 * @param semantic a configured semantic provider, or undefined/unconfigured to
 * fall back to lexical.
 */
export function resolveEmbedding(
  semantic?: (EmbeddingProvider & { isConfigured?: boolean }) | undefined,
): ResolvedEmbedding {
  if (semantic && semantic.isConfigured !== false) {
    return {
      provider: semantic,
      collection: embeddingCollectionFor(semantic),
      semantic: true,
      note: `Semantic retrieval via ${semantic.displayName} (${semantic.modelRef.model}, ${semantic.dimensions}d).`,
    };
  }
  const lexical = new HashingEmbeddingProvider();
  return {
    provider: lexical,
    collection: LEXICAL_EMBEDDING_COLLECTION,
    semantic: false,
    note: LEXICAL_NOTE,
  };
}
