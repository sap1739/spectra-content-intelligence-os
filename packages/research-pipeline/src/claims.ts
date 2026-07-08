import { titleKey } from './hashing';

/**
 * Heuristic claim extraction (ADR-0016): deterministic, marker-based sentence
 * selection. Statistics (numbers/percentages/amounts) rank above predictions,
 * which rank above announcement-style facts.
 *
 * HONEST LIMITS: this finds claim-shaped sentences; it does not understand
 * them. LLM-based extraction/verification replaces this in Phase 3 behind the
 * same data model (ExtractedClaim rows + corroboration by distinct sources).
 */

export type HeuristicClaimType = 'STATISTIC' | 'PREDICTION' | 'FACTUAL';

export interface HeuristicClaim {
  text: string;
  normalizedKey: string;
  claimType: HeuristicClaimType;
}

const STATISTIC_PATTERN =
  /\d+(?:\.\d+)?\s*(?:%|percent(?:age)?|million|billion|trillion|crore|lakh|x\b|times\b)|[$₹€£]\s?\d/i;
const PREDICTION_PATTERN =
  /\b(?:will|expects?|expected|predicts?|forecasts?|projected|plans? to|aims? to|by 20\d\d)\b/i;
const FACTUAL_PATTERN =
  /\b(?:announced?|launch(?:ed|es)?|released?|acquired?|acquires?|partner(?:ed|s|ship)?|reported?|introduc(?:ed|es)|unveil(?:ed|s)?|raised?|grew|reached|surpassed|adopt(?:ed|s)?)\b/i;

const MIN_SENTENCE_CHARS = 40;
const MAX_SENTENCE_CHARS = 300;
const MIN_KEY_CHARS = 20;

export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function classify(sentence: string): HeuristicClaimType | null {
  if (STATISTIC_PATTERN.test(sentence)) return 'STATISTIC';
  if (PREDICTION_PATTERN.test(sentence)) return 'PREDICTION';
  if (FACTUAL_PATTERN.test(sentence)) return 'FACTUAL';
  return null;
}

const TYPE_PRIORITY: Record<HeuristicClaimType, number> = {
  STATISTIC: 0,
  PREDICTION: 1,
  FACTUAL: 2,
};

export function extractClaims(text: string, max = 3): HeuristicClaim[] {
  const seen = new Set<string>();
  const claims: HeuristicClaim[] = [];

  for (const sentence of splitSentences(text)) {
    if (sentence.length < MIN_SENTENCE_CHARS || sentence.length > MAX_SENTENCE_CHARS) continue;
    const claimType = classify(sentence);
    if (!claimType) continue;
    const normalizedKey = titleKey(sentence).slice(0, 160);
    if (normalizedKey.length < MIN_KEY_CHARS || seen.has(normalizedKey)) continue;
    seen.add(normalizedKey);
    claims.push({ text: sentence, normalizedKey, claimType });
  }

  return claims
    .sort((a, b) => TYPE_PRIORITY[a.claimType] - TYPE_PRIORITY[b.claimType])
    .slice(0, max);
}
