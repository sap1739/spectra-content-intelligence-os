import { z } from 'zod';

import {
  auditTimestampsSchema,
  geographySchema,
  isoDateTimeSchema,
  languageCodeSchema,
  scoreSchema,
  tenantScopeSchema,
  uuidSchema,
} from './common';

/**
 * Trend intelligence contracts. Scores are configurable, versioned and always
 * explainable — the UI must be able to show why a trend received its score.
 * See docs/TREND_SCORING_ARCHITECTURE.md.
 */

export const TREND_STATES = [
  'EMERGING',
  'ACCELERATING',
  'PEAKING',
  'STABLE',
  'DECLINING',
  'SEASONAL',
  'EVERGREEN',
  'UNVERIFIED',
  'REJECTED',
] as const;

export const trendStateSchema = z.enum(TREND_STATES);
export type TrendState = z.infer<typeof trendStateSchema>;

export const trendSignalTypeSchema = z.enum([
  'SEARCH_VOLUME',
  'SOCIAL_MENTIONS',
  'NEWS_COVERAGE',
  'COMMUNITY_DISCUSSION',
  'VIDEO_VIEWS',
  'PUBLICATION_FREQUENCY',
  'CUSTOM',
]);

export const trendSignalSchema = z
  .object({
    id: uuidSchema,
    providerId: z.string().min(1),
    signalType: trendSignalTypeSchema,
    topic: z.string().min(1).max(500),
    value: z.number(),
    unit: z.string().max(50).nullish(),
    observedAt: isoDateTimeSchema,
    windowStart: isoDateTimeSchema.nullish(),
    windowEnd: isoDateTimeSchema.nullish(),
    geography: geographySchema.nullish(),
    language: languageCodeSchema.nullish(),
    sourceRef: z.string().max(1000).nullish(),
  })
  .merge(tenantScopeSchema);
export type TrendSignal = z.infer<typeof trendSignalSchema>;

/**
 * Every dimension a trend score may consider. The active scoring configuration
 * decides which components participate and with what weight.
 */
export const TREND_SCORE_COMPONENT_KEYS = [
  'freshness',
  'velocity',
  'searchInterest',
  'sourceDiversity',
  'sourceCredibility',
  'audienceRelevance',
  'brandRelevance',
  'geographicRelevance',
  'engagementPotential',
  'commercialIntent',
  'novelty',
  'seasonality',
  'saturation',
  'misinformationRisk',
  'complianceRisk',
] as const;

export const trendScoreComponentKeySchema = z.enum(TREND_SCORE_COMPONENT_KEYS);
export type TrendScoreComponentKey = z.infer<typeof trendScoreComponentKeySchema>;

export const trendScoreComponentSchema = z.object({
  key: trendScoreComponentKeySchema,
  rawValue: z.number(),
  /** Value normalized into [0, 1] before weighting. */
  normalizedValue: scoreSchema,
  weight: z.number(),
  /** normalizedValue × weight (negative for penalty components). */
  weightedValue: z.number(),
  rationale: z.string().max(2000).optional(),
});
export type TrendScoreComponent = z.infer<typeof trendScoreComponentSchema>;

/** Per-component weights; omitted components do not participate. */
export const trendScoringWeightsSchema = z
  .object({
    freshness: z.number().optional(),
    velocity: z.number().optional(),
    searchInterest: z.number().optional(),
    sourceDiversity: z.number().optional(),
    sourceCredibility: z.number().optional(),
    audienceRelevance: z.number().optional(),
    brandRelevance: z.number().optional(),
    geographicRelevance: z.number().optional(),
    engagementPotential: z.number().optional(),
    commercialIntent: z.number().optional(),
    novelty: z.number().optional(),
    seasonality: z.number().optional(),
    saturation: z.number().optional(),
    misinformationRisk: z.number().optional(),
    complianceRisk: z.number().optional(),
  })
  .strict();
export type TrendScoringWeights = z.infer<typeof trendScoringWeightsSchema>;

/** Versioned, configurable formula — never hard-coded permanently. */
export const trendScoringConfigSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  /** Positive weights contribute; components listed in `penalties` subtract. */
  weights: trendScoringWeightsSchema,
  penalties: z.array(trendScoreComponentKeySchema).default([]),
  /** Minimum distinct sources before a candidate may leave UNVERIFIED. */
  minimumSourceCount: z.number().int().min(1).default(2),
  createdAt: isoDateTimeSchema,
});
export type TrendScoringConfig = z.infer<typeof trendScoringConfigSchema>;

