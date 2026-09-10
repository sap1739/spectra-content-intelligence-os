import type {
  ClaimCluster,
  ClaimContradiction,
  ClaimConfidenceLevel,
  ClaimCorroborationResult,
  ClaimFreshnessResult,
  ClaimInput,
  ClaimSupport,
  EvidenceEligibilityResult,
} from './types';

/**
 * Claim verification (ADR-0032).
 *
 * Turns "this sentence appeared in a source" into a defensible statement about
 * how well supported it is. Deterministic and explainable throughout — no model
 * is asked to judge truth, because a confident-sounding judgement we cannot
 * justify is worse than an honest "thinly supported".
 */

const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

/**
 * A claim's cluster identity: its salient content, independent of phrasing.
 *
 * Built from the numbers it asserts plus its distinctive words. Two outlets
 * reporting "adoption grew 40% in 2026" land in one cluster even with different
 * wording, so the second is corroboration of the first rather than a new claim.
 */
export function claimClusterKey(text: string): string {
  const numbers = extractNumbers(text);
  const terms = salientTerms(text);
  // Numbers first: they are the most discriminating part of a factual claim,
  // and two claims with different figures must not share a cluster.
  return [numbers.join('|'), terms.slice(0, 6).join('|')].join('::');
}

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'of',
  'to',
  'in',
  'on',
  'for',
  'with',
  'by',
  'from',
  'that',
  'this',
  'these',
  'those',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'has',
  'have',
  'had',
  'it',
  'its',
  'as',
  'at',
  'we',
  'they',
  'their',
  'our',
  'said',
  'says',
  'according',
  'percent',
  'per',
  'cent',
  'over',
  'about',
  'more',
  'than',
  'up',
  'down',
  'new',
  'also',
]);

function salientTerms(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s%.-]/g, ' ')
    .split(/\s+/)
    // Trim surrounding punctuation BEFORE the stop-word check: otherwise a
    // sentence-final "percent." survives as a salient term and two phrasings of
    // the same fact fall into different clusters.
    .map((w) => w.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w) && !/^\d/.test(w));
  return [...new Set(words)].sort();
}

/** Normalized numeric assertions, e.g. "40%" and "40 percent" → `40%`. */
export function extractNumbers(text: string): string[] {
  const found: string[] = [];
  const pattern =
    /(\d+(?:\.\d+)?)\s*(%|percent(?:age)?|million|billion|trillion|crore|lakh|x\b|times\b)?/gi;
  for (const match of text.matchAll(pattern)) {
    const value = match[1];
    if (!value) continue;
    const unitRaw = (match[2] ?? '').toLowerCase();
    // Bare years carry no magnitude — they are context, not the assertion.
    if (!unitRaw && /^(19|20)\d{2}$/.test(value)) continue;
    const unit = unitRaw.startsWith('percent') ? '%' : unitRaw;
    found.push(`${Number(value)}${unit}`);
  }
  return [...new Set(found)].sort();
}

/** Groups claims sharing a cluster key and measures each cluster's support. */
export function clusterClaims(claims: readonly ClaimInput[]): ClaimCluster[] {
  const byKey = new Map<string, ClaimInput[]>();
  for (const claim of claims) {
    const key = claimClusterKey(claim.text);
    const list = byKey.get(key) ?? [];
    list.push(claim);
    byKey.set(key, list);
  }

  return [...byKey.entries()].map(([clusterKey, members]) => {
    const supports = members.flatMap((m) => m.supports);
    return {
      clusterKey,
      claimIds: members.map((m) => m.id),
      independentSourceCount: countIndependentSources(supports),
      sourceDiversity: new Set(
        supports.map((s) => s.publisher?.toLowerCase() ?? `source:${s.sourceId}`),
      ).size,
    };
  });
}

/**
 * Counts supporting sources after collapsing syndication.
 *
 * This is the heart of honest corroboration. Ten outlets running one wire story
 * is ONE independent source: counting it as ten would make a single unverified
 * report look overwhelmingly corroborated, which is exactly the failure this
 * layer exists to prevent.
 */
export function countIndependentSources(supports: readonly ClaimSupport[]): number {
  const units = new Set<string>();
  for (const support of supports) {
    units.add(support.syndicationKey ?? `source:${support.sourceId}`);
  }
  return units.size;
}

