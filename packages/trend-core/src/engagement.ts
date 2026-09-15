import { aggregateMetrics } from '@spectra/analytics-core';
import type {
  AnalyticsMetric,
  AnalyticsUnavailableReason,
  TrendScoreComponentKey,
} from '@spectra/contracts';

import type { TrendScoringInput } from './scoring';

/**
 * Measured engagement as a trend-score signal (ADR-0039).
 *
 * `engagementPotential` is an ESTIMATE from research and stays exactly that.
 * `measuredEngagement` is what platforms actually reported for the workspace's
 * own published posts on the topic. The two are separate components with
 * separate source labels, and a topic with no measured engagement simply does
 * not get the component — it is never scored as zero engagement, and the
 * research-based score is left exactly as it would have been.
 */

/**
 * The engagement rate treated as "strong" (maps to 1.0). This is a Spectra
 * calibration constant, not a platform fact: it is configuration, versioned
 * with the scoring config, and shown in every rationale.
 */
export const DEFAULT_ENGAGEMENT_REFERENCE_RATE = 0.05;

export type MeasuredEngagementSignal =
  | {
      available: true;
      source: 'EXTERNAL_MEASURED';
      /** Normalized [0, 1] for the scoring engine. */
      value: number;
      /** The pooled engagement rate it came from. */
      rate: number;
      /** Posts whose snapshots reported both interactions and a denominator. */
      sampleSize: number;
      rationale: string;
    }
  | {
      available: false;
      source: 'UNAVAILABLE';
      reason: AnalyticsUnavailableReason;
      detail: string;
    };

/**
 * Pools the latest snapshot of each published post on a topic into one
 * engagement rate. Only snapshots that reported a denominator participate;
 * when none did, the signal is UNAVAILABLE with the reason.
 */
export function measuredEngagementSignal(
  latestPostSnapshots: ReadonlyArray<{ metrics: readonly AnalyticsMetric[] }>,
  options: { referenceRate?: number } = {},
): MeasuredEngagementSignal {
  const referenceRate = options.referenceRate ?? DEFAULT_ENGAGEMENT_REFERENCE_RATE;
  if (latestPostSnapshots.length === 0) {
    return {
      available: false,
      source: 'UNAVAILABLE',
      reason: 'CONTENT_NOT_PUBLISHED',
      detail:
        'No published post on this topic has platform analytics yet, so measured engagement is unavailable — not zero.',
    };
  }
  const [rate] = aggregateMetrics(latestPostSnapshots, ['engagementRate']);
  if (!rate || rate.value === null) {
    return {
      available: false,
      source: 'UNAVAILABLE',
      reason: rate?.unavailableReason ?? 'DENOMINATOR_UNKNOWN',
      detail: `${latestPostSnapshots.length} post(s) on this topic have analytics, but none reported both interactions and impressions or views, so no engagement rate can be measured.`,
    };
  }
  const value = Math.min(1, Math.max(0, rate.value / referenceRate));
  return {
    available: true,
    source: 'EXTERNAL_MEASURED',
    value,
    rate: rate.value,
    sampleSize: rate.contributing,
    rationale: `Measured engagement ${(rate.value * 100).toFixed(2)}% across ${rate.contributing} published post(s) (platform analytics), scaled against a ${(referenceRate * 100).toFixed(1)}% reference rate.`,
  };
}

/**
 * Adds a measured-engagement signal to a scoring input: as an EXTERNAL_MEASURED
 * component when available, otherwise as an unavailable signal that does not
 * participate in the score at all.
 */
export function withMeasuredEngagement(
  input: TrendScoringInput,
  signal: MeasuredEngagementSignal,
): TrendScoringInput {
  const key: TrendScoreComponentKey = 'measuredEngagement';
  if (signal.available) {
    return {
      ...input,
      components: { ...input.components, [key]: signal.value },
      rationales: { ...input.rationales, [key]: signal.rationale },
      sources: { ...input.sources, [key]: signal.source },
    };
  }
  return {
    ...input,
    unavailableSignals: [
      ...(input.unavailableSignals ?? []),
      { key, reason: signal.reason, detail: signal.detail },
    ],
  };
}