export const trendExplanationSchema = z.object({
  headline: z.string().max(500),
  reasoning: z.array(z.string().max(1000)).default([]),
  topContributors: z
    .array(
      z.object({
        key: trendScoreComponentKeySchema,
        contribution: z.number(),
      }),
    )
    .default([]),
  riskFlags: z.array(z.string().max(500)).default([]),
});
export type TrendExplanation = z.infer<typeof trendExplanationSchema>;

export const trendScoreResultSchema = z.object({
  trendCandidateId: uuidSchema,
  configId: z.string().min(1),
  configVersion: z.string().min(1),
  /** Final normalized score in [0, 1]. */
  normalizedScore: scoreSchema,
  /** Display score 0–100 derived from normalizedScore. */
  displayScore: z.number().min(0).max(100),
  components: z.array(trendScoreComponentSchema),
  explanation: trendExplanationSchema,
  computedAt: isoDateTimeSchema,
});
export type TrendScoreResult = z.infer<typeof trendScoreResultSchema>;

export const trendCandidateSchema = z
  .object({
    id: uuidSchema,
    projectId: uuidSchema.nullish(),
    verticalId: uuidSchema.nullish(),
    clusterId: uuidSchema.nullish(),
    title: z.string().min(1).max(500),
    summary: z.string().max(5000).nullish(),
    state: trendStateSchema,
    signalIds: z.array(uuidSchema).default([]),
    sourceIds: z.array(uuidSchema).default([]),
    findingIds: z.array(uuidSchema).default([]),
    latestScore: trendScoreResultSchema.nullish(),
    firstSeenAt: isoDateTimeSchema.nullish(),
    lastSeenAt: isoDateTimeSchema.nullish(),
  })
  .merge(tenantScopeSchema)
  .merge(auditTimestampsSchema);
export type TrendCandidate = z.infer<typeof trendCandidateSchema>;

export const trendClusterSchema = z
  .object({
    id: uuidSchema,
    label: z.string().min(1).max(300),
    keywords: z.array(z.string().max(200)).default([]),
    candidateIds: z.array(uuidSchema).default([]),
  })
  .merge(tenantScopeSchema);
export type TrendCluster = z.infer<typeof trendClusterSchema>;

export const trendLifecycleEventSchema = z.object({
  trendCandidateId: uuidSchema,
  state: trendStateSchema,
  previousState: trendStateSchema.nullish(),
  enteredAt: isoDateTimeSchema,
  reason: z.string().max(2000).nullish(),
});
export type TrendLifecycleEvent = z.infer<typeof trendLifecycleEventSchema>;

export const trendAlertTypeSchema = z.enum([
  'STATE_CHANGE',
  'SCORE_THRESHOLD',
  'NEW_EVIDENCE',
  'RISK_FLAG',
]);

export const trendAlertSchema = z
  .object({
    id: uuidSchema,
    watchlistId: uuidSchema.nullish(),
    trendCandidateId: uuidSchema,
    alertType: trendAlertTypeSchema,
    message: z.string().min(1).max(2000),
    triggeredAt: isoDateTimeSchema,
    acknowledgedAt: isoDateTimeSchema.nullish(),
    acknowledgedById: uuidSchema.nullish(),
  })
  .merge(tenantScopeSchema);
export type TrendAlert = z.infer<typeof trendAlertSchema>;

export const trendWatchlistSchema = z
  .object({
    id: uuidSchema,
    name: z.string().min(1).max(300),
    verticalId: uuidSchema.nullish(),
    keywords: z.array(z.string().max(200)).default([]),
    trendCandidateIds: z.array(uuidSchema).default([]),
    alertRules: z
      .array(
        z.object({
          alertType: trendAlertTypeSchema,
          threshold: z.number().optional(),
        }),
      )
      .default([]),
    createdById: uuidSchema.nullish(),
  })
  .merge(tenantScopeSchema)
  .merge(auditTimestampsSchema);
export type TrendWatchlist = z.infer<typeof trendWatchlistSchema>;
