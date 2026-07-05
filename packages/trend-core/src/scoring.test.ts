import { describe, expect, it } from 'vitest';

import { canTransitionTrend } from './lifecycle';
import {
  DEFAULT_TREND_SCORING_CONFIG,
  InvalidScoringInputError,
  WeightedTrendScoringEngine,
} from './scoring';

const CANDIDATE_ID = '99999999-9999-4999-8999-999999999999';
const FIXED_NOW = () => new Date('2026-07-01T12:00:00.000Z');

describe('WeightedTrendScoringEngine', () => {
  const engine = new WeightedTrendScoringEngine(DEFAULT_TREND_SCORING_CONFIG);

  it('produces a deterministic, versioned, explainable score', () => {
    const result = engine.score(
      {
        trendCandidateId: CANDIDATE_ID,
        components: {
          freshness: 0.9,
          velocity: 0.8,
          sourceCredibility: 0.7,
          audienceRelevance: 0.6,
        },
        sourceCount: 5,
      },
      FIXED_NOW,
    );

    expect(result.configId).toBe('spectra-default');
    expect(result.configVersion).toBe('1.0.0');
    expect(result.computedAt).toBe('2026-07-01T12:00:00.000Z');
    expect(result.normalizedScore).toBeGreaterThan(0.6);
    expect(result.normalizedScore).toBeLessThanOrEqual(1);
    expect(result.displayScore).toBeCloseTo(result.normalizedScore * 100, 1);
    expect(result.explanation.topContributors.length).toBeGreaterThan(0);
    expect(result.explanation.reasoning.length).toBe(result.components.length);

    // Same input → same output.
    const repeat = engine.score(
      {
        trendCandidateId: CANDIDATE_ID,
        components: {
          freshness: 0.9,
          velocity: 0.8,
          sourceCredibility: 0.7,
          audienceRelevance: 0.6,
        },
        sourceCount: 5,
      },
      FIXED_NOW,
    );
    expect(repeat).toEqual(result);
  });

  it('applies penalty components as subtractions with risk flags', () => {
    const clean = engine.score(
      { trendCandidateId: CANDIDATE_ID, components: { freshness: 0.8, velocity: 0.8 } },
      FIXED_NOW,
    );
    const risky = engine.score(
      {
        trendCandidateId: CANDIDATE_ID,
        components: { freshness: 0.8, velocity: 0.8, misinformationRisk: 0.9 },
      },
      FIXED_NOW,
    );
    expect(risky.normalizedScore).toBeLessThan(clean.normalizedScore);
    expect(risky.explanation.riskFlags.some((f) => f.includes('misinformationRisk'))).toBe(true);
  });

  it('flags insufficient evidence based on the config minimum', () => {
    const result = engine.score(
      { trendCandidateId: CANDIDATE_ID, components: { freshness: 0.9 }, sourceCount: 1 },
      FIXED_NOW,
    );
    expect(result.explanation.riskFlags.some((f) => f.includes('UNVERIFIED'))).toBe(true);
  });

  it('rejects out-of-range component values', () => {
    expect(() =>
      engine.score({ trendCandidateId: CANDIDATE_ID, components: { freshness: 1.5 } }, FIXED_NOW),
    ).toThrow(InvalidScoringInputError);
  });

  it('rejects scoring with no positive components', () => {
    expect(() =>
      engine.score(
        { trendCandidateId: CANDIDATE_ID, components: { misinformationRisk: 0.2 } },
        FIXED_NOW,
      ),
    ).toThrow(InvalidScoringInputError);
  });

  it('supports alternative configurations without code changes', () => {
    const custom = new WeightedTrendScoringEngine({
      ...DEFAULT_TREND_SCORING_CONFIG,
      id: 'brand-heavy',
      version: '2.0.0',
      weights: { brandRelevance: 1 },
      penalties: [],
    });
    const result = custom.score(
      { trendCandidateId: CANDIDATE_ID, components: { brandRelevance: 0.5 } },
      FIXED_NOW,
    );
    expect(result.normalizedScore).toBeCloseTo(0.5, 5);
    expect(result.configId).toBe('brand-heavy');
  });
});

describe('trend lifecycle', () => {
  it('starts UNVERIFIED and cannot resurrect REJECTED trends', () => {
    expect(canTransitionTrend('UNVERIFIED', 'EMERGING')).toBe(true);
    expect(canTransitionTrend('UNVERIFIED', 'PEAKING')).toBe(false);
    expect(canTransitionTrend('REJECTED', 'EMERGING')).toBe(false);
  });

  it('models the growth curve', () => {
    expect(canTransitionTrend('EMERGING', 'ACCELERATING')).toBe(true);
    expect(canTransitionTrend('ACCELERATING', 'PEAKING')).toBe(true);
    expect(canTransitionTrend('PEAKING', 'DECLINING')).toBe(true);
  });
});
