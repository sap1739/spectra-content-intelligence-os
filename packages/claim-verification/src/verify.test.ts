import { describe, expect, it } from 'vitest';

import {
  assessFreshness,
  claimClusterKey,
  clusterClaims,
  corroborate,
  countIndependentSources,
  decideEligibility,
  detectContradictions,
  extractNumbers,
} from './verify';
import type { ClaimInput, ClaimSupport } from './types';

/** Claim verification (ADR-0032). */

const NOW = new Date('2026-09-09T00:00:00.000Z');

function support(overrides: Partial<ClaimSupport> = {}): ClaimSupport {
  return {
    sourceId: overrides.sourceId ?? `src-${Math.random().toString(36).slice(2, 8)}`,
    syndicationKey: overrides.syndicationKey ?? null,
    publisher: overrides.publisher ?? 'Publisher',
    snippetOnly: overrides.snippetOnly ?? false,
    credibilityScore: overrides.credibilityScore ?? 0.5,
    // `in`, not `??`: an explicit null means "this source stated no date" and
    // must not fall back to the default.
    publishedAt:
      'publishedAt' in overrides
        ? (overrides.publishedAt as Date | null)
        : new Date('2026-09-01T00:00:00.000Z'),
    ...(overrides.citationId ? { citationId: overrides.citationId } : {}),
  };
}

function claim(overrides: Partial<ClaimInput> = {}): ClaimInput {
  return {
    id: overrides.id ?? 'claim-1',
    text: overrides.text ?? 'Adoption of AI testing grew 40% in 2026.',
    normalizedKey: overrides.normalizedKey ?? 'adoption ai testing grew 40 2026',
    claimType: overrides.claimType ?? 'STATISTIC',
    supports: overrides.supports ?? [support()],
    ...(overrides.evergreen !== undefined ? { evergreen: overrides.evergreen } : {}),
  };
}

describe('independent-source counting', () => {
  it('counts genuinely distinct sources', () => {
    expect(
      countIndependentSources([
        support({ sourceId: 'a' }),
        support({ sourceId: 'b' }),
        support({ sourceId: 'c' }),
      ]),
    ).toBe(3);
  });

  it('collapses syndicated copies of ONE story to a single source', () => {
    // Ten outlets running one wire story is one independent source. Counting it
    // as ten would make a single unverified report look overwhelming.
    const supports = Array.from({ length: 10 }, (_, i) =>
      support({
        sourceId: `outlet-${i}`,
        syndicationKey: 'wire-story-1',
        publisher: `Outlet ${i}`,
      }),
    );
    expect(countIndependentSources(supports)).toBe(1);
  });

  it('counts a syndicated cluster plus an independent source as two', () => {
    expect(
      countIndependentSources([
        support({ sourceId: 'a', syndicationKey: 'wire-1' }),
        support({ sourceId: 'b', syndicationKey: 'wire-1' }),
        support({ sourceId: 'c' }),
      ]),
    ).toBe(2);
  });
});

