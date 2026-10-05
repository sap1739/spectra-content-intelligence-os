import { z } from 'zod';

import { isoDateTimeSchema, uuidSchema } from './common';
import { funnelStageSchema } from './strategy';
import { socialPlatformSchema } from './social';

/**
 * Campaign orchestration contracts (Phase 7D, ADR-0043).
 *
 * One run walks research → trends → strategy → plan → calendar → content, and
 * every artifact it produces carries the evidence it came from. Two rules shape
 * the file:
 *
 *  1. **Nothing is generated without grounding.** Every planned item resolves
 *     to real findings, citations and claims; what the evidence cannot support
 *     is blocked, and what it supports only thinly is flagged, never quietly
 *     written as fact.
 *  2. **A run reports what it actually did.** Stages succeed, fail or are
 *     skipped individually; a partial run says which items exist and which did
 *     not, with reasons — it never reports a campaign that was not built.
 */

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

export const ORCHESTRATION_STAGES = [
  'RESOLVE_INPUTS',
  'SELECT_TRENDS',
  'BUILD_STRATEGY',
  'BUILD_PLAN',
  'BUILD_CALENDAR',
  'CREATE_ITEMS',
  'GENERATE_DRAFTS',
  'ROUTE_FOR_REVIEW',
] as const;
export const orchestrationStageSchema = z.enum(ORCHESTRATION_STAGES);
export type OrchestrationStage = z.infer<typeof orchestrationStageSchema>;

export const ORCHESTRATION_STATUSES = [
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  /** Some items were produced and some were not — both are listed. */
  'PARTIAL',
  'FAILED',
  'CANCELLED',
] as const;
export const orchestrationStatusSchema = z.enum(ORCHESTRATION_STATUSES);
export type OrchestrationStatus = z.infer<typeof orchestrationStatusSchema>;

/** Why a run, a stage or an item did not complete. Never absent on a failure. */
export const ORCHESTRATION_FAILURE_REASONS = [
  /** The vertical or research project is gone, or has no usable research. */
  'INPUTS_UNAVAILABLE',
  /** No trend met the selection bar, so there is nothing to build a campaign on. */
  'NO_TRENDS_SELECTED',
  /** No evidence pack backs any selected trend. */
  'NO_EVIDENCE',
  /** Every planned item was blocked by the evidence gate. */
  'ALL_ITEMS_BLOCKED',
  /** No text-generation provider is configured in this deployment. */
  'GENERATION_NOT_CONFIGURED',
  /** The provider was configured but refused or errored for every item. */
  'GENERATION_FAILED',
  'BUDGET_REFUSED',
  'CANCELLED',
  'TIMEOUT',
  'WORKER_LOST',
  'INTERNAL_ERROR',
] as const;
export const orchestrationFailureReasonSchema = z.enum(ORCHESTRATION_FAILURE_REASONS);
export type OrchestrationFailureReason = z.infer<typeof orchestrationFailureReasonSchema>;

export const ORCHESTRATION_FAILURE_REASON_TEXT: Record<OrchestrationFailureReason, string> = {
  INPUTS_UNAVAILABLE:
    'The vertical or research project this campaign starts from is unavailable, or has no research to build on.',
  NO_TRENDS_SELECTED:
    'No trend met the selection bar. Run research and scoring first, or lower the minimum score.',
  NO_EVIDENCE:
    'No evidence pack backs the selected trends, so nothing could be grounded. Build evidence packs first.',
  ALL_ITEMS_BLOCKED:
    'Every planned item was blocked by the evidence gate. The research does not yet support a campaign on these topics.',
  GENERATION_NOT_CONFIGURED:
    'No text-generation provider is configured in this deployment, so drafts could not be written. The plan, calendar and evidence links were still produced.',
  GENERATION_FAILED: 'The text-generation provider failed for every item.',
  BUDGET_REFUSED: 'The workspace budget refused this campaign before anything was generated.',
  CANCELLED: 'The run was cancelled.',
  TIMEOUT: 'The run took longer than its time limit and was stopped.',
  WORKER_LOST: 'The worker stopped before the run finished.',
  INTERNAL_ERROR: 'The run failed for an unexpected reason.',
};

