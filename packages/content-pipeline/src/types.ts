import type { GenerationUsage, ModelRef } from '@spectra/ai-core';
import type { ContentType, FunnelStage, TenantScope } from '@spectra/contracts';

/** A citation from an evidence pack, supplied to the model as grounding. */
export interface GroundingCitation {
  id: string;
  /** The exact quoted text backing a claim (never paraphrased into a source). */
  quote: string;
  sourceTitle: string | null;
  sourceUrl: string;
  findingId: string | null;
}

/** A validated research finding, supplied to the model as grounding. */
export interface GroundingFinding {
  id: string;
  summary: string;
  excerpt: string | null;
  sourceTitle: string | null;
  sourceUrl: string;
}

/** The evidence a draft is grounded on — drawn from a living evidence pack. */
export interface DraftEvidence {
  packId: string | null;
  packTitle: string;
  packSummary?: string | null;
  findings: GroundingFinding[];
  citations: GroundingCitation[];
}

export interface DraftGenerationInput {
  tenant: TenantScope;
  contentType: ContentType;
  title: string;
  /** The user's objective for this piece, in their own words (trusted). */
  objective?: string | null;
  /** Brand voice guidance (tone, do-nots) — trusted, from the brand record. */
  brandVoice?: string | null;
  /** Target platform label for format hints (e.g. LINKEDIN). */
  targetPlatform?: string | null;
  funnelStage?: FunnelStage | null;
  /** Extra trusted guidance from the operator. */
  additionalGuidance?: string | null;
  evidence: DraftEvidence;
  maxOutputTokens?: number;
}

export interface DraftGenerationResult {
  body: string;
  modelRef: ModelRef;
  usage?: GenerationUsage;
  finishReason: 'stop' | 'length' | 'content_filter' | 'error';
  promptTemplateId: string;
  promptVersion: string;
  /** Exactly the citation ids supplied to the model as grounding. */
  groundedCitationIds: string[];
  /** Exactly the finding ids supplied to the model as grounding. */
  groundedFindingIds: string[];
  /** 1-indexed source order the `[n]` markers map to (findings then citations). */
  groundedSourceOrder: string[];
}
