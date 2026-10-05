import {
  EVIDENCE_VERDICT_ACTION,
  EVIDENCE_VERDICT_TEXT,
  type EvidenceAssessment,
  type EvidenceVerdict,
} from '@spectra/contracts';

/**
 * The evidence gate.
 *
 * Decides, for one planned item, whether the research supports writing it —
 * and if so, how carefully. This is the single place that answer is produced,
 * so the planner, the generator and the UI all agree.
 *
 * The bias is deliberate: **thin evidence is never silently upgraded.** A topic
 * with nothing behind it is blocked rather than written with a hedge, because a
 * hedge still asserts the subject is worth discussing.
 */

/** One source behind a topic, reduced to what the gate needs to judge it. */
export interface GateSource {
  /** True when the source page was never retrieved — a search snippet only. */
  snippetOnly: boolean;
  /** When the source was published, if known. */
  publishedAt: Date | null;
  /** Distinct publisher/domain, used to count independence. */
  publisher: string | null;
  /** False when the source is blocked, quarantined or a duplicate (ADR-0030). */
  evidenceEligible: boolean;
}

export interface GateInput {
  evidencePackId: string | null;
  findingIds: readonly string[];
  citationIds: readonly string[];
  claimIds: readonly string[];
  sources: readonly GateSource[];
  /** Contradictions already detected for this topic's claims (ADR-0032). */
  contradictionCount: number;
  /**
   * Strongest confidence among the topic's verified claims. UNKNOWN when no
   * claim was verified — which is weaker than LOW, not equal to it.
   */
  strongestConfidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'CONTESTED' | 'UNKNOWN';
  now?: Date;
  options?: GateOptions;
}

export interface GateOptions {
  /** Independent publishers needed before a topic counts as corroborated. */
  minIndependentSources?: number;
  /** Older than this, the newest supporting source makes the topic stale. */
  staleAfterDays?: number;
}

const DEFAULTS: Required<GateOptions> = {
  minIndependentSources: 2,
  staleAfterDays: 180,
};

function ageInDays(published: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - published.getTime()) / 86_400_000));
}

/**
 * Judges one topic. Returns the verdict, the action it implies, and the numbers
 * the verdict rests on — so a reviewer can check the reasoning, not just the
 * label.
 */
export function assessEvidence(input: GateInput): EvidenceAssessment {
  const now = input.now ?? new Date();
  const options = { ...DEFAULTS, ...input.options };

  // Ineligible sources are not evidence at all: a blocked domain or a
  // quarantined page cannot support anything (ADR-0030).
  const usable = input.sources.filter((source) => source.evidenceEligible);
  const publishers = new Set(
    usable.map((source) => source.publisher?.trim().toLowerCase()).filter(Boolean) as string[],
  );
  const independentSourceCount = publishers.size;
  const snippetOnly = usable.length > 0 && usable.every((source) => source.snippetOnly);
  const dated = usable
    .map((source) => source.publishedAt)
    .filter((date): date is Date => date instanceof Date);
  const newestSourceAgeDays = dated.length
    ? Math.min(...dated.map((date) => ageInDays(date, now)))
    : null;

  const base = {
    evidencePackId: input.evidencePackId,
    findingIds: [...input.findingIds],
    citationIds: [...input.citationIds],
    claimIds: [...input.claimIds],
    independentSourceCount,
    snippetOnly,
    newestSourceAgeDays,
    contradictionCount: input.contradictionCount,
  };

  const decide = (verdict: EvidenceVerdict, reason?: string): EvidenceAssessment => ({
    ...base,
    verdict,
    action: EVIDENCE_VERDICT_ACTION[verdict],
    reason: reason ?? EVIDENCE_VERDICT_TEXT[verdict],
  });

  // Nothing usable behind it: not written. Checked first, because every later
  // test would otherwise be reasoning about an empty set.
  if (usable.length === 0 || (input.findingIds.length === 0 && input.citationIds.length === 0)) {
    return decide(
      'UNSUPPORTED',
      usable.length === 0 && input.sources.length > 0
        ? 'Every source behind this topic is ineligible as evidence, so nothing supports it.'
        : EVIDENCE_VERDICT_TEXT.UNSUPPORTED,
    );
  }

  // Disagreement outranks everything else: a contradicted topic may still be
  // worth writing, but only as a disagreement.
  if (input.contradictionCount > 0 || input.strongestConfidence === 'CONTESTED') {
    return decide(
      'CONTRADICTED',
      `${input.contradictionCount || 1} contradiction${input.contradictionCount === 1 ? '' : 's'} were found among the sources for this topic. ${EVIDENCE_VERDICT_TEXT.CONTRADICTED}`,
    );
  }

  if (snippetOnly) return decide('SNIPPET_ONLY');

  if (newestSourceAgeDays !== null && newestSourceAgeDays > options.staleAfterDays) {
    return decide(
      'STALE',
      `The newest supporting source is ${newestSourceAgeDays} days old. ${EVIDENCE_VERDICT_TEXT.STALE}`,
    );
  }

  // Two different weaknesses land here, and the reason must say which: too few
  // independent sources, or sources that were never verified into a claim.
  const tooFewSources = independentSourceCount < options.minIndependentSources;
  const unverified = input.strongestConfidence === 'LOW' || input.strongestConfidence === 'UNKNOWN';
  if (tooFewSources || unverified) {
    const cause = tooFewSources
      ? `${independentSourceCount} independent source${independentSourceCount === 1 ? '' : 's'} back this topic.`
      : input.strongestConfidence === 'UNKNOWN'
        ? `${independentSourceCount} independent sources back this topic, but none of its claims has been verified.`
        : `${independentSourceCount} independent sources back this topic, but its strongest claim is only low-confidence.`;
    return decide('LIMITED', `${cause} ${EVIDENCE_VERDICT_TEXT.LIMITED}`);
  }

  return decide(
    'SUPPORTED',
    `${independentSourceCount} independent sources back this topic. ${EVIDENCE_VERDICT_TEXT.SUPPORTED}`,
  );
}

/** True when the gate permits a draft to be written at all. */
export function isWritable(assessment: EvidenceAssessment): boolean {
  return assessment.action !== 'BLOCK';
}

/**
 * The guidance a cautioned item must carry into generation. Returned as trusted
 * operator-side instruction, never mixed with retrieved content.
 */
export function cautionGuidance(assessment: EvidenceAssessment): string | null {
  switch (assessment.verdict) {
    case 'LIMITED':
      return `Evidence for this topic is thin — ${assessment.independentSourceCount} independent source(s). State findings as preliminary and attribute them; do not present them as settled or consensus.`;
    case 'SNIPPET_ONLY':
      return 'Every source for this topic is a search snippet rather than a page that was read in full. Attribute claims to the snippet and avoid detail the snippet does not contain.';
    case 'STALE':
      return `The newest supporting source is ${assessment.newestSourceAgeDays} days old. Date every claim explicitly and note that newer information may exist.`;
    case 'CONTRADICTED':
      return 'Sources disagree on this topic. Present the disagreement and attribute each position; do not resolve it.';
    default:
      return null;
  }
}
