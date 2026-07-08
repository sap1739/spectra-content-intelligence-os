import type { TenantScope } from '@spectra/contracts';
import type { EmbeddingProvider, ModelRef } from '@spectra/ai-core';

/**
 * Deterministic LEXICAL embedding via feature hashing (the "hashing trick"):
 * words and character trigrams are hashed into a fixed-dimension signed
 * vector, then L2-normalized. Classic IR technique — zero dependencies,
 * fully reproducible, tenant-safe (no external calls).
 *
 * HONEST LIMITS (ADR-0016): this captures lexical overlap, not semantics —
 * "car" and "automobile" are unrelated to it. It exists to make the entire
 * RAG plumbing real (chunk → embed → pgvector → search) behind the
 * EmbeddingProvider port; a neural provider replaces it per collection in
 * Phase 3 without touching callers.
 */

export const LEXICAL_EMBEDDING_DIMENSIONS = 256;
export const LEXICAL_EMBEDDING_COLLECTION = 'lexical-hash-256-v1';

/** FNV-1a 32-bit — stable, fast, good dispersion for feature hashing. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1);
}

function trigrams(token: string): string[] {
  if (token.length <= 3) return [token];
  const grams: string[] = [];
  for (let i = 0; i <= token.length - 3; i += 1) {
    grams.push(token.slice(i, i + 3));
  }
  return grams;
}

export function lexicalEmbed(text: string, dimensions = LEXICAL_EMBEDDING_DIMENSIONS): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const addFeature = (feature: string, weight: number) => {
    const hash = fnv1a(feature);
    const index = hash % dimensions;
    const sign = hash >>> 31 === 1 ? -1 : 1;
    vector[index] = (vector[index] as number) + sign * weight;
  };

  for (const token of tokenize(text)) {
    addFeature(`w:${token}`, 1);
    for (const gram of trigrams(token)) {
      addFeature(`g:${gram}`, 0.4);
    }
  }

  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return norm === 0 ? vector : vector.map((v) => v / norm);
}

export class HashingEmbeddingProvider implements EmbeddingProvider {
  public readonly id = 'spectra-lexical-hash';
  public readonly displayName = 'First-party lexical hashing embedder';
  public readonly dimensions = LEXICAL_EMBEDDING_DIMENSIONS;
  public readonly modelRef: ModelRef = {
    provider: 'spectra-local',
    model: 'lexical-hash',
    version: '1.0.0',
  };

  async embed(texts: readonly string[], _tenant: TenantScope): Promise<number[][]> {
    return texts.map((text) => lexicalEmbed(text, this.dimensions));
  }
}
