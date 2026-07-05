export {
  DEFAULT_TREND_SCORING_CONFIG,
  InvalidScoringInputError,
  WeightedTrendScoringEngine,
} from './scoring';
export type { TrendScoringEngine, TrendScoringInput } from './scoring';
export { TREND_STATE_TRANSITIONS, canTransitionTrend } from './lifecycle';