// ---------------------------------------------------------------------------
// The evidence gate
// ---------------------------------------------------------------------------

/**
 * How well the research supports one planned item. The verdict decides whether
 * it is written at all, and how carefully.
 */
export const EVIDENCE_VERDICTS = [
  /** Corroborated by independent, fully-retrieved sources. */
  'SUPPORTED',
  /** Real evidence, but thin — one source, or low confidence. Hedge required. */
  'LIMITED',
  /** Backed only by search snippets, never by a page Spectra actually read. */
  'SNIPPET_ONLY',
  /** The newest supporting source is older than the topic's tolerance. */
  'STALE',
  /** Sources disagree. Caution is mandatory and the disagreement is surfaced. */
  'CONTRADICTED',
  /** Nothing usable backs it. Not written. */
  'UNSUPPORTED',
] as const;
export const evidenceVerdictSchema = z.enum(EVIDENCE_VERDICTS);
export type EvidenceVerdict = z.infer<typeof evidenceVerdictSchema>;

export const EVIDENCE_ACTIONS = ['ALLOW', 'ALLOW_WITH_CAUTION', 'BLOCK'] as const;
export const evidenceActionSchema = z.enum(EVIDENCE_ACTIONS);
export type EvidenceAction = z.infer<typeof evidenceActionSchema>;

/** What each verdict means for generation. The mapping is fixed, not advisory. */
export const EVIDENCE_VERDICT_ACTION: Record<EvidenceVerdict, EvidenceAction> = {
  SUPPORTED: 'ALLOW',
  LIMITED: 'ALLOW_WITH_CAUTION',
  SNIPPET_ONLY: 'ALLOW_WITH_CAUTION',
  STALE: 'ALLOW_WITH_CAUTION',
  CONTRADICTED: 'ALLOW_WITH_CAUTION',
  UNSUPPORTED: 'BLOCK',
};

export const EVIDENCE_VERDICT_TEXT: Record<EvidenceVerdict, string> = {
  SUPPORTED: 'Corroborated by independent sources Spectra retrieved in full.',
  LIMITED:
    'Supported, but thinly — too few independent sources to state this as settled. The draft must hedge.',
  SNIPPET_ONLY:
    'Backed only by search snippets; no source page was retrieved in full. Treated as weaker evidence and marked as such.',
  STALE:
    'The newest supporting source is older than this topic tolerates. The draft must date its claims.',
  CONTRADICTED:
    'Sources disagree on this topic. The draft must present the disagreement rather than pick a side.',
  UNSUPPORTED: 'Nothing usable backs this topic, so no draft was written for it.',
};

export const evidenceAssessmentSchema = z.object({
  verdict: evidenceVerdictSchema,
  action: evidenceActionSchema,
  reason: z.string().min(1),
  evidencePackId: uuidSchema.nullish(),
  findingIds: z.array(uuidSchema).default([]),
  citationIds: z.array(uuidSchema).default([]),
  claimIds: z.array(uuidSchema).default([]),
  /** Independent sources behind the strongest claim. */
  independentSourceCount: z.number().int().nonnegative().default(0),
  /** True when every supporting source is snippet-only. */
  snippetOnly: z.boolean().default(false),
  /** Age of the newest supporting source, in days. */
  newestSourceAgeDays: z.number().int().nonnegative().nullable().default(null),
  contradictionCount: z.number().int().nonnegative().default(0),
});
export type EvidenceAssessment = z.infer<typeof evidenceAssessmentSchema>;

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

export const strategyObjectiveSchema = z.object({
  key: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  funnelStage: funnelStageSchema,
  rationale: z.string().min(1).max(1000),
  /** The trends that justify this objective. Never empty. */
  trendCandidateIds: z.array(uuidSchema).min(1),
});
export type StrategyObjective = z.infer<typeof strategyObjectiveSchema>;

