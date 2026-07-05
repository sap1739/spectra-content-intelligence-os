import { describe, expect, it } from 'vitest';

import { FixtureWebSearchProvider } from './fixtures';
import { canAdvanceStage, RESEARCH_STAGE_ORDER } from './pipeline';
import {
  DuplicateProviderError,
  ProviderNotFoundError,
  ResearchProviderRegistry,
} from './registry';

const TENANT = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
};

describe('ResearchProviderRegistry', () => {
  const fixture = new FixtureWebSearchProvider('fixture-1', 'Fixture Search', [
    { url: 'https://example.com/a', category: 'WEB' },
    { url: 'https://example.com/b', category: 'WEB' },
  ]);

  it('registers and resolves providers by kind', async () => {
    const registry = new ResearchProviderRegistry();
    registry.register(fixture);

    const provider = registry.get<FixtureWebSearchProvider>('web-search');
    const results = await provider.search({ queryText: 'anything', maxResults: 1 }, TENANT);
    expect(results).toHaveLength(1);
    expect(results[0]?.url).toBe('https://example.com/a');
  });

  it('resolves by explicit id and rejects duplicates', () => {
    const registry = new ResearchProviderRegistry();
    registry.register(fixture);
    expect(registry.get('web-search', 'fixture-1').id).toBe('fixture-1');
    expect(() => registry.register(fixture)).toThrow(DuplicateProviderError);
  });

  it('throws a typed error for unknown kinds', () => {
    const registry = new ResearchProviderRegistry();
    expect(() => registry.get('news-search')).toThrow(ProviderNotFoundError);
  });

  it('marks fixture providers so they can be blocked in production', () => {
    expect(fixture.isFixture).toBe(true);
  });
});

describe('pipeline stage sequencing', () => {
  it('covers all 22 stages in order', () => {
    expect(RESEARCH_STAGE_ORDER).toHaveLength(22);
    expect(RESEARCH_STAGE_ORDER[0]).toBe('REQUEST_CREATED');
    expect(RESEARCH_STAGE_ORDER[21]).toBe('KNOWLEDGE_BASE_STORAGE');
  });

  it('only allows forward or same-stage transitions', () => {
    expect(canAdvanceStage(null, 'REQUEST_CREATED')).toBe(true);
    expect(canAdvanceStage(null, 'TREND_SCORING')).toBe(false);
    expect(canAdvanceStage('QUERY_PLANNING', 'QUERY_EXPANSION')).toBe(true);
    expect(canAdvanceStage('QUERY_PLANNING', 'QUERY_PLANNING')).toBe(true);
    expect(canAdvanceStage('QUERY_EXPANSION', 'QUERY_PLANNING')).toBe(false);
    expect(canAdvanceStage('QUERY_PLANNING', 'TREND_SCORING')).toBe(false);
  });
});
