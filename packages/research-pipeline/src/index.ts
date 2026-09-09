export { FirstPartyRssProvider, parseFeed } from './rss';
export { HtmlExtractionProvider } from './extraction';
export { decodeEntities, htmlToText } from './html-text';
export { normalizeUrl, sha256Hex, titleKey, urlHash } from './hashing';
export { FetchLimitError, UnsafeUrlError, assertSafeUrl, safeFetch } from './safe-fetch';
export type { SafeFetchOptions, SafeFetchResult } from './safe-fetch';
export {
  credibilityScore,
  domainOf,
  freshnessScore,
  sourceDiversityScore,
  velocityScore,
} from './signals';
export { extractClaims, splitSentences } from './claims';
export type { HeuristicClaim, HeuristicClaimType } from './claims';
export { PIPELINE_VERSION, executeResearchRun } from './executor';
export type { ExecuteRunInput, PipelineDeps, RunOutcome } from './executor';
export { executeReembed } from './reembed';
export type { ReembedDeps, ReembedInput, ReembedOutcome } from './reembed';
export { RobotsGateway, isPathAllowed, parseRobots, ROBOTS_USER_AGENT } from './robots';
export type { RobotsDecision, RobotsRules, RobotsVerdict } from './robots';
export { FetchScheduler } from './fetch-scheduler';
export {
  DEFAULT_FRESHNESS_DECAY,
  SNIPPET_ONLY_CONFIDENCE_FACTOR,
  diversityWeightFor,
  evaluateDomain,
  evaluateEligibility,
  evaluateFreshness,
} from './quality';
export type {
  DomainPolicyEntry,
  DomainStance,
  DomainVerdict,
  EligibilityVerdict,
  FreshnessDecayConfig,
  FreshnessResult,
  StalenessStatus,
} from './quality';
