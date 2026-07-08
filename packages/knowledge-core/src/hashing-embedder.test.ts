import { describe, expect, it } from 'vitest';

import { cosineSimilarity } from './vector-store';
import {
  HashingEmbeddingProvider,
  LEXICAL_EMBEDDING_DIMENSIONS,
  lexicalEmbed,
} from './hashing-embedder';

const TENANT = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
};

describe('lexicalEmbed', () => {
  it('is deterministic', () => {
    const a = lexicalEmbed('AI testing adoption accelerates in India');
    const b = lexicalEmbed('AI testing adoption accelerates in India');
    expect(a).toEqual(b);
    expect(a).toHaveLength(LEXICAL_EMBEDDING_DIMENSIONS);
  });

  it('produces unit-length vectors', () => {
    const v = lexicalEmbed('some meaningful research text');
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it('ranks lexically similar text above unrelated text', () => {
    const query = lexicalEmbed('AI testing benchmark results');
    const related = lexicalEmbed('A new benchmark evaluates AI testing quality across models');
    const unrelated = lexicalEmbed('Luxury candle fragrances for Diwali gifting season');
    expect(cosineSimilarity(query, related)).toBeGreaterThan(cosineSimilarity(query, unrelated));
    expect(cosineSimilarity(query, related)).toBeGreaterThan(0.2);
  });

  it('handles unicode scripts and empty input', () => {
    const bengali = lexicalEmbed('নতুন অ্যালবাম প্রকাশিত হয়েছে');
    expect(bengali.some((v) => v !== 0)).toBe(true);
    const empty = lexicalEmbed('');
    expect(empty.every((v) => v === 0)).toBe(true);
  });
});

describe('HashingEmbeddingProvider', () => {
  it('implements the EmbeddingProvider port with a versioned model ref', async () => {
    const provider = new HashingEmbeddingProvider();
    const [a, b] = await provider.embed(['first text', 'second text'], TENANT);
    expect(a).toHaveLength(provider.dimensions);
    expect(b).toHaveLength(provider.dimensions);
    expect(provider.modelRef).toEqual({
      provider: 'spectra-local',
      model: 'lexical-hash',
      version: '1.0.0',
    });
  });
});