describe('corroboration', () => {
  it('marks a claim CORROBORATED at two independent sources', () => {
    const result = corroborate(
      claim({ supports: [support({ sourceId: 'a' }), support({ sourceId: 'b' })] }),
    );
    expect(result.independentSourceCount).toBe(2);
    expect(result.verificationStatus).toBe('CORROBORATED');
    expect(result.confidenceLevel).toBe('MEDIUM');
  });

  it('reaches HIGH confidence at three independent sources', () => {
    const result = corroborate(
      claim({
        supports: [
          support({ sourceId: 'a', publisher: 'A' }),
          support({ sourceId: 'b', publisher: 'B' }),
          support({ sourceId: 'c', publisher: 'C' }),
        ],
      }),
    );
    expect(result.confidenceLevel).toBe('HIGH');
    expect(result.sourceDiversity).toBe(3);
  });

  it('does NOT let syndicated copies reach corroboration', () => {
    const result = corroborate(
      claim({
        supports: Array.from({ length: 6 }, (_, i) =>
          support({ sourceId: `o${i}`, syndicationKey: 'wire-1', publisher: `Outlet ${i}` }),
        ),
      }),
    );
    // Six rows, one actual source.
    expect(result.corroborationCount).toBe(6);
    expect(result.independentSourceCount).toBe(1);
    expect(result.verificationStatus).toBe('UNVERIFIED');
    expect(result.confidenceLevel).toBe('LOW');
  });

  it('never reaches HIGH on snippet-only evidence', () => {
    const result = corroborate(
      claim({
        supports: [
          support({ sourceId: 'a', snippetOnly: true }),
          support({ sourceId: 'b', snippetOnly: true }),
          support({ sourceId: 'c', snippetOnly: true }),
        ],
      }),
    );
    // We read search summaries, not the articles — cannot claim verification.
    expect(result.snippetOnlyEvidence).toBe(true);
    expect(result.confidenceLevel).toBe('MEDIUM');
  });

  it('lets one highly credible source reach MEDIUM', () => {
    const result = corroborate(
      claim({ supports: [support({ sourceId: 'a', credibilityScore: 0.95 })] }),
    );
    expect(result.independentSourceCount).toBe(1);
    expect(result.confidenceLevel).toBe('MEDIUM');
  });

  it('collects supporting citation ids without inventing any', () => {
    const result = corroborate(
      claim({
        supports: [
          support({ sourceId: 'a', citationId: 'cit-1' }),
          support({ sourceId: 'b' }), // no citation recorded
        ],
      }),
    );
    expect(result.supportingCitationIds).toEqual(['cit-1']);
  });

  it('reports UNKNOWN confidence when nothing supports the claim', () => {
    const result = corroborate(claim({ supports: [] }));
    expect(result.independentSourceCount).toBe(0);
    expect(result.confidenceLevel).toBe('UNKNOWN');
  });
});

describe('clustering', () => {
  it('groups the same fact phrased differently', () => {
    const a = claim({ id: 'a', text: 'Adoption of AI testing grew 40% in 2026.' });
    const b = claim({
      id: 'b',
      text: 'In 2026, AI testing adoption grew by 40 percent.',
      supports: [support({ sourceId: 'other' })],
    });
    expect(claimClusterKey(a.text)).toBe(claimClusterKey(b.text));

    const clusters = clusterClaims([a, b]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.independentSourceCount).toBe(2);
  });

  it('keeps claims with different figures in separate clusters', () => {
    const a = claim({ id: 'a', text: 'Adoption of AI testing grew 40% in 2026.' });
    const b = claim({ id: 'b', text: 'Adoption of AI testing grew 25% in 2026.' });
    expect(claimClusterKey(a.text)).not.toBe(claimClusterKey(b.text));
    expect(clusterClaims([a, b])).toHaveLength(2);
  });

  it('normalizes number forms but ignores bare years', () => {
    expect(extractNumbers('grew 40 percent')).toEqual(['40%']);
    expect(extractNumbers('grew 40%')).toEqual(['40%']);
    // A year is context, not a magnitude.
    expect(extractNumbers('published in 2026')).toEqual([]);
  });
});

