export {
  assessFreshness,
  claimClusterKey,
  clusterClaims,
  corroborate,
  countIndependentSources,
  decideEligibility,
  detectContradictions,
  extractNumbers,
} from './verify';
export type { CorroborationOptions, EligibilityInput, FreshnessOptions } from './verify';
export type {
  ClaimCluster,
  ClaimConfidenceLevel,
  ClaimContradiction,
  ClaimContradictionKind,
  ClaimCorroborationResult,
  ClaimFreshnessResult,
  ClaimFreshnessStatus,
  ClaimInput,
  ClaimReviewAction,
  ClaimReviewQueueItem,
  ClaimReviewStatus,
  ClaimSupport,
  ClaimVerificationStatus,
  EvidenceEligibilityDecision,
  EvidenceEligibilityResult,
} from './types';
