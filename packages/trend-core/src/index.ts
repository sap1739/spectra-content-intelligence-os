export {
  DEFAULT_TREND_SCORING_CONFIG,
  InvalidScoringInputError,
  WeightedTrendScoringEngine,
} from './scoring';
export type { TrendScoringEngine, TrendScoringInput } from './scoring';
export { TREND_STATE_TRANSITIONS, canTransitionTrend } from './lifecycle';
export {
  DEFAULT_ENGAGEMENT_REFERENCE_RATE,
  measuredEngagementSignal,
  withMeasuredEngagement,
} from './engagement';
export type { MeasuredEngagementSignal } from './engagement';