// ---------------------------------------------------------------------------
// Corroboration
// ---------------------------------------------------------------------------

export interface CorroborationOptions {
  /** Independent sources needed for HIGH confidence. */
  strongThreshold?: number;
  /** Credibility at or above which a single source can reach MEDIUM. */
  credibleSourceThreshold?: number;
}

const DEFAULT_STRONG_THRESHOLD = 3;
const DEFAULT_CREDIBLE_THRESHOLD = 0.85;

/** Assesses how well one claim is supported. */
export function corroborate(
  claim: ClaimInput,
  options: CorroborationOptions = {},
): ClaimCorroborationResult {
  const strongThreshold = options.strongThreshold ?? DEFAULT_STRONG_THRESHOLD;
  const credibleThreshold = options.credibleSourceThreshold ?? DEFAULT_CREDIBLE_THRESHOLD;

  const independentSourceCount = countIndependentSources(claim.supports);
  const supportingCitationIds = [
    ...new Set(claim.supports.map((s) => s.citationId).filter((id): id is string => Boolean(id))),
  ];
  const snippetOnlyEvidence =
    claim.supports.length > 0 && claim.supports.every((s) => s.snippetOnly);
  const highestCredibility = claim.supports.reduce(
    (max, s) => Math.max(max, s.credibilityScore ?? 0),
    0,
  );

  let confidenceLevel: ClaimConfidenceLevel;
  if (independentSourceCount === 0) {
    confidenceLevel = 'UNKNOWN';
  } else if (independentSourceCount >= strongThreshold && !snippetOnlyEvidence) {
    confidenceLevel = 'HIGH';
  } else if (independentSourceCount >= 2 || highestCredibility >= credibleThreshold) {
    // Snippet-only support can never reach HIGH: we read a search summary, not
    // the article, so we cannot claim to have verified what it says.
    confidenceLevel = snippetOnlyEvidence && independentSourceCount < 2 ? 'LOW' : 'MEDIUM';
  } else {
    confidenceLevel = 'LOW';
  }

  return {
    claimId: claim.id,
    corroborationCount: claim.supports.length,
    independentSourceCount,
    supportingCitationIds,
    sourceDiversity: new Set(
      claim.supports.map((s) => s.publisher?.toLowerCase() ?? `source:${s.sourceId}`),
    ).size,
    snippetOnlyEvidence,
    confidenceLevel,
    verificationStatus: independentSourceCount >= 2 ? 'CORROBORATED' : 'UNVERIFIED',
  };
}

// ---------------------------------------------------------------------------
// Contradiction detection
// ---------------------------------------------------------------------------

const NEGATION_PATTERN =
  /\b(?:not|no|never|denies|denied|refutes?|refuted|disputes?|disputed|rejects?|rejected|false|incorrect)\b/i;
const INCREASE_PATTERN =
  /\b(?:grew|grow(?:s|ing)?|rose|rise|rising|increase[ds]?|up|surged?|gained?|climbed?)\b/i;
const DECREASE_PATTERN =
  /\b(?:fell|fall(?:s|ing)?|dropped?|declin(?:e|ed|ing)|decrease[ds]?|down|shrank|shrunk|lost)\b/i;

/**
 * Finds pairs of claims that cannot both be true.
 *
 * Deliberately conservative and explainable: it compares claims about the SAME
 * subject and flags a conflict only when the numbers differ materially, one
 * negates the other, or they assert opposite directions. It will miss subtler
 * contradictions — but everything it reports, it can explain, and it never
 * silently discards either side.
 */
export function detectContradictions(claims: readonly ClaimInput[]): ClaimContradiction[] {
  const found: ClaimContradiction[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < claims.length; i += 1) {
    for (let j = i + 1; j < claims.length; j += 1) {
      const a = claims[i] as ClaimInput;
      const b = claims[j] as ClaimInput;
      // Only compare claims about the same subject; different topics disagreeing
      // is not a contradiction.
      if (!sharesSubject(a.text, b.text)) continue;

      const contradiction = compareClaims(a, b);
      if (!contradiction) continue;

      const pairKey = [a.id, b.id].sort().join('::');
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);
      found.push(contradiction);
    }
  }
  return found;
}