export const strategyPillarSchema = z.object({
  key: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  description: z.string().max(1000),
  keywords: z.array(z.string().max(100)).max(20).default([]),
  trendCandidateIds: z.array(uuidSchema).default([]),
});
export type StrategyPillar = z.infer<typeof strategyPillarSchema>;

export const strategyPersonaSchema = z.object({
  key: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  description: z.string().max(2000),
  /**
   * Where this persona came from. `VERTICAL` means it was configured by the
   * operator; `DERIVED` means Spectra inferred it from the vertical's own
   * audience fields. Nothing is invented from nothing.
   */
  source: z.enum(['WORKSPACE', 'VERTICAL', 'DERIVED']),
  painPoints: z.array(z.string().max(300)).max(10).default([]),
  preferredPlatforms: z.array(socialPlatformSchema).default([]),
});
export type StrategyPersona = z.infer<typeof strategyPersonaSchema>;

export const platformStrategySchema = z.object({
  platform: socialPlatformSchema,
  /** Posts to plan for this platform across the campaign window. */
  plannedItems: z.number().int().nonnegative(),
  rationale: z.string().min(1).max(500),
  /** True when Spectra cannot actually publish here — stated, not hidden. */
  publishingAvailable: z.boolean(),
  publishingNote: z.string().max(500).nullable(),
});
export type PlatformStrategy = z.infer<typeof platformStrategySchema>;

export const topicIdeaDraftSchema = z.object({
  key: z.string().min(1).max(64),
  title: z.string().min(1).max(300),
  angle: z.string().max(1000),
  pillarKey: z.string().max(64).nullable(),
  funnelStage: funnelStageSchema,
  trendCandidateId: uuidSchema.nullable(),
  /** The topic key of the evidence pack backing it, when one exists. */
  topicKey: z.string().max(300).nullable(),
  evidence: evidenceAssessmentSchema,
});
export type TopicIdeaDraft = z.infer<typeof topicIdeaDraftSchema>;

export const ctaSuggestionSchema = z.object({
  funnelStage: funnelStageSchema,
  text: z.string().min(1).max(300),
  rationale: z.string().max(500),
});
export type CtaSuggestion = z.infer<typeof ctaSuggestionSchema>;

/**
 * The strategy document one orchestration run produces. Distinct from the
 * stored `CampaignStrategy` record in `strategy.ts`: this is the derived
 * artifact, versioned by the engine that built it.
 */
export const generatedCampaignStrategySchema = z.object({
  schemaVersion: z.literal(1).default(1),
  /** The engine that produced this, so a later change is traceable. */
  engineVersion: z.string().min(1),
  objectives: z.array(strategyObjectiveSchema),
  pillars: z.array(strategyPillarSchema),
  personas: z.array(strategyPersonaSchema),
  funnelCoverage: z.array(
    z.object({ stage: funnelStageSchema, plannedItems: z.number().int().nonnegative() }),
  ),
  topicIdeas: z.array(topicIdeaDraftSchema),
  platforms: z.array(platformStrategySchema),
  ctaSuggestions: z.array(ctaSuggestionSchema),
  /** What the engine could not do, and why. */
  warnings: z.array(z.string().max(500)).default([]),
});
export type GeneratedCampaignStrategy = z.infer<typeof generatedCampaignStrategySchema>;

// ---------------------------------------------------------------------------
// Plan and calendar
// ---------------------------------------------------------------------------

export const plannedItemSchema = z.object({
  key: z.string().min(1).max(64),
  title: z.string().min(1).max(300),
  topicKey: z.string().max(300).nullable(),
  platform: socialPlatformSchema,
  funnelStage: funnelStageSchema,
  pillarKey: z.string().max(64).nullable(),
  /** When this would post, in UTC. */
  scheduledAt: isoDateTimeSchema,
  evidence: evidenceAssessmentSchema,
  trendCandidateId: uuidSchema.nullable(),
  /** The CTA chosen for this item's funnel stage. */
  cta: z.string().max(300).nullable(),
});
export type PlannedItem = z.infer<typeof plannedItemSchema>;

