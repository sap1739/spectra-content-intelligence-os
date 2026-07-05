import { describe, expect, it } from 'vitest';

import { customVerticalSchema } from './vertical';
import { platformCapabilitySchema } from './social';
import { researchFindingSchema } from './research';
import { trendScoringConfigSchema } from './trend';

const TENANT = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
};

const TIMESTAMPS = {
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('customVerticalSchema', () => {
  it('accepts an arbitrary user-defined niche with free-text industry', () => {
    const vertical = customVerticalSchema.parse({
      id: '33333333-3333-4333-8333-333333333333',
      ...TENANT,
      ...TIMESTAMPS,
      name: 'Bengali music releases',
      slug: 'bengali-music-releases',
      industry: 'Independent music — regional Indian',
      languages: ['bn', 'en'],
      geographies: ['IN-WB', 'Bangladesh'],
      status: 'ACTIVE',
    });
    expect(vertical.keywords).toEqual([]);
    expect(vertical.relevanceCriteria).toEqual([]);
  });
});

describe('researchFindingSchema', () => {
  it('retains full provenance and citation metadata', () => {
    const finding = researchFindingSchema.parse({
      id: '44444444-4444-4444-8444-444444444444',
      ...TENANT,
      ...TIMESTAMPS,
      projectId: '55555555-5555-4555-8555-555555555555',
      sourceId: '66666666-6666-4666-8666-666666666666',
      summary: 'Example finding summary.',
      sourceCategory: 'NEWS',
      status: 'PENDING_REVIEW',
      provenance: {
        providerId: 'fixture-web-search',
        providerKind: 'web-search',
        retrievedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    expect(finding.provenance.providerId).toBe('fixture-web-search');
    expect(finding.corroboratedByFindingIds).toEqual([]);
  });
});

describe('trendScoringConfigSchema', () => {
  it('requires a version so formulas are never silently replaced', () => {
    const result = trendScoringConfigSchema.safeParse({
      id: 'default',
      name: 'Default weights',
      weights: { freshness: 0.5 },
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });
});

describe('platformCapabilitySchema', () => {
  it('models unknown capabilities as null instead of guessing', () => {
    const capability = platformCapabilitySchema.parse({
      platform: 'LINKEDIN',
      capabilityVersion: '2026-07-01',
      recordedAt: '2026-07-01T00:00:00.000Z',
      limits: { maxCharacters: 3000 },
      supports: {
        nativeScheduling: null,
        editAfterPublish: null,
        deletion: null,
        analytics: null,
        comments: null,
        webhooks: null,
        stories: null,
        drafts: null,
      },
      oauth: { scopes: [], refreshSupported: null },
    });
    expect(capability.supports.nativeScheduling).toBeNull();
  });
});
