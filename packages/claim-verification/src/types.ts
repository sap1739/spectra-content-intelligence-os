/**
 * Claim verification contracts (ADR-0032).
 *
 * The layer that decides whether research evidence is strong enough to ground
 * generated content — and, when it is not, says so rather than quietly using it
 * anyway.
 */

export type ClaimVerificationStatus =
  'UNVERIFIED' | 'CORROBORATED' | 'DISPUTED' | 'VERIFIED' | 'REJECTED';

export type ClaimConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'CONTESTED' | 'UNKNOWN';

export type ClaimFreshnessStatus = 'CURRENT' | 'AGING' | 'STALE' | 'EVERGREEN' | 'UNKNOWN';

export type EvidenceEligibilityDecision = 'ELIGIBLE' | 'WEAK' | 'REQUIRES_REVIEW' | 'BLOCKED';

export type ClaimReviewStatus =
  'NOT_REQUIRED' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'MORE_RESEARCH_REQUESTED';

export type ClaimReviewAction = 'APPROVE' | 'REJECT' | 'REQUEST_MORE_RESEARCH';

export type ClaimContradictionKind = 'NUMERIC_CONFLICT' | 'NEGATION' | 'DIRECTIONAL_CONFLICT';

/** One claim as it enters verification. */
export interface ClaimInput {
  id: string;
  text: string;
  normalizedKey: string;
  claimType: 'FACTUAL' | 'STATISTIC' | 'PREDICTION' | 'OPINION' | 'QUOTE';
  /** Sources supporting this claim, one entry per supporting source. */
  supports: ClaimSupport[];
  evergreen?: boolean;
}

/**
 * A single source backing a claim.
 *
 * `syndicationKey` is what makes corroboration honest: sources sharing one are
 * copies of a single story, and together count once.
 */
export interface ClaimSupport {
  sourceId: string;
  /** duplicateClusterKey / duplicateOfSourceId from the pipeline (ADR-0030). */
  syndicationKey: string | null;
  publisher: string | null;
  /** Snippet-derived support is real but weaker (ADR-0030). */
  snippetOnly: boolean;
  credibilityScore: number | null;
  /** Publication date of the source, when it stated one. */
  publishedAt: Date | null;
  citationId?: string;
}

/** A group of claims asserting the same thing across sources. */
export interface ClaimCluster {
  clusterKey: string;
  claimIds: string[];
  /** Distinct independent (non-syndicated) sources across the whole cluster. */
  independentSourceCount: number;
  /** Distinct publishers, ignoring syndication. */
  sourceDiversity: number;
}

export interface ClaimCorroborationResult {
  claimId: string;
  /** Every supporting source, syndicated copies included. */
  corroborationCount: number;
  /** Supporting sources after collapsing syndicated copies — the real number. */
  independentSourceCount: number;
  supportingCitationIds: string[];
  /** Distinct publishers behind the independent sources. */
  sourceDiversity: number;
  /** True when every support is snippet-only. */
  snippetOnlyEvidence: boolean;
  confidenceLevel: ClaimConfidenceLevel;
  verificationStatus: ClaimVerificationStatus;
}

export interface ClaimContradiction {
  claimId: string;
  conflictingClaimId: string;
  kind: ClaimContradictionKind;
  /** What specifically conflicts. Always concrete. */
  detail: string;
}

export interface ClaimFreshnessResult {
  status: ClaimFreshnessStatus;
  /** Publication date of the newest supporting source. */
  latestSupportAt: Date | null;
  ageDays: number | null;
  /** True for claim types whose truth decays (statistics, predictions). */
  timeSensitive: boolean;
}

export interface EvidenceEligibilityResult {
  decision: EvidenceEligibilityDecision;
  /** Always populated — a decision without a reason is not reviewable. */
  reason: string;
  /** True when the decision demands a human before the claim can be used. */
  requiresReview: boolean;
}

export interface ClaimReviewQueueItem {
  claimId: string;
  text: string;
  decision: EvidenceEligibilityDecision;
  reason: string;
  confidenceLevel: ClaimConfidenceLevel;
  freshnessStatus: ClaimFreshnessStatus;
  independentSourceCount: number;
  contradictionCount: number;
  reviewStatus: ClaimReviewStatus;
}