export const campaignPlanSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  startAt: isoDateTimeSchema,
  endAt: isoDateTimeSchema,
  timezone: z.string().min(1).max(64).default('UTC'),
  items: z.array(plannedItemSchema),
  /** Items the evidence gate refused, with the reason. Kept, never hidden. */
  blocked: z.array(
    z.object({
      title: z.string().max(300),
      topicKey: z.string().max(300).nullable(),
      evidence: evidenceAssessmentSchema,
    }),
  ),
});
export type CampaignPlan = z.infer<typeof campaignPlanSchema>;

// ---------------------------------------------------------------------------
// Run results
// ---------------------------------------------------------------------------

export const ORCHESTRATION_ITEM_OUTCOMES = [
  'CREATED',
  'DRAFTED',
  'BLOCKED',
  'GENERATION_UNAVAILABLE',
  'GENERATION_FAILED',
] as const;
export const orchestrationItemOutcomeSchema = z.enum(ORCHESTRATION_ITEM_OUTCOMES);
export type OrchestrationItemOutcome = z.infer<typeof orchestrationItemOutcomeSchema>;

export const orchestrationItemResultSchema = z.object({
  key: z.string().max(64),
  title: z.string().max(300),
  outcome: orchestrationItemOutcomeSchema,
  contentItemId: uuidSchema.nullable(),
  scheduleEntryId: uuidSchema.nullable(),
  platform: socialPlatformSchema,
  evidence: evidenceAssessmentSchema,
  /** Present when the item did not reach a draft. */
  note: z.string().max(500).nullable(),
});
export type OrchestrationItemResult = z.infer<typeof orchestrationItemResultSchema>;

export const stageResultSchema = z.object({
  stage: orchestrationStageSchema,
  status: z.enum(['PENDING', 'RUNNING', 'SUCCEEDED', 'SKIPPED', 'FAILED']),
  note: z.string().max(500).nullable(),
  startedAt: isoDateTimeSchema.nullable(),
  finishedAt: isoDateTimeSchema.nullable(),
});
export type StageResult = z.infer<typeof stageResultSchema>;

// ---------------------------------------------------------------------------
// API inputs
// ---------------------------------------------------------------------------

export const startOrchestrationInputSchema = z
  .object({
    name: z.string().min(1).max(200),
    /** Exactly one of these is the campaign's starting point. */
    verticalId: uuidSchema.nullish(),
    researchProjectId: uuidSchema.nullish(),
    brandId: uuidSchema.nullish(),
    /** Explicit trend selection; omitted means "pick by score". */
    trendCandidateIds: z.array(uuidSchema).max(25).default([]),
    /** Minimum normalized score for automatic selection. */
    minTrendScore: z.number().min(0).max(1).default(0.5),
    maxTrends: z.number().int().min(1).max(25).default(5),
    /** Items to plan per selected trend. */
    itemsPerTrend: z.number().int().min(1).max(10).default(2),
    platforms: z.array(socialPlatformSchema).min(1).max(8),
    startAt: isoDateTimeSchema,
    durationDays: z.number().int().min(1).max(180).default(14),
    timezone: z.string().min(1).max(64).default('UTC'),
    /** Generate drafts, or stop after the plan and calendar. */
    generateDrafts: z.boolean().default(true),
    /** Create schedule entries for approved items automatically. */
    scheduleApproved: z.boolean().default(false),
  })
  .superRefine((input, ctx) => {
    if (!input.verticalId && !input.researchProjectId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verticalId'],
        message: 'A campaign starts from a custom vertical or a research project — name one.',
      });
    }
  });
export type StartOrchestrationInput = z.infer<typeof startOrchestrationInputSchema>;
