import { domainOf } from './signals';

/**
 * Source-quality policy: freshness decay, credibility, evidence eligibility and
 * syndication-aware diversity (ADR-0030).
 *
 * The rule running through all of it: a source we could not fully retrieve, or
 * whose age we cannot judge, must not score like one we could. Missing
 * information produces a lower, labelled confidence — never a confident guess.
 */

const MS_PER_DAY = 86_400_000;

export type StalenessStatus = 'FRESH' | 'AGING' | 'STALE' | 'EVERGREEN' | 'UNKNOWN';
export type DomainStance = 'TRUSTED' | 'NEUTRAL' | 'BLOCKED';

/** Configurable decay. Defaults are deliberately conservative. */
export interface FreshnessDecayConfig {
  /** Score halves every this many days. */
  halfLifeDays: number;
  /** Below this age (days) a source counts as FRESH. */
  freshWithinDays: number;
  /** Beyond this age (days) a source counts as STALE. */
  staleAfterDays: number;
  /** Floor for dated sources, so ancient-but-relevant material is not zeroed. */
  minimumScore: number;
  /** Score used when no publication date was stated. */
  unknownDateScore: number;
  /** Evergreen sources hold this score regardless of age. */
  evergreenScore: number;
}

export const DEFAULT_FRESHNESS_DECAY: FreshnessDecayConfig = {
  halfLifeDays: 7,
  freshWithinDays: 3,
  staleAfterDays: 90,
  minimumScore: 0.05,
  // Not 0: an undated source is uncertain, not certainly old. Below FRESH,
  // above STALE, and reported as UNKNOWN so the uncertainty stays visible.
  unknownDateScore: 0.3,
  evergreenScore: 0.75,
};

export interface FreshnessResult {
  score: number;
  status: StalenessStatus;
  ageDays: number | null;
}

/**
 * Exponential decay with an explicit staleness label.
 *
 * `evergreen` sources (standards, legislation, documentation) hold a steady
 * score: their value genuinely does not decay, and decaying them would bury the
 * most authoritative material in a vertical.
 */
export function evaluateFreshness(
  publishedAt: Date | null,
  now: Date,
  options: { evergreen?: boolean; config?: Partial<FreshnessDecayConfig> } = {},
): FreshnessResult {
  const config = { ...DEFAULT_FRESHNESS_DECAY, ...options.config };

  if (options.evergreen) {
    return { score: config.evergreenScore, status: 'EVERGREEN', ageDays: ageIn(publishedAt, now) };
  }
  if (!publishedAt) {
    return { score: config.unknownDateScore, status: 'UNKNOWN', ageDays: null };
  }

  const ageDays = Math.max(0, (now.getTime() - publishedAt.getTime()) / MS_PER_DAY);
  const decayed = Math.exp((-Math.LN2 * ageDays) / config.halfLifeDays);
  const score = Math.max(config.minimumScore, Math.min(1, decayed));

  // Boundaries are inclusive at the young end: exactly `freshWithinDays` old is
  // still FRESH, exactly `staleAfterDays` old is already STALE.
  const status: StalenessStatus =
    ageDays <= config.freshWithinDays
      ? 'FRESH'
      : ageDays >= config.staleAfterDays
        ? 'STALE'
        : 'AGING';

  return { score, status, ageDays };
}

function ageIn(publishedAt: Date | null, now: Date): number | null {
  if (!publishedAt) return null;
  return Math.max(0, (now.getTime() - publishedAt.getTime()) / MS_PER_DAY);
}

/** One workspace domain rule, as stored by DomainPolicy. */
export interface DomainPolicyEntry {
  domain: string;
  stance: DomainStance;
  credibilityOverride: number | null;
  evergreen: boolean;
}

export interface DomainRuleSet {
  /** From the vertical. */
  trustedDomains: readonly string[];
  blockedDomains: readonly string[];
  /** Workspace-level policies; these take precedence over vertical lists. */
  policies: readonly DomainPolicyEntry[];
}

export interface DomainVerdict {
  domain: string;
  stance: DomainStance;
  credibility: number;
  evergreen: boolean;
  /** Where the verdict came from — shown in the UI, never inferred silently. */
  source: 'WORKSPACE_POLICY' | 'VERTICAL_LIST' | 'DEFAULT';
}

