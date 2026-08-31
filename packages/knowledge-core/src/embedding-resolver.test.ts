import type { EmbeddingProvider } from '@spectra/ai-core';
import type { TenantScope } from '@spectra/contracts';
import { describe, expect, it } from 'vitest';

import { embeddingCollectionFor, resolveEmbedding } from './embedding-resolver';
import { LEXICAL_EMBEDDING_COLLECTION } from './hashing-embedder';

function fakeSemantic(
  isConfigured: boolean,
  dimensions = 1024,
): EmbeddingProvider & {
  isConfigured: boolean;
} {
  return {
    id: 'voyage',
    displayName: 'Voyage AI embeddings',
    modelRef: { provider: 'voyage', model: 'voyage-4' },
    dimensions,
    isConfigured,
    embed: async (texts: readonly string[], _t: TenantScope) =>
      texts.map(() => new Array<number>(dimensions).fill(0.1)),
  };
}

describe('resolveEmbedding', () => {
  it('falls back to lexical with an honest note when nothing is configured', () => {
    const resolved = resolveEmbedding(undefined);
    expect(resolved.semantic).toBe(false);
    expect(resolved.collection).toBe(LEXICAL_EMBEDDING_COLLECTION);
    expect(resolved.note).toMatch(/LEXICAL/);
    // The note must state the actual limitation, not gloss over it.
    expect(resolved.note).toMatch(/not meaning/);
  });

  it('falls back to lexical when the semantic provider exists but is unconfigured', () => {
    const resolved = resolveEmbedding(fakeSemantic(false));
    expect(resolved.semantic).toBe(false);
    expect(resolved.collection).toBe(LEXICAL_EMBEDDING_COLLECTION);
  });

  it('uses the semantic provider and its own collection when configured', () => {
    const resolved = resolveEmbedding(fakeSemantic(true));
    expect(resolved.semantic).toBe(true);
    expect(resolved.collection).toBe('voyage-voyage-4-1024-v1');
    expect(resolved.note).toMatch(/Semantic retrieval/);
  });

  it('gives different widths different collections so vectors never mix', () => {
    const a = resolveEmbedding(fakeSemantic(true, 1024));
    const b = resolveEmbedding(fakeSemantic(true, 256));
    expect(a.collection).not.toBe(b.collection);
  });

  it('never returns the lexical collection for a semantic provider', () => {
    const resolved = resolveEmbedding(fakeSemantic(true));
    expect(resolved.collection).not.toBe(LEXICAL_EMBEDDING_COLLECTION);
  });

  it('derives a stable collection name from the model ref', () => {
    expect(embeddingCollectionFor(fakeSemantic(true, 512))).toBe('voyage-voyage-4-512-v1');
  });
});