/** Subject overlap: enough shared salient terms to be about the same thing. */
function sharesSubject(a: string, b: string): boolean {
  const termsA = new Set(salientTerms(a));
  const termsB = new Set(salientTerms(b));
  if (termsA.size === 0 || termsB.size === 0) return false;
  let shared = 0;
  for (const term of termsA) if (termsB.has(term)) shared += 1;
  // Jaccard-style: a decent share of the smaller claim's terms must match.
  return shared / Math.min(termsA.size, termsB.size) >= 0.5;
}

function compareClaims(a: ClaimInput, b: ClaimInput): ClaimContradiction | null {
  const numbersA = extractNumbers(a.text);
  const numbersB = extractNumbers(b.text);

  // Same subject, different figures of the same unit => numeric conflict.
  if (numbersA.length > 0 && numbersB.length > 0) {
    const unitsA = new Map(numbersA.map((n) => [unitOf(n), n]));
    for (const nb of numbersB) {
      const na = unitsA.get(unitOf(nb));
      if (na && na !== nb && materiallyDifferent(na, nb)) {
        return {
          claimId: a.id,
          conflictingClaimId: b.id,
          kind: 'NUMERIC_CONFLICT',
          detail: `Same subject reported as ${na} and ${nb}.`,
        };
      }
    }
  }

  const negA = NEGATION_PATTERN.test(a.text);
  const negB = NEGATION_PATTERN.test(b.text);
  if (negA !== negB) {
    return {
      claimId: a.id,
      conflictingClaimId: b.id,
      kind: 'NEGATION',
      detail: `One claim asserts what the other denies: "${truncate(negA ? b.text : a.text)}" vs "${truncate(negA ? a.text : b.text)}".`,
    };
  }

  const upA = INCREASE_PATTERN.test(a.text);
  const downA = DECREASE_PATTERN.test(a.text);
  const upB = INCREASE_PATTERN.test(b.text);
  const downB = DECREASE_PATTERN.test(b.text);
  if ((upA && downB && !downA && !upB) || (downA && upB && !upA && !downB)) {
    return {
      claimId: a.id,
      conflictingClaimId: b.id,
      kind: 'DIRECTIONAL_CONFLICT',
      detail: `Opposite directions reported for the same subject: "${truncate(a.text)}" vs "${truncate(b.text)}".`,
    };
  }

  return null;
}

function unitOf(normalized: string): string {
  return normalized.replace(/^[\d.]+/, '');
}

/**
 * Rounding differences are not contradictions. Two sources saying 40% and 41%
 * are agreeing; 40% and 25% are not.
 */
function materiallyDifferent(a: string, b: string): boolean {
  const va = Number.parseFloat(a);
  const vb = Number.parseFloat(b);
  if (!Number.isFinite(va) || !Number.isFinite(vb)) return a !== b;
  const larger = Math.max(Math.abs(va), Math.abs(vb));
  if (larger === 0) return false;
  return Math.abs(va - vb) / larger > 0.1;
}

function truncate(text: string, max = 80): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

export interface FreshnessOptions {
  currentWithinDays?: number;
  staleAfterDays?: number;
}

const DEFAULT_CURRENT_DAYS = 90;
const DEFAULT_STALE_DAYS = 365;

/** Claim types whose truth decays with time. */
const TIME_SENSITIVE_TYPES = new Set(['STATISTIC', 'PREDICTION']);

/**
 * Age standing for a claim, based on its NEWEST supporting source.
 *
 * Only time-sensitive claim types decay: a definition or a historical fact does
 * not become false because it was published three years ago, and marking it
 * stale would bury durable evidence.
 */
export function assessFreshness(
  claim: ClaimInput,
  now: Date,
  options: FreshnessOptions = {},
): ClaimFreshnessResult {
  const currentWithin = options.currentWithinDays ?? DEFAULT_CURRENT_DAYS;
  const staleAfter = options.staleAfterDays ?? DEFAULT_STALE_DAYS;
  const timeSensitive = TIME_SENSITIVE_TYPES.has(claim.claimType);

  const dates = claim.supports
    .map((s) => s.publishedAt)
    .filter((d): d is Date => d instanceof Date && !Number.isNaN(d.getTime()));
  const latestSupportAt = dates.length
    ? new Date(Math.max(...dates.map((d) => d.getTime())))
    : null;

  if (claim.evergreen) {
    return { status: 'EVERGREEN', latestSupportAt, ageDays: null, timeSensitive };
  }
  if (!latestSupportAt) {
    // No dated support: we cannot judge age, and must not pretend it is current.
    return { status: 'UNKNOWN', latestSupportAt: null, ageDays: null, timeSensitive };
  }

  const ageDays = Math.max(0, (now.getTime() - latestSupportAt.getTime()) / MS_PER_DAY);
  if (!timeSensitive) {
    return { status: 'CURRENT', latestSupportAt, ageDays, timeSensitive };
  }

  const status = ageDays <= currentWithin ? 'CURRENT' : ageDays >= staleAfter ? 'STALE' : 'AGING';
  return { status, latestSupportAt, ageDays, timeSensitive };
}