describe('contradiction detection', () => {
  it('detects materially different numbers about the same subject', () => {
    const found = detectContradictions([
      claim({ id: 'a', text: 'Adoption of AI testing grew 40% in 2026 across enterprises.' }),
      claim({ id: 'b', text: 'Adoption of AI testing grew 25% in 2026 across enterprises.' }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe('NUMERIC_CONFLICT');
    expect(found[0]?.detail).toMatch(/40%.*25%|25%.*40%/);
  });

  it('treats rounding differences as agreement, not conflict', () => {
    const found = detectContradictions([
      claim({ id: 'a', text: 'Adoption of AI testing grew 40% in 2026 across enterprises.' }),
      claim({ id: 'b', text: 'Adoption of AI testing grew 41% in 2026 across enterprises.' }),
    ]);
    expect(found).toHaveLength(0);
  });

  it('detects negation', () => {
    const found = detectContradictions([
      claim({ id: 'a', text: 'The regulator approved the framework for enterprise testing.' }),
      claim({
        id: 'b',
        text: 'The regulator did not approve the framework for enterprise testing.',
      }),
    ]);
    expect(found[0]?.kind).toBe('NEGATION');
  });

  it('detects opposite directions', () => {
    const found = detectContradictions([
      claim({ id: 'a', text: 'Enterprise spending on testing tools rose sharply last quarter.' }),
      claim({ id: 'b', text: 'Enterprise spending on testing tools fell sharply last quarter.' }),
    ]);
    expect(found[0]?.kind).toBe('DIRECTIONAL_CONFLICT');
  });

  it('does not flag claims about different subjects', () => {
    const found = detectContradictions([
      claim({ id: 'a', text: 'Adoption of AI testing grew 40% in 2026 across enterprises.' }),
      claim({ id: 'b', text: 'Container orchestration spending fell 12% among small retailers.' }),
    ]);
    expect(found).toHaveLength(0);
  });

  it('reports each conflicting pair once', () => {
    const found = detectContradictions([
      claim({ id: 'a', text: 'Adoption of AI testing grew 40% in 2026 across enterprises.' }),
      claim({ id: 'b', text: 'Adoption of AI testing grew 25% in 2026 across enterprises.' }),
    ]);
    expect(found).toHaveLength(1);
  });
});

describe('freshness', () => {
  it('marks a recent statistic CURRENT', () => {
    const result = assessFreshness(
      claim({ supports: [support({ publishedAt: new Date('2026-08-20T00:00:00.000Z') })] }),
      NOW,
    );
    expect(result.status).toBe('CURRENT');
    expect(result.timeSensitive).toBe(true);
  });

  it('marks an old statistic STALE', () => {
    const result = assessFreshness(
      claim({ supports: [support({ publishedAt: new Date('2024-01-01T00:00:00.000Z') })] }),
      NOW,
    );
    expect(result.status).toBe('STALE');
  });

  it('uses the NEWEST supporting source, not the oldest', () => {
    const result = assessFreshness(
      claim({
        supports: [
          support({ sourceId: 'old', publishedAt: new Date('2023-01-01T00:00:00.000Z') }),
          support({ sourceId: 'new', publishedAt: new Date('2026-09-01T00:00:00.000Z') }),
        ],
      }),
      NOW,
    );
    expect(result.status).toBe('CURRENT');
    expect(result.latestSupportAt?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('does not decay non-time-sensitive claim types', () => {
    const result = assessFreshness(
      claim({
        claimType: 'FACTUAL',
        supports: [support({ publishedAt: new Date('2020-01-01T00:00:00.000Z') })],
      }),
      NOW,
    );
    // A historical fact does not become false with age.
    expect(result.status).toBe('CURRENT');
    expect(result.timeSensitive).toBe(false);
  });

  it('honours an evergreen marking', () => {
    const result = assessFreshness(
      claim({ evergreen: true, supports: [support({ publishedAt: new Date('2019-01-01') })] }),
      NOW,
    );
    expect(result.status).toBe('EVERGREEN');
  });

  it('reports UNKNOWN when no supporting source stated a date', () => {
    const result = assessFreshness(claim({ supports: [support({ publishedAt: null })] }), NOW);
    // Undated is uncertain, not certainly current.
    expect(result.status).toBe('UNKNOWN');
    expect(result.latestSupportAt).toBeNull();
  });

  it('is inclusive at the CURRENT boundary and at the STALE boundary', () => {
    const exactly90 = new Date(NOW.getTime() - 90 * 86_400_000);
    expect(
      assessFreshness(claim({ supports: [support({ publishedAt: exactly90 })] }), NOW).status,
    ).toBe('CURRENT');
    const exactly365 = new Date(NOW.getTime() - 365 * 86_400_000);
    expect(
      assessFreshness(claim({ supports: [support({ publishedAt: exactly365 })] }), NOW).status,
    ).toBe('STALE');
  });
});

describe('evidence eligibility', () => {
  const corroboration = (independent: number, snippetOnly = false) =>
    corroborate(
      claim({
        supports: Array.from({ length: independent }, (_, i) =>
          support({ sourceId: `s${i}`, publisher: `P${i}`, snippetOnly }),
        ),
      }),
    );
  const fresh = {
    status: 'CURRENT' as const,
    latestSupportAt: NOW,
    ageDays: 1,
    timeSensitive: true,
  };

  it('marks a well-corroborated current claim ELIGIBLE', () => {
    const result = decideEligibility({
      corroboration: corroboration(3),
      freshness: fresh,
      contradictionCount: 0,
    });
    expect(result.decision).toBe('ELIGIBLE');
    expect(result.reason).toMatch(/3 independent sources/);
  });

  it('marks a single-source claim WEAK, not eligible', () => {
    const result = decideEligibility({
      corroboration: corroboration(1),
      freshness: fresh,
      contradictionCount: 0,
    });
    expect(result.decision).toBe('WEAK');
    expect(result.requiresReview).toBe(false);
  });

  it('BLOCKS a claim with no supporting source at all', () => {
    const result = decideEligibility({
      corroboration: corroborate(claim({ supports: [] })),
      freshness: fresh,
      contradictionCount: 0,
    });
    // Citing it would mean fabricating support.
    expect(result.decision).toBe('BLOCKED');
    expect(result.reason).toMatch(/No supporting source/i);
  });

  it('sends a contradicted claim to review rather than picking a side', () => {
    const result = decideEligibility({
      corroboration: corroboration(3),
      freshness: fresh,
      contradictionCount: 1,
    });
    expect(result.decision).toBe('REQUIRES_REVIEW');
    expect(result.requiresReview).toBe(true);
    expect(result.reason).toMatch(/conflicts with 1 other claim/);
  });

  it('sends a stale time-sensitive claim to review', () => {
    const result = decideEligibility({
      corroboration: corroboration(3),
      freshness: { status: 'STALE', latestSupportAt: NOW, ageDays: 500, timeSensitive: true },
      contradictionCount: 0,
    });
    expect(result.decision).toBe('REQUIRES_REVIEW');
    expect(result.reason).toMatch(/500 days old/);
  });

  it('marks all-snippet evidence WEAK even when corroborated', () => {
    const result = decideEligibility({
      corroboration: corroboration(3, true),
      freshness: fresh,
      contradictionCount: 0,
    });
    expect(result.decision).toBe('WEAK');
    expect(result.reason).toMatch(/snippet-only/i);
  });

  it('lets a reviewer approval override the automated assessment', () => {
    const result = decideEligibility({
      corroboration: corroboration(1),
      freshness: fresh,
      contradictionCount: 2,
      reviewStatus: 'APPROVED',
    });
    expect(result.decision).toBe('ELIGIBLE');
    expect(result.reason).toMatch(/reviewer approved/i);
  });

  it('lets a reviewer rejection block an otherwise strong claim', () => {
    const result = decideEligibility({
      corroboration: corroboration(5),
      freshness: fresh,
      contradictionCount: 0,
      reviewStatus: 'REJECTED',
    });
    expect(result.decision).toBe('BLOCKED');
  });

  it('keeps a claim in review while more research was requested', () => {
    const result = decideEligibility({
      corroboration: corroboration(3),
      freshness: fresh,
      contradictionCount: 0,
      reviewStatus: 'MORE_RESEARCH_REQUESTED',
    });
    expect(result.decision).toBe('REQUIRES_REVIEW');
  });

  it('always states a reason', () => {
    for (const count of [0, 1, 2, 5]) {
      const result = decideEligibility({
        corroboration: corroboration(count),
        freshness: fresh,
        contradictionCount: 0,
      });
      expect(result.reason.length).toBeGreaterThan(10);
    }
  });
});