const CREDIBILITY_TRUSTED = 0.9;
const CREDIBILITY_NEUTRAL = 0.5;
const CREDIBILITY_BLOCKED = 0;

/** Does `domain` equal `rule`, or sit beneath it as a subdomain? */
function domainMatches(domain: string, rule: string): boolean {
  const d = domain.toLowerCase();
  const r = rule.toLowerCase().replace(/^www\./, '');
  return d === r || d.endsWith(`.${r}`);
}

/**
 * Resolves a domain's stance and credibility.
 *
 * Precedence: workspace policy beats vertical list beats default. Within the
 * vertical lists, BLOCKED beats TRUSTED — a domain an operator has explicitly
 * excluded stays excluded even if another list trusts it.
 */
export function evaluateDomain(rawUrl: string, rules: DomainRuleSet): DomainVerdict {
  const domain = domainOf(rawUrl);

  const policy = rules.policies.find((p) => domainMatches(domain, p.domain));
  if (policy) {
    const credibility =
      policy.credibilityOverride ??
      (policy.stance === 'TRUSTED'
        ? CREDIBILITY_TRUSTED
        : policy.stance === 'BLOCKED'
          ? CREDIBILITY_BLOCKED
          : CREDIBILITY_NEUTRAL);
    return {
      domain,
      stance: policy.stance,
      credibility,
      evergreen: policy.evergreen,
      source: 'WORKSPACE_POLICY',
    };
  }

  if (rules.blockedDomains.some((b) => domainMatches(domain, b))) {
    return {
      domain,
      stance: 'BLOCKED',
      credibility: CREDIBILITY_BLOCKED,
      evergreen: false,
      source: 'VERTICAL_LIST',
    };
  }
  if (rules.trustedDomains.some((t) => domainMatches(domain, t))) {
    return {
      domain,
      stance: 'TRUSTED',
      credibility: CREDIBILITY_TRUSTED,
      evergreen: false,
      source: 'VERTICAL_LIST',
    };
  }
  return {
    domain,
    stance: 'NEUTRAL',
    credibility: CREDIBILITY_NEUTRAL,
    evergreen: false,
    source: 'DEFAULT',
  };
}

export interface EligibilityInput {
  stance: DomainStance;
  snippetOnly: boolean;
  robotsDecision: 'ALLOWED' | 'DISALLOWED' | 'UNAVAILABLE' | 'NOT_CHECKED';
  injectionBlocked: boolean;
  isDuplicate: boolean;
}

export interface EligibilityVerdict {
  eligible: boolean;
  /** Null when eligible; otherwise the specific, operator-facing reason. */
  reason: string | null;
}

/**
 * Decides whether a source may be cited as evidence.
 *
 * Snippet-only sources remain ELIGIBLE but are down-weighted elsewhere: a
 * snippet is real, attributable evidence of a source's existence and gist, just
 * weaker than the full article. Excluding it entirely would discard genuine
 * findings; treating it as equal would overstate them.
 */
export function evaluateEligibility(input: EligibilityInput): EligibilityVerdict {
  if (input.stance === 'BLOCKED') {
    return {
      eligible: false,
      reason: 'The domain is blocked for this workspace, so it cannot be used as evidence.',
    };
  }
  if (input.injectionBlocked) {
    return {
      eligible: false,
      reason: 'Quarantined by the prompt-injection scan; its content is never used as evidence.',
    };
  }
  if (input.isDuplicate) {
    return {
      eligible: false,
      reason: 'Duplicate of an already-ingested source; the original carries the evidence.',
    };
  }
  return { eligible: true, reason: null };
}

/**
 * Diversity weight for one source.
 *
 * A syndicated wire story republished by ten outlets is ONE piece of evidence,
 * not ten independent corroborations. Cluster members share a single unit of
 * diversity so re-publication cannot inflate confidence.
 */
export function diversityWeightFor(clusterSize: number): number {
  if (clusterSize <= 1) return 1;
  return 1 / clusterSize;
}

/**
 * Confidence multiplier applied wherever a snippet-only source is scored.
 *
 * Chosen well below 1 so a page of snippets cannot out-weigh a single fully
 * retrieved article, and above 0 so genuine snippet findings still count.
 */
export const SNIPPET_ONLY_CONFIDENCE_FACTOR = 0.4;