// ---------------------------------------------------------------------------
// Evidence eligibility
// ---------------------------------------------------------------------------

export interface EligibilityInput {
  corroboration: ClaimCorroborationResult;
  freshness: ClaimFreshnessResult;
  contradictionCount: number;
  /** A human decision already recorded for this claim, if any. */
  reviewStatus?: 'NOT_REQUIRED' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'MORE_RESEARCH_REQUESTED';
}

/**
 * Decides whether a claim may ground generated content.
 *
 * Order matters: a human decision beats an automated one, contradictions beat
 * corroboration, and "no supporting citation" is fatal regardless of anything
 * else — content must never cite evidence that does not exist.
 */
export function decideEligibility(input: EligibilityInput): EvidenceEligibilityResult {
  const { corroboration, freshness, contradictionCount } = input;

  // A reviewer's decision is authoritative.
  if (input.reviewStatus === 'REJECTED') {
    return {
      decision: 'BLOCKED',
      reason: 'A reviewer rejected this claim, so it cannot ground generated content.',
      requiresReview: false,
    };
  }
  if (input.reviewStatus === 'APPROVED') {
    return {
      decision: 'ELIGIBLE',
      reason: 'A reviewer approved this claim despite its automated assessment.',
      requiresReview: false,
    };
  }
  if (input.reviewStatus === 'MORE_RESEARCH_REQUESTED') {
    return {
      decision: 'REQUIRES_REVIEW',
      reason: 'A reviewer asked for more research before this claim is used.',
      requiresReview: true,
    };
  }

  // No support at all: never usable. Citing it would mean fabricating support.
  if (corroboration.independentSourceCount === 0) {
    return {
      decision: 'BLOCKED',
      reason: 'No supporting source is recorded for this claim, so it cannot be cited.',
      requiresReview: false,
    };
  }

  // Conflicting evidence is surfaced, never silently resolved in either
  // direction — picking a side automatically is how a tool launders a
  // disagreement into a fact.
  if (contradictionCount > 0) {
    return {
      decision: 'REQUIRES_REVIEW',
      reason: `This claim conflicts with ${contradictionCount} other claim(s) in the same project. A human must decide which stands before it is used.`,
      requiresReview: true,
    };
  }

  if (freshness.status === 'STALE') {
    return {
      decision: 'REQUIRES_REVIEW',
      reason: `The newest supporting source is ${Math.round(freshness.ageDays ?? 0)} days old and this is a time-sensitive claim. Confirm it still holds before using it.`,
      requiresReview: true,
    };
  }

  if (corroboration.independentSourceCount === 1) {
    return {
      decision: 'WEAK',
      reason: corroboration.snippetOnlyEvidence
        ? 'Supported by a single source, and only by a search snippet rather than the full page.'
        : 'Supported by a single source, so it is not independently corroborated.',
      requiresReview: false,
    };
  }

  if (corroboration.snippetOnlyEvidence) {
    return {
      decision: 'WEAK',
      reason:
        'Every supporting source is snippet-only — the full pages were never retrieved, so the support is thin.',
      requiresReview: false,
    };
  }

  if (freshness.status === 'AGING') {
    return {
      decision: 'WEAK',
      reason: `Corroborated by ${corroboration.independentSourceCount} independent sources, but the newest is ${Math.round(freshness.ageDays ?? 0)} days old.`,
      requiresReview: false,
    };
  }

  return {
    decision: 'ELIGIBLE',
    reason: `Corroborated by ${corroboration.independentSourceCount} independent sources.`,
    requiresReview: false,
  };
}
