import {
  type TrendExplanation,
  type TrendScoreComponent,
  type TrendScoreComponentKey,
  type TrendScoreResult,
  type TrendScoringConfig,
} from '@spectra/contracts';

/**
 * TrendScoringEngine — the provider-neutral scoring port.
 *
 * The formula is configuration, not code: weights, penalties and thresholds
 * come from a versioned TrendScoringConfig. Every result embeds the config id
 * and version plus a component-level explanation, so any historical score can
 * be reproduced and displayed. See docs/TREND_SCORING_ARCHITECTURE.md.
 */

export interface TrendScoringInput {
  trendCandidateId: string;
  /** Raw component observations in [0, 1]; missing components are skipped. */
  components: Partial<Record<TrendScoreComponentKey, number>>;
  /** Optional human-readable rationale per component. */
  rationales?: Partial<Record<TrendScoreComponentKey, string>>;
  /** Distinct source count backing the candidate (evidence floor). */
  sourceCount?: number;
}

export interface TrendScoringEngine {
  readonly engineId: string;
  readonly config: TrendScoringConfig;
  score(input: TrendScoringInput, now?: () => Date): TrendScoreResult;
}

export class InvalidScoringInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidScoringInputError';
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Reference implementation: weighted linear combination with penalty
 * components subtracting from the score. Deterministic and dependency-free.
 */
export class WeightedTrendScoringEngine implements TrendScoringEngine {
  public readonly engineId = 'weighted-linear';

  constructor(public readonly config: TrendScoringConfig) {}

  score(input: TrendScoringInput, now: () => Date = () => new Date()): TrendScoreResult {
    const penalties = new Set(this.config.penalties);
    const components: TrendScoreComponent[] = [];

    let positiveWeightTotal = 0;
    let positiveSum = 0;
    let penaltySum = 0;

    for (const [key, weight] of Object.entries(this.config.weights) as Array<
      [TrendScoreComponentKey, number | undefined]
    >) {
      if (weight === undefined) continue;
      const raw = input.components[key];
      if (raw === undefined) continue;
      if (raw < 0 || raw > 1 || Number.isNaN(raw)) {
        throw new InvalidScoringInputError(`Component ${key} must be within [0, 1], got ${raw}`);
      }
      const isPenalty = penalties.has(key);
      const normalized = clamp01(raw);
      const weightedValue = isPenalty ? -(normalized * weight) : normalized * weight;
      components.push({
        key,
        rawValue: raw,
        normalizedValue: normalized,
        weight: isPenalty ? -weight : weight,
        weightedValue,
        ...(input.rationales?.[key] ? { rationale: input.rationales[key] } : {}),
      });
      if (isPenalty) {
        penaltySum += normalized * weight;
      } else {
        positiveWeightTotal += weight;
        positiveSum += normalized * weight;
      }
    }

    if (positiveWeightTotal === 0) {
      throw new InvalidScoringInputError(
        'No positive-weight components were provided — cannot compute a score',
      );
    }

    const baseScore = positiveSum / positiveWeightTotal;
    const normalizedScore = clamp01(baseScore - penaltySum);

    const explanation = this.explain(components, normalizedScore, input);

    return {
      trendCandidateId: input.trendCandidateId,
      configId: this.config.id,
      configVersion: this.config.version,
      normalizedScore,
      displayScore: Math.round(normalizedScore * 1000) / 10,
      components: components.sort((a, b) => Math.abs(b.weightedValue) - Math.abs(a.weightedValue)),
      explanation,
      computedAt: now().toISOString(),
    };
  }

  private explain(
    components: TrendScoreComponent[],
    normalizedScore: number,
    input: TrendScoringInput,
  ): TrendExplanation {
    const sorted = [...components].sort(
      (a, b) => Math.abs(b.weightedValue) - Math.abs(a.weightedValue),
    );
    const topContributors = sorted.slice(0, 3).map((c) => ({
      key: c.key,
      contribution: Math.round(c.weightedValue * 1000) / 1000,
    }));

    const riskFlags: string[] = [];
    for (const component of components) {
      if (component.weight < 0 && component.normalizedValue >= 0.5) {
        riskFlags.push(
          `High ${component.key} (${component.normalizedValue.toFixed(2)}) reduced this score`,
        );
      }
    }
    const insufficientEvidence =
      input.sourceCount !== undefined && input.sourceCount < this.config.minimumSourceCount;
    if (insufficientEvidence) {
      riskFlags.push(
        `Only ${input.sourceCount} source(s) — below the minimum of ${this.config.minimumSourceCount}; candidate should remain UNVERIFIED`,
      );
    }

    const reasoning = sorted.map((c) => {
      const direction = c.weightedValue >= 0 ? 'contributed' : 'subtracted';
      return `${c.key} ${direction} ${Math.abs(c.weightedValue).toFixed(3)} (raw ${c.rawValue.toFixed(2)}, weight ${c.weight})`;
    });

    return {
      headline: `Scored ${(normalizedScore * 100).toFixed(1)}/100 using config ${this.config.id}@${this.config.version}`,
      reasoning,
      topContributors,
      riskFlags,
    };
  }
}

/**
 * Default Phase 1 configuration. This is a STARTING POINT, not a permanent
 * formula — configs are versioned and replaceable per tenant/vertical.
 */
export const DEFAULT_TREND_SCORING_CONFIG: TrendScoringConfig = {
  id: 'spectra-default',
  version: '1.0.0',
  name: 'Spectra default weighted scoring',
  description:
    'Balanced default: freshness/velocity/relevance weighted positively; misinformation and compliance risk as penalties.',
  weights: {
    freshness: 0.15,
    velocity: 0.15,
    searchInterest: 0.1,
    sourceDiversity: 0.1,
    sourceCredibility: 0.15,
    audienceRelevance: 0.15,
    brandRelevance: 0.1,
    geographicRelevance: 0.05,
    engagementPotential: 0.05,
    commercialIntent: 0.05,
    novelty: 0.05,
    saturation: 0.1,
    misinformationRisk: 0.3,
    complianceRisk: 0.3,
  },
  penalties: ['saturation', 'misinformationRisk', 'complianceRisk'],
  minimumSourceCount: 2,
  createdAt: '2026-07-01T00:00:00.000Z',
};
