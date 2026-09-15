import { measured, unavailable } from '@spectra/analytics-core';
import { trendScoreResultSchema } from '@spectra/contracts';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ENGAGEMENT_REFERENCE_RATE,
  measuredEngagementSignal,
  withMeasuredEngagement,
} from './engagement';
import {
  DEFAULT_TREND_SCORING_CONFIG,
  InvalidScoringInputError,
  WeightedTrendScoringEngine,
  type TrendScoringInput,
} from './scoring';

const CANDIDATE_ID = '99999999-9999-4999-8999-999999999999';
const FIXED_NOW = () => new Date('2026-09-14T12:00:00.000Z');
const engine = new WeightedTrendScoringEngine(DEFAULT_TREND_SCORING_CONFIG);

/** A research-only input: what the pipeline scores from findings. */
const research: TrendScoringInput = {
  trendCandidateId: CANDIDATE_ID,
  components: { freshness: 0.8, velocity: 0.6, sourceDiversity: 0.5, sourceCredibility: 0.7 },
  sourceCount: 4,
};

const post = (views: number | null, likes: number | null) => ({
  metrics: [
    views === null
      ? unavailable('views', 'MISSING_SCOPE', 'needs youtube.readonly')
      : measured('views', views, { sourceMetricName: 'statistics.viewCount' }),
    likes === null
      ? unavailable('likes', 'NOT_REPORTED', 'left out')
      : measured('likes', likes, { sourceMetricName: 'statistics.likeCount' }),
  ],
});

describe('measured engagement in trend scoring', () => {
  it('missing analytics do not become zero engagement: the score is exactly the research score', () => {
    const baseline = engine.score(research, FIXED_NOW);
    const signal = measuredEngagementSignal([]);
    expect(signal.available).toBe(false);
    const withSignal = engine.score(withMeasuredEngagement(research, signal), FIXED_NOW);

    expect(withSignal.normalizedScore).toBe(baseline.normalizedScore);
    expect(withSignal.components.map((c) => c.key)).not.toContain('measuredEngagement');
    expect(withSignal.unavailableSignals).toEqual([
      expect.objectContaining({
        key: 'measuredEngagement',
        source: 'UNAVAILABLE',
        reason: 'CONTENT_NOT_PUBLISHED',
      }),
    ]);
    expect(withSignal.explanation.reasoning.join(' ')).toContain('not treated as zero');
    expect(trendScoreResultSchema.parse(withSignal)).toBeTruthy();
  });

  it('a zero-engagement stand-in WOULD have lowered the score — which is why it is never used', () => {
    const baseline = engine.score(research, FIXED_NOW);
    const fakeZero = engine.score(
      { ...research, components: { ...research.components, measuredEngagement: 0 } },
      FIXED_NOW,
    );
    expect(fakeZero.normalizedScore).toBeLessThan(baseline.normalizedScore);
  });

  it('posts with analytics but no denominator are unavailable, not zero', () => {
    const signal = measuredEngagementSignal([post(null, 40), post(null, 12)]);
    expect(signal.available).toBe(false);
    if (!signal.available) {
      expect(signal.reason).toBe('DENOMINATOR_UNKNOWN');
      expect(signal.detail).toContain('2 post(s)');
    }
    const scored = engine.score(withMeasuredEngagement(research, signal), FIXED_NOW);
    expect(scored.normalizedScore).toBe(engine.score(research, FIXED_NOW).normalizedScore);
  });

  it('real measured engagement participates, labelled EXTERNAL_MEASURED', () => {
    const signal = measuredEngagementSignal([post(1000, 60), post(1000, 40), post(null, 999)]);
    expect(signal.available).toBe(true);
    if (!signal.available) return;
    // Pooled: (60 + 40) / (1000 + 1000); the post with no views is left out.
    expect(signal.rate).toBeCloseTo(0.05);
    expect(signal.sampleSize).toBe(2);
    expect(signal.value).toBeCloseTo(0.05 / DEFAULT_ENGAGEMENT_REFERENCE_RATE);

    const scored = engine.score(withMeasuredEngagement(research, signal), FIXED_NOW);
    const component = scored.components.find((c) => c.key === 'measuredEngagement');
    expect(component?.source).toBe('EXTERNAL_MEASURED');
    expect(component?.rationale).toContain('platform analytics');
    expect(scored.unavailableSignals).toBeUndefined();
    expect(scored.normalizedScore).toBeGreaterThan(
      engine.score(research, FIXED_NOW).normalizedScore,
    );
  });

  it('keeps the estimated engagementPotential separate from measured engagement', () => {
    const signal = measuredEngagementSignal([post(1000, 10)]);
    const scored = engine.score(
      withMeasuredEngagement(
        {
          ...research,
          components: { ...research.components, engagementPotential: 0.9 },
          sources: { engagementPotential: 'ESTIMATED' },
        },
        signal,
      ),
      FIXED_NOW,
    );
    const estimated = scored.components.find((c) => c.key === 'engagementPotential');
    const measuredComponent = scored.components.find((c) => c.key === 'measuredEngagement');
    expect(estimated?.source).toBe('ESTIMATED');
    expect(estimated?.rawValue).toBe(0.9);
    expect(measuredComponent?.source).toBe('EXTERNAL_MEASURED');
    expect(measuredComponent?.rawValue).toBeCloseTo(0.2);
  });

  it('refuses a component that is claimed both observed and unavailable', () => {
    expect(() =>
      engine.score(
        {
          ...research,
          components: { ...research.components, measuredEngagement: 0 },
          unavailableSignals: [{ key: 'measuredEngagement', reason: 'NOT_REPORTED', detail: 'x' }],
        },
        FIXED_NOW,
      ),
    ).toThrow(InvalidScoringInputError);
  });
});
